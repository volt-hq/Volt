import assert from "node:assert";
import { describe, it } from "node:test";
import { FocusGroup } from "../src/focus.ts";
import { ViewReconciler, ViewRegistry } from "../src/reconciler.ts";
import { concatRenderFrames, createRenderFrame, prefixRenderFrame, type RenderFrame } from "../src/render-frame.ts";
import type { Component } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

type TestNode =
	| { type: "line"; key?: string; text: string }
	| { type: "static"; key?: string; text: string }
	| { type: "stream"; key?: string; lines: readonly string[] }
	| { type: "box"; key?: string; title: string; children: readonly TestNode[] }
	| { type: "group"; key?: string; children: readonly TestNode[] }
	| { type: "field"; key?: string; label: string };

class LineView implements Component {
	text: string;
	disposed = false;
	readonly id: number;
	private static nextId = 0;

	constructor(text: string) {
		this.text = text;
		this.id = LineView.nextId++;
	}

	render(): RenderFrame {
		return createRenderFrame([this.text]);
	}

	invalidate(): void {}

	dispose(): void {
		this.disposed = true;
	}
}

class BoxView implements Component {
	title: string;
	children: readonly Component[] = [];

	constructor(title: string) {
		this.title = title;
	}

	render(width: number): RenderFrame {
		return concatRenderFrames([
			createRenderFrame([`[${this.title}]`]),
			prefixRenderFrame(concatRenderFrames(this.children.map((child) => child.render(width - 2))), "  "),
		]);
	}

	invalidate(): void {}
}

class StreamView implements Component {
	readonly lines: string[] = [];
	readonly appended: number[] = [];

	append(lines: readonly string[]): void {
		this.lines.push(...lines);
		this.appended.push(lines.length);
	}

	render(): RenderFrame {
		return createRenderFrame(this.lines);
	}

	invalidate(): void {}
}

class FieldView implements Component {
	focused = false;
	label: string;
	readonly inputs: string[] = [];

	constructor(label: string) {
		this.label = label;
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	render(): RenderFrame {
		return createRenderFrame([`${this.focused ? ">" : " "} ${this.label}`]);
	}

	invalidate(): void {}
}

function createRegistry(log: string[] = []): ViewRegistry<TestNode> {
	const registry = new ViewRegistry<TestNode>();
	registry.register("line", {
		create: (node) => {
			log.push(`create line ${node.text}`);
			return new LineView(node.text);
		},
		update: (component, node, previous) => {
			log.push(`update line ${previous.text}->${node.text}`);
			component.text = node.text;
		},
	});
	registry.register("static", {
		create: (node) => {
			log.push(`create static ${node.text}`);
			return new LineView(node.text);
		},
		dispose: (component) => log.push(`dispose static ${component.text}`),
	});
	registry.register("stream", {
		create: (node) => {
			const view = new StreamView();
			view.append(node.lines);
			return view;
		},
		update: (component, node, previous) => component.append(node.lines.slice(previous.lines.length)),
	});
	registry.register("box", {
		create: (node) => {
			log.push(`create box ${node.title}`);
			return new BoxView(node.title);
		},
		update: (component, node) => {
			component.title = node.title;
		},
		children: (node) => node.children,
		mount: (component, children) => {
			log.push(`mount box ${component.title} (${children.length})`);
			component.children = children;
		},
		dispose: (component) => log.push(`dispose box ${component.title}`),
	});
	registry.register("group", {
		create: () => new FocusGroup(),
		update: () => {},
		children: (node) => node.children,
		mount: (component, children) => component.setChildren(children),
	});
	registry.register("field", {
		create: (node) => new FieldView(node.label),
		update: (component, node) => {
			component.label = node.label;
		},
	});
	return registry;
}

function line(key: string | undefined, text: string): TestNode {
	return key === undefined ? { type: "line", text } : { type: "line", key, text };
}

describe("ViewReconciler", () => {
	it("creates retained components for a new tree and renders roots in order", () => {
		const log: string[] = [];
		const view = new ViewReconciler(createRegistry(log));
		view.update([
			{ type: "box", key: "card", title: "Card", children: [line("a", "alpha"), line("b", "beta")] },
			line("tail", "tail"),
		]);

		assert.deepStrictEqual(view.render(40).lines, ["[Card]", "  alpha", "  beta", "tail"]);
		assert.deepStrictEqual(log, [
			"create box Card",
			"create line alpha",
			"create line beta",
			"mount box Card (2)",
			"create line tail",
		]);
	});

	it("keeps keyed components across insert, move, update, and remove", () => {
		const log: string[] = [];
		const view = new ViewReconciler(createRegistry(log));
		view.update([line("a", "A"), line("b", "B"), line("c", "C")]);
		const [a, b, c] = view.children as LineView[];
		log.length = 0;

		view.update([line("c", "C"), line("new", "N"), line("a", "A2")]);

		const next = view.children as LineView[];
		assert.strictEqual(next[0], c);
		assert.strictEqual(next[2], a);
		assert.notStrictEqual(next[1], b);
		assert.strictEqual(a!.text, "A2");
		assert.strictEqual(b!.disposed, true);
		assert.strictEqual(a!.disposed || c!.disposed, false);
		assert.deepStrictEqual(log, ["update line C->C", "create line N", "update line A->A2"]);
		assert.deepStrictEqual(view.render(10).lines, ["C", "N", "A2"]);
	});

	it("matches unkeyed nodes by position without colliding with explicit keys", () => {
		const view = new ViewReconciler(createRegistry());
		view.update([line(undefined, "first"), line("#1", "keyed")]);
		const [first, keyed] = view.children as LineView[];

		view.update([line(undefined, "first again"), line(undefined, "second"), line("#1", "keyed")]);
		const next = view.children as LineView[];
		assert.strictEqual(next[0], first);
		assert.strictEqual(next[2], keyed);
		assert.strictEqual(first!.text, "first again");
		assert.notStrictEqual(next[1], keyed);
	});

	it("replaces the component when the node type changes under the same key", () => {
		const log: string[] = [];
		const view = new ViewReconciler(createRegistry(log));
		view.update([line("x", "line")]);
		const before = view.children[0] as LineView;

		view.update([{ type: "static", key: "x", text: "static" }]);

		assert.strictEqual(before.disposed, true);
		assert.notStrictEqual(view.children[0], before);
		assert.deepStrictEqual(view.render(10).lines, ["static"]);
		assert.deepStrictEqual(log.slice(-1), ["create static static"]);
	});

	it("recreates components without update() and skips identical nodes", () => {
		const log: string[] = [];
		const view = new ViewReconciler(createRegistry(log));
		const same: TestNode = { type: "static", key: "s", text: "one" };
		const kept = line("k", "kept");
		view.update([same, kept]);
		const original = view.children[0];
		log.length = 0;

		view.update([same, kept]);
		assert.strictEqual(view.children[0], original);
		assert.deepStrictEqual(log, []);

		view.update([{ type: "static", key: "s", text: "two" }, kept]);
		assert.notStrictEqual(view.children[0], original);
		assert.deepStrictEqual(log, ["dispose static one", "create static two"]);
	});

	it("disposes removed subtrees children first and remounts reordered children", () => {
		const log: string[] = [];
		const view = new ViewReconciler(createRegistry(log));
		const inner: TestNode = {
			type: "box",
			key: "inner",
			title: "Inner",
			children: [{ type: "static", text: "leaf" }],
		};
		view.update([{ type: "box", key: "outer", title: "Outer", children: [line("a", "A"), inner, line("b", "B")] }]);
		const outer = view.children[0] as BoxView;
		const [a, , b] = outer.children as LineView[];
		log.length = 0;

		view.update([{ type: "box", key: "outer", title: "Outer", children: [line("b", "B"), line("a", "A")] }]);

		assert.deepStrictEqual(outer.children, [b, a]);
		assert.deepStrictEqual(log, [
			"update line B->B",
			"update line A->A",
			"dispose static leaf",
			"dispose box Inner",
			"mount box Outer (2)",
		]);

		log.length = 0;
		view.dispose();
		assert.deepStrictEqual(log, ["dispose box Outer"]);
		assert.strictEqual(a!.disposed && b!.disposed, true);
		assert.deepStrictEqual(view.children, []);
	});

	it("appends streamed lines to the retained component instead of rebuilding it", () => {
		const view = new ViewReconciler(createRegistry());
		view.update([
			{ type: "box", key: "card", title: "Job", children: [{ type: "stream", key: "out", lines: ["one"] }] },
		]);
		const stream = view.getComponent(["card", "out"]) as StreamView;

		view.update([
			{ type: "box", key: "card", title: "Job", children: [{ type: "stream", key: "out", lines: ["one", "two"] }] },
		]);
		view.update([
			{
				type: "box",
				key: "card",
				title: "Job",
				children: [{ type: "stream", key: "out", lines: ["one", "two", "three", "four"] }],
			},
		]);

		assert.strictEqual(view.getComponent(["card", "out"]), stream);
		assert.deepStrictEqual(stream.appended, [1, 1, 2]);
		assert.deepStrictEqual(view.render(20).lines, ["[Job]", "  one", "  two", "  three", "  four"]);
	});

	it("recreates retained components when a node type is registered again", () => {
		const registry = createRegistry();
		const view = new ViewReconciler(registry);
		view.update([line("a", "A")]);
		const before = view.children[0] as LineView;

		registry.register("line", { create: (node) => new LineView(`v2 ${node.text}`) });
		view.update([line("a", "A")]);

		assert.strictEqual(before.disposed, true);
		assert.deepStrictEqual(view.render(10).lines, ["v2 A"]);
	});

	it("rejects unknown node types and duplicate keys", () => {
		const registry = createRegistry();
		const view = new ViewReconciler(registry);
		assert.throws(() => view.update([line("a", "A"), line("a", "B")]), /Duplicate view node key "a" at root/);
		registry.unregister("static");
		assert.throws(
			() => view.update([{ type: "box", key: "b", title: "B", children: [{ type: "static", text: "x" }] }]),
			/No view definition registered for node type "static" at root\/box\[b\]/,
		);
		assert.throws(
			() => registry.register("group", { create: () => new FocusGroup(), children: (node) => node.children }),
			/defines children\(\) without mount\(\)/,
		);
		assert.throws(() => view.addChild(new LineView("x")), /managed by update/);
	});

	it("keeps focus on a retained field when its group is reconciled", () => {
		const view = new ViewReconciler(createRegistry());
		const fields = (labels: string[]): TestNode => ({
			type: "group",
			key: "form",
			children: labels.map((label) => ({ type: "field", key: label, label })),
		});
		view.update([fields(["name", "email"])]);
		const group = view.getComponent(["form"]) as FocusGroup;
		group.focused = true;
		group.handleInput("\t");
		const email = view.getComponent(["form", "email"]);

		view.update([fields(["title", "name", "email"])]);

		assert.strictEqual(view.getComponent(["form"]), group);
		assert.strictEqual(group.getFocusedChild(), email);
		assert.deepStrictEqual(view.render(20).lines, ["  title", "  name", "> email"]);
	});

	for (const mode of ["main", "alt"] as const) {
		it(`renders reconciled trees in the ${mode} screen`, async () => {
			const terminal = new VirtualTerminal(30, 6);
			const tui = mode === "main" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
			const view = new ViewReconciler(createRegistry());
			view.update([
				{
					type: "box",
					key: "card",
					title: "Build",
					children: [{ type: "stream", key: "out", lines: ["compiling"] }],
				},
			]);
			tui.addChild(view);
			tui.start();
			await terminal.waitForRender();

			view.update([
				{
					type: "box",
					key: "card",
					title: "Build ok",
					children: [{ type: "stream", key: "out", lines: ["compiling", "done"] }],
				},
			]);
			tui.requestRender();
			await terminal.waitForRender();

			const viewport = terminal.getViewport().map((row) => row.trimEnd());
			const top = viewport.indexOf("[Build ok]");
			assert.notStrictEqual(top, -1, viewport.join("\n"));
			assert.deepStrictEqual(viewport.slice(top, top + 3), ["[Build ok]", "  compiling", "  done"]);
			tui.stop();
		});
	}
});
