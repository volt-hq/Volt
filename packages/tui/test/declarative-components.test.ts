import assert from "node:assert";
import { describe, it } from "node:test";
import type { ActionItem } from "../src/components/action-bar.ts";
import { Card, type CardSection } from "../src/components/card.ts";
import { Form, type FormField } from "../src/components/form.ts";
import { ProgressBar } from "../src/components/progress.ts";
import { TerminalOutput } from "../src/components/terminal-output.ts";
import { ViewReconciler, ViewRegistry } from "../src/reconciler.ts";
import { PLAIN_SEMANTIC_THEME, type SemanticTheme } from "../src/styled-text.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { KEYS } from "./semantic-test-theme.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

type Node =
	| {
			type: "card";
			key?: string;
			title: string;
			sections: ReadonlyArray<{ title?: string; children: readonly Node[] }>;
			actions?: readonly ActionItem[];
	  }
	| { type: "terminal"; key?: string; lines: readonly string[] }
	| { type: "progress"; key?: string; value: number }
	| { type: "form"; key?: string; fields: readonly FormField[] };

function createRegistry(theme: SemanticTheme, events: string[] = []): ViewRegistry<Node> {
	const registry = new ViewRegistry<Node>();
	registry.register("card", {
		create: (node) => {
			const card = new Card(theme, { title: node.title });
			card.onAction = (id) => events.push(`action:${id}`);
			return card;
		},
		update: () => {},
		children: (node) => node.sections.flatMap((section) => section.children),
		mount: (card, children, node) => {
			let offset = 0;
			const sections = node.sections.map((section): CardSection => {
				const mounted = children.slice(offset, offset + section.children.length);
				offset += section.children.length;
				return section.title === undefined ? { children: mounted } : { title: section.title, children: mounted };
			});
			card.setProps({
				title: node.title,
				sections,
				...(node.actions === undefined ? {} : { actions: node.actions }),
			});
		},
	});
	registry.register("terminal", {
		create: (node) => new TerminalOutput(theme, { lines: node.lines }),
		update: (output, node) => output.setProps({ lines: node.lines }),
	});
	registry.register("progress", {
		create: (node) => new ProgressBar(theme, { value: node.value, showPercent: false }),
		update: (bar, node) => bar.setProps({ value: node.value, showPercent: false }),
	});
	registry.register("form", {
		create: (node) => {
			const form = new Form(theme, { fields: node.fields });
			form.onSubmit = (values) => events.push(`submit:${JSON.stringify(values)}`);
			return form;
		},
		update: (form, node) => form.setProps({ fields: node.fields }),
	});
	return registry;
}

function jobCard(lines: readonly string[], progress: number): Node {
	return {
		type: "card",
		key: "job",
		title: "Build",
		sections: [
			{ children: [{ type: "progress", key: "progress", value: progress }] },
			{ title: "Output", children: [{ type: "terminal", key: "out", lines }] },
		],
		actions: [{ id: "stop", label: "Stop" }],
	};
}

describe("declarative components", () => {
	it("append streamed output inside a retained card", () => {
		const styled: string[] = [];
		const theme: SemanticTheme = {
			...PLAIN_SEMANTIC_THEME,
			text: (text) => {
				styled.push(text);
				return text;
			},
		};
		const view = new ViewReconciler(createRegistry(theme));
		const lines = ["compiling a"];
		view.update([jobCard(lines, 0.25)]);
		const card = view.getComponent(["job"]);
		const output = view.getComponent(["job", "out"]);
		view.render(30);
		styled.length = 0;

		view.update([jobCard([...lines, "compiling b"], 0.5)]);

		assert.strictEqual(view.getComponent(["job"]), card);
		assert.strictEqual(view.getComponent(["job", "out"]), output);
		const rendered = view.render(30).lines;
		assert.ok(styled.includes("compiling b"));
		assert.ok(!styled.includes("compiling a"));
		assert.deepStrictEqual(rendered.slice(4, 6), [
			"│ compiling a                │",
			"│ compiling b                │",
		]);
		assert.strictEqual(rendered[1], "│ █████████████░░░░░░░░░░░░░ │");
	});

	it("routes focus and actions through reconciled cards and forms", () => {
		const events: string[] = [];
		const view = new ViewReconciler(createRegistry(PLAIN_SEMANTIC_THEME, events));
		const node = (value?: string): Node => ({
			type: "card",
			key: "ask",
			title: "Question",
			sections: [
				{
					children: [
						{
							type: "form",
							key: "form",
							fields: [
								{ kind: "string", id: "answer", label: "Answer", ...(value === undefined ? {} : { value }) },
							],
						},
					],
				},
			],
			actions: [{ id: "dismiss", label: "Dismiss" }],
		});
		view.update([node()]);
		const card = view.getComponent(["ask"]) as Card;
		card.focused = true;
		card.handleInput("4");
		card.handleInput("2");
		view.update([node()]);
		card.handleInput(KEYS.enter);
		card.handleInput(KEYS.tab);
		card.handleInput(KEYS.tab);
		card.handleInput(KEYS.enter);

		assert.deepStrictEqual(events, ['submit:{"answer":"42"}', "action:dismiss"]);
	});

	for (const mode of ["main", "alt"] as const) {
		it(`render in the ${mode} screen`, async () => {
			const terminal = new VirtualTerminal(30, 10);
			const tui = mode === "main" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
			const view = new ViewReconciler(createRegistry(PLAIN_SEMANTIC_THEME));
			view.update([jobCard(["step 1"], 1)]);
			tui.addChild(view);
			tui.start();
			await terminal.waitForRender();
			view.update([jobCard(["step 1", "step 2"], 1)]);
			tui.requestRender();
			await terminal.waitForRender();

			const viewport = terminal.getViewport();
			const top = viewport.findIndex((line) => line.startsWith("╭─ Build"));
			assert.notStrictEqual(top, -1, viewport.join("\n"));
			assert.deepStrictEqual(viewport.slice(top + 4, top + 6), [
				"│ step 1                     │",
				"│ step 2                     │",
			]);
			tui.stop();
		});
	}
});
