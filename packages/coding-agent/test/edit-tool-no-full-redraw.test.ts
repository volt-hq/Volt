import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, type Terminal, Text, TuiMainScreen } from "@hansjm10/volt-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { initTheme } from "../src/core/theme/runtime.ts";
import { computeEditsDiff, type Edit } from "../src/core/tools/edit-diff.ts";
import { presentEdit } from "../src/core/tools/presenters.ts";
import { PresentedToolComponent } from "../src/modes/interactive/components/presented-tool.ts";

class FakeTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = true;
	readonly focusState = "unknown" as const;
	writes: string[] = [];

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
	alert(): void {}
	notify(_title: string, _body: string): void {}

	get fullClearCount(): number {
		return this.writes.filter((write) => write.includes("\x1b[2J\x1b[H\x1b[3J")).length;
	}
}

async function waitForRender(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForRenderedText(
	getRender: () => string,
	expectedText: string,
	onRetry?: () => void,
	timeoutMs = 2000,
): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	let lastRender = "";
	while (Date.now() < deadline) {
		onRetry?.();
		await waitForRender();
		lastRender = getRender();
		if (lastRender.includes(expectedText)) {
			return lastRender;
		}
	}
	throw new Error(`Timed out waiting for render to include "${expectedText}". Last render:\n${lastRender}`);
}

function createLargeEdits(lines: string[]): Edit[] {
	const targets = [50, 150, 250, 350, 450, 550, 650, 750, 850, 950];
	return targets.map((lineNumber) => ({
		oldText: `${lines[lineNumber - 1]}\n${lines[lineNumber]}\n${lines[lineNumber + 1]}`,
		newText: `${lines[lineNumber - 1]}\n${lines[lineNumber]} changed\n${lines[lineNumber + 1]}`,
	}));
}

describe("edit tool TUI rendering", () => {
	const tempDirs: string[] = [];

	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(async () => {
		await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	it("renders the large diff in the call preview and does not full-redraw when the result settles", async () => {
		const dir = await mkdtemp(join(tmpdir(), "volt-edit-redraw-"));
		tempDirs.push(dir);
		const filePath = join(dir, "large-edit.txt");
		await writeFile(
			filePath,
			`${Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n")}
`,
			"utf8",
		);
		const lines = (await readFile(filePath, "utf8")).trimEnd().split("\n");
		const edits = createLargeEdits(lines);
		const diff = await computeEditsDiff(filePath, edits, process.cwd());
		if ("error" in diff) {
			throw new Error(diff.error);
		}

		const terminal = new FakeTerminal();
		const tui = new TuiMainScreen(terminal);
		const root = new Container();
		for (let i = 0; i < 200; i++) {
			root.addChild(new Text(`history ${i}`, 0, 0));
		}

		const component = new PresentedToolComponent(
			"edit",
			{ path: filePath, edits },
			{ present: presentEdit, policy: { owner: "host" } },
			tui,
			process.cwd(),
		);
		root.addChild(component);
		tui.addChild(root);
		tui.start();
		await waitForRender();

		component.setArgsComplete();
		tui.requestRender();
		await waitForRender();
		await waitForRender();

		const callOnlyRender = await waitForRenderedText(
			() => component.render(80).lines.join("\n"),
			"line 50 changed",
			() => tui.requestRender(true),
		);
		expect(callOnlyRender).toContain("edit");
		expect(callOnlyRender).toContain("line 950 changed");

		const redrawsBeforeResult = tui.fullRedraws;
		const clearsBeforeResult = terminal.fullClearCount;
		component.updateResult(
			{
				content: [{ type: "text", text: `Successfully replaced ${edits.length} block(s) in ${filePath}.` }],
				details: diff,
				isError: false,
			},
			false,
		);
		tui.requestRender();
		await waitForRender();

		expect(tui.fullRedraws).toBe(redrawsBeforeResult);
		expect(terminal.fullClearCount).toBe(clearsBeforeResult);

		const settledRender = component.render(80).lines.join("\n");
		expect(settledRender).toContain("line 50 changed");
		expect(settledRender).toContain("line 950 changed");
		expect(settledRender).not.toContain("Successfully replaced");
	});

	it("reconstructs the diff from a settled result without argsComplete", async () => {
		const dir = await mkdtemp(join(tmpdir(), "volt-edit-replay-"));
		tempDirs.push(dir);
		const filePath = join(dir, "replay-edit.txt");
		await writeFile(
			filePath,
			`${Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n")}
`,
			"utf8",
		);
		const lines = (await readFile(filePath, "utf8")).trimEnd().split("\n");
		const edits = createLargeEdits(lines).slice(0, 2);
		const diff = await computeEditsDiff(filePath, edits, process.cwd());
		if ("error" in diff) {
			throw new Error(diff.error);
		}
		await rm(filePath, { force: true });

		const terminal = new FakeTerminal();
		const tui = new TuiMainScreen(terminal);
		const component = new PresentedToolComponent(
			"edit",
			{ path: filePath, edits },
			{ present: presentEdit, policy: { owner: "host" } },
			tui,
			process.cwd(),
		);
		tui.addChild(component);
		tui.start();
		await waitForRender();

		component.updateResult(
			{
				content: [{ type: "text", text: `Successfully replaced ${edits.length} block(s) in ${filePath}.` }],
				details: diff,
				isError: false,
			},
			false,
		);
		await waitForRender();
		await waitForRender();

		const rendered = component.render(80).lines.join("\n");
		expect(rendered).toContain("line 50 changed");
		expect(rendered).toContain("line 150 changed");
	});

	it("shows the error of edits that do not apply without a diff", async () => {
		const terminal = new FakeTerminal();
		const tui = new TuiMainScreen(terminal);
		const component = new PresentedToolComponent(
			"edit",
			{ path: "missing-edit.txt", edits: [{ oldText: "does not exist", newText: "replacement" }] },
			{ present: presentEdit, policy: { owner: "host" } },
			tui,
			process.cwd(),
		);
		tui.addChild(component);
		tui.start();
		component.setArgsComplete();
		// Before it runs, the call previews its replacement; the presenter reads no file.
		expect(component.render(80).lines.join("\n")).toContain("replacement");
		component.updateResult(
			{
				content: [{ type: "text", text: "Could not find the exact text in missing-edit.txt." }],
				isError: true,
			},
			false,
		);
		const rendered = component.render(80).lines.join("\n");
		expect(rendered).toContain("Could not find");
		expect(rendered).not.toContain("replacement");
	});
});
