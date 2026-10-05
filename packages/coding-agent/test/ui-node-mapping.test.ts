/**
 * The TUI's `UiNode` mapping: every node type renders as a retained
 * component, keyed updates keep component state, actions and forms send
 * their intents, extension panels follow the screen mode, and the generic
 * tool card renders a presentation in its chrome.
 */

import type { UiNode, UiNodeIntent } from "@hansjm10/volt-protocol";
import {
	type Card,
	type Component,
	type Form,
	getKeybindings,
	resetCapabilitiesCache,
	setCapabilities,
	setKeybindings,
	type TreeView,
	type TuiMode,
	visibleWidth,
} from "@hansjm10/volt-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { LOCAL_INTENT_PROFILE } from "../src/core/protocol/intents/index.ts";
import { initTheme } from "../src/core/theme/runtime.ts";
import {
	createRegistryIntentSink,
	formSubmitIntent,
	type UiIntentSink,
} from "../src/modes/interactive/ui-node/intents.ts";
import { panelSlot, UiPanels } from "../src/modes/interactive/ui-node/panels.ts";
import { createUiNodeView } from "../src/modes/interactive/ui-node/registry.ts";
import { ToolCard, type ToolCardProps } from "../src/modes/interactive/ui-node/tool-card.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const ENTER = "\r";
const RIGHT = "\x1b[C";

const previousBindings = getKeybindings();
const disposals: Array<() => void> = [];

beforeEach(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
	setCapabilities({ images: null, trueColor: true, hyperlinks: false });
});
afterEach(() => {
	for (const dispose of disposals.splice(0)) dispose();
	setKeybindings(previousBindings);
	resetCapabilitiesCache();
});

function lines(component: Component, width: number): string[] {
	const rendered = component.render(width).lines;
	for (const line of rendered) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	return rendered.map((line) => stripAnsi(line).trimEnd());
}

function text(component: Component, width = 60): string {
	return lines(component, width).join("\n");
}

class RecordingSink implements UiIntentSink {
	readonly sent: UiNodeIntent[] = [];
	send(intent: UiNodeIntent): void {
		this.sent.push(intent);
	}
}

function view(sink?: UiIntentSink) {
	const created = createUiNodeView(sink === undefined ? {} : { intents: sink });
	disposals.push(() => created.dispose());
	return created;
}

/** One node of every type. */
const ALL_NODES: UiNode[] = [
	{ type: "text", key: "text", text: [{ text: "bold", bold: true }, { text: " plain" }] },
	{ type: "markdown", key: "markdown", markdown: "# Heading\n\nSome **strong** text" },
	{
		type: "list",
		key: "list",
		ordered: true,
		items: [
			{ type: "text", text: "first" },
			{ type: "text", text: "second" },
		],
	},
	{
		type: "table",
		key: "table",
		columns: [{ header: "Name" }, { header: "Count", align: "right" }],
		rows: [{ cells: ["alpha", "3"] }, { cells: [[{ text: "beta", token: "error" }], "12"] }],
	},
	{ type: "keyValue", key: "keyValue", items: [{ label: "Tokens", value: "12 input" }] },
	{ type: "progress", key: "bar", kind: "determinate", value: 1, max: 2, label: "Half" },
	{
		type: "progress",
		key: "steps",
		kind: "steps",
		title: "Waves",
		steps: [
			{ label: "One", status: "done" },
			{ label: "Two", status: "failed", detail: "timeout" },
		],
	},
	{
		type: "form",
		key: "form",
		title: "Settings",
		fields: [
			{ kind: "string", id: "name", label: "Name", placeholder: "your name" },
			{ kind: "boolean", id: "dry", label: "Dry run", value: true },
			{ kind: "enum", id: "env", label: "Env", options: [{ value: "prod" }, { value: "dev" }], value: "dev" },
			{ kind: "integer", id: "count", label: "Count", value: 3 },
		],
		submit: { type: "extension.intent.demo.save" },
		submitLabel: "Save",
	},
	{
		type: "actions",
		key: "actions",
		actions: [
			{ id: "go", label: "Go", intent: { type: "extension.command.demo.go" } },
			{ id: "stop", label: "Stop", destructive: true, intent: { type: "extension.command.demo.stop" } },
		],
	},
	{
		type: "card",
		key: "card",
		title: "Deploy",
		token: "success",
		badges: [{ label: "live", token: "success" }],
		sections: [{ key: "status", title: "Status", children: [{ type: "text", key: "line", text: "all green" }] }],
		actions: [{ id: "retry", label: "Retry", intent: { type: "extension.intent.demo.retry" } }],
	},
	{
		type: "diff",
		key: "diff",
		path: "src/app.ts",
		lines: [
			{ kind: "hunk", text: "@@ -1 +1 @@" },
			{ kind: "remove", text: "old line", oldLine: 1 },
			{ kind: "add", text: "new line", newLine: 1 },
		],
	},
	{
		type: "terminal",
		key: "terminal",
		title: "$ npm test",
		lines: ["running", [{ text: "ok", token: "success" }]],
		omittedLines: 3,
	},
	{ type: "code", key: "code", title: "app.ts", language: "typescript", code: "const answer = 42;" },
	{ type: "image", key: "image", mimeType: "image/png", data: PNG_1X1, alt: "logo" },
	{
		type: "tree",
		key: "tree",
		items: [{ id: "src", label: "src", description: "sources", children: [{ id: "src/a.ts", label: "a.ts" }] }],
		expanded: ["src"],
	},
];

describe("UiNode mapping", () => {
	it("renders every node type within the width", () => {
		const nodeView = view();
		nodeView.update(ALL_NODES);
		const rendered = text(nodeView, 60);
		for (const expected of [
			"bold plain",
			"Heading",
			"Some strong text",
			"1. first",
			"2. second",
			"Name",
			"Count",
			"alpha",
			"beta",
			"Tokens: 12 input",
			"Half",
			"50%",
			"Waves (1/2)",
			"✗ Two  timeout",
			"Settings",
			"your name",
			"[x]",
			"dev",
			"[ Save ]",
			"[ Go ] [ Stop ]",
			"Deploy",
			"[live]",
			"Status",
			"all green",
			"[ Retry ]",
			"src/app.ts",
			"@@ -1 +1 @@",
			"- old line",
			"+ new line",
			"$ npm test",
			"… 3 earlier lines",
			"running",
			"ok",
			"app.ts",
			"const answer = 42;",
			"[Image: logo [image/png] 1x1]",
			"▾ src  sources",
			"a.ts",
		]) {
			expect(rendered).toContain(expected);
		}
		for (const width of [8, 20]) lines(nodeView, width);
	});

	it("renders images as terminal images where the terminal can", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		const nodeView = view();
		nodeView.update([{ type: "image", key: "png", mimeType: "image/png", data: PNG_1X1 }]);
		expect(nodeView.render(40).images).toHaveLength(1);
		// Kitty takes PNG data only.
		nodeView.update([{ type: "image", key: "jpeg", mimeType: "image/jpeg", data: PNG_1X1, alt: "photo" }]);
		expect(nodeView.render(40).images).toHaveLength(0);
		expect(text(nodeView, 40)).toContain("[Image: photo [image/jpeg]");
		const hidden = createUiNodeView({ showImages: false });
		disposals.push(() => hidden.dispose());
		hidden.update([{ type: "image", mimeType: "image/png", data: PNG_1X1 }]);
		expect(hidden.render(40).images).toHaveLength(0);
	});

	it("keeps retained components and their state across keyed updates", () => {
		const nodeView = view();
		nodeView.update(ALL_NODES);
		const form = nodeView.getComponent(["form"]) as Form;
		const card = nodeView.getComponent(["card"]);
		const terminal = nodeView.getComponent(["terminal"]);
		form.focused = true;
		for (const char of "Ada") form.handleInput(char);

		const next = ALL_NODES.map((node): UiNode => {
			if (node.type === "terminal") return { ...node, lines: [...node.lines, "done"] };
			if (node.type === "card") {
				return {
					...node,
					title: "Deploy 2",
					sections: [{ key: "status", children: [{ type: "text", key: "line", text: "still green" }] }],
				};
			}
			if (node.type === "form") return { ...node, submitLabel: "Apply" };
			return node;
		});
		nodeView.update(next);
		expect(nodeView.getComponent(["form"])).toBe(form);
		expect(nodeView.getComponent(["card"])).toBe(card);
		expect(nodeView.getComponent(["terminal"])).toBe(terminal);
		expect(form.getValues().name).toBe("Ada");
		const rendered = text(nodeView, 60);
		expect(rendered).toContain("done");
		expect(rendered).toContain("Deploy 2");
		expect(rendered).toContain("still green");
		expect(rendered).toContain("[ Apply ]");

		// A progress node that changes kind swaps its component in place.
		nodeView.update([{ type: "progress", key: "p", kind: "determinate", value: 1 }]);
		nodeView.update([{ type: "progress", key: "p", kind: "steps", steps: [{ label: "Only", status: "active" }] }]);
		expect(text(nodeView)).toContain("● Only");
	});

	it("sends action, card, and form intents to the sink", () => {
		const sink = new RecordingSink();
		const nodeView = view(sink);
		nodeView.update([
			...ALL_NODES.filter((node) => node.key !== "actions"),
			{
				type: "actions",
				key: "actions",
				actions: [
					{ id: "off", label: "Off", disabled: true, intent: { type: "extension.command.demo.off" } },
					{ id: "go", label: "Go", intent: { type: "extension.command.demo.go", input: { fast: true } } },
				],
			},
			{
				type: "form",
				key: "strict",
				fields: [{ kind: "string", id: "slug", label: "Slug", pattern: "[a-z]+" }],
				submit: { type: "extension.intent.demo.slug" },
				cancel: { type: "extension.intent.demo.cancel" },
			},
		]);

		const actions = nodeView.getComponent(["actions"]) as Component & { focused: boolean };
		actions.focused = true;
		actions.handleInput?.(ENTER);
		expect(sink.sent).toEqual([{ type: "extension.command.demo.go", input: { fast: true } }]);

		(nodeView.getComponent(["card"]) as Card).onAction?.("retry");
		expect(sink.sent.at(-1)).toEqual({ type: "extension.intent.demo.retry" });

		const form = nodeView.getComponent(["form"]) as Form;
		form.focused = true;
		for (const char of "Ada") form.handleInput(char);
		expect(form.submit()).toBe(true);
		expect(sink.sent.at(-1)).toEqual({
			type: "extension.intent.demo.save",
			input: { name: "Ada", dry: true, env: "dev", count: 3 },
		});

		// The whole value must match a field's pattern.
		const strict = nodeView.getComponent(["strict"]) as Form;
		strict.focused = true;
		for (const char of "abc1") strict.handleInput(char);
		const count = sink.sent.length;
		expect(strict.submit()).toBe(false);
		expect(sink.sent).toHaveLength(count);
		strict.onCancel?.();
		expect(sink.sent.at(-1)).toEqual({ type: "extension.intent.demo.cancel" });

		// A tree takes keyboard input once focused.
		const tree = nodeView.getComponent(["tree"]) as TreeView;
		tree.handleInput(RIGHT);
		expect(tree.getSelectedId()).toBe("src/a.ts");
	});

	it("merges form values over the submit input and reports registry rejections", async () => {
		expect(
			formSubmitIntent({ type: "save", input: { id: 7, name: "old" } }, { name: "new", note: undefined }),
		).toEqual({
			type: "save",
			input: { id: 7, name: "new" },
		});
		const errors: string[] = [];
		const sink = createRegistryIntentSink({
			context: () => ({ services: {}, profile: LOCAL_INTENT_PROFILE }),
			onError: (message) => errors.push(message),
		});
		sink.send({ type: "extension.command.nobody.nothing" });
		await vi.waitFor(() => expect(errors).toEqual(["Unknown intent: extension.command.nobody.nothing"]));
		const throwing = createRegistryIntentSink({
			context: () => {
				throw new Error("no conversation");
			},
			onError: (message) => errors.push(message),
		});
		throwing.send({ type: "new_session" });
		expect(errors.at(-1)).toBe("no conversation");
	});
});

describe("extension panels", () => {
	it("places sidebar panels above the editor outside fullscreen mode", () => {
		expect(panelSlot("sidebar", "regular")).toBe("aboveEditor");
		expect(panelSlot("sidebar", "fullscreen")).toBe("sidebar");
		expect(panelSlot("belowEditor", "regular")).toBe("belowEditor");
		expect(panelSlot("aboveEditor", "fullscreen")).toBe("aboveEditor");

		let mode: TuiMode = "regular";
		const panels = new UiPanels({ mode: () => mode });
		disposals.push(() => panels.clear());
		panels.set("deploy/status", { title: "Deploy", placement: "aboveEditor", node: { type: "text", text: "green" } });
		panels.set("deploy/log", {
			placement: "sidebar",
			node: { type: "terminal", key: "log", lines: ["one", "two"] },
		});
		panels.set("deploy/help", { placement: "belowEditor", node: { type: "markdown", markdown: "Press **go**" } });
		expect(text(panels.aboveEditor)).toBe("Deploy\ngreen\none\ntwo");
		expect(text(panels.belowEditor)).toBe("Press go");
		expect(text(panels.sidebar)).toBe("");

		mode = "fullscreen";
		expect(text(panels.aboveEditor)).toBe("Deploy\ngreen");
		expect(text(panels.sidebar)).toBe("one\ntwo");
	});

	it("updates panels in place, bounds their rows, and removes them", () => {
		const panels = new UiPanels({ mode: () => "regular", maxRows: 4 });
		disposals.push(() => panels.clear());
		panels.set("a", { placement: "aboveEditor", node: { type: "terminal", key: "out", lines: ["1"] } });
		const terminal = panels.getView("a")?.getComponent(["out"]);
		panels.set("a", { placement: "aboveEditor", node: { type: "terminal", key: "out", lines: ["1", "2"] } });
		expect(panels.getView("a")?.getComponent(["out"])).toBe(terminal);

		panels.set("b", {
			title: "Long",
			placement: "aboveEditor",
			node: { type: "list", items: ["a", "b", "c", "d", "e"].map((item): UiNode => ({ type: "text", text: item })) },
		});
		expect(panels.keys()).toEqual(["a", "b"]);
		expect(text(panels.aboveEditor)).toBe("1\n2\nLong\n• a\n• b\n… 3 more rows");

		expect(() =>
			panels.set("b", {
				placement: "aboveEditor",
				node: {
					type: "list",
					items: [
						{ type: "text", key: "x", text: "1" },
						{ type: "text", key: "x", text: "2" },
					],
				},
			}),
		).toThrow(/Duplicate/);
		expect(panels.keys()).toEqual(["a"]);
		panels.set("a", undefined);
		expect(panels.keys()).toEqual([]);
		expect(text(panels.aboveEditor)).toBe("");
	});
});

describe("tool card", () => {
	const base: ToolCardProps = {
		presentation: {
			title: [{ text: "$ npm test", token: "accent" }],
			activity: "Executing",
			summary: [{ type: "terminal", key: "out", lines: ["last line"] }],
			body: [{ type: "terminal", key: "out", lines: ["first line", "last line"] }],
			showsDuration: true,
		},
		state: "running",
		elapsedMs: 2500,
	};

	function card(props: ToolCardProps, sink?: UiIntentSink): ToolCard {
		const created = new ToolCard(props, sink === undefined ? {} : { intents: sink });
		disposals.push(() => created.dispose());
		return created;
	}

	it("shows the summary collapsed and the body expanded, under the state badge", () => {
		const toolCard = card(base);
		expect(lines(toolCard, 60)).toEqual([
			"",
			" $ npm test [running] Executing (2.5s)",
			" last line",
			expect.stringContaining("to expand"),
		]);
		toolCard.setProps({ ...base, expanded: true });
		expect(text(toolCard)).toContain("first line\n last line");
		expect(text(toolCard)).not.toContain("to expand");

		// A finished call shows its duration from a second on, and only when the presentation asks.
		toolCard.setProps({ ...base, state: "done", elapsedMs: 400 });
		expect(lines(toolCard, 60)[1]).toBe(" $ npm test [success] Executing");
		toolCard.setProps({ ...base, state: "done", isError: true });
		expect(lines(toolCard, 60)[1]).toBe(" $ npm test [failure] Executing (2.5s)");
		toolCard.setProps({ ...base, presentation: { ...base.presentation, showsDuration: false } });
		expect(lines(toolCard, 60)[1]).toBe(" $ npm test [running] Executing");
		toolCard.setProps({ ...base, state: "pending", elapsedMs: undefined });
		expect(lines(toolCard, 60)[1]).toBe(" $ npm test [pending] Executing");
		// Where the title would shrink to almost nothing, the state goes on its own line.
		expect(lines(toolCard, 24).slice(1, 3)).toEqual([" $ npm test", " [pending] Executing"]);
		expect(lines(toolCard, 32)[1]).toBe(" $ npm test [pending] Executing");
		toolCard.setProps({ ...base, presentation: { ...base.presentation, hidden: true } });
		expect(toolCard.render(60).lines).toEqual([]);
	});

	it("renders actions and result images below the content", () => {
		const sink = new RecordingSink();
		const toolCard = card(
			{
				...base,
				state: "done",
				presentation: {
					title: "read logo.png",
					actions: [{ id: "open", label: "Open", intent: { type: "open_work", input: { workId: "w1" } } }],
				},
				images: [{ mimeType: "image/png", data: PNG_1X1 }],
			},
			sink,
		);
		const rendered = text(toolCard);
		expect(rendered).toContain("[ Open ]");
		expect(rendered).toContain("[Image: [image/png] 1x1]");
	});
});
