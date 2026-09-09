import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Container,
	Editor,
	getKeybindings,
	isViewportTUI,
	ScrollView,
	setKeybindings,
	Text,
	type TUI,
	TuiAltScreen,
	TuiMainScreen,
	VStack,
} from "@hansjm10/volt-tui";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import type { BackgroundJobSnapshot, BackgroundJobSource } from "../../src/core/background-jobs.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { getEditorTheme, initTheme, theme } from "../../src/core/theme/runtime.ts";
import { BackgroundJobView, renderBackgroundJobCard } from "../../src/core/tools/background-render.ts";
import {
	BackgroundJobsInspector,
	BackgroundJobsStatus,
} from "../../src/modes/interactive/components/background-jobs.ts";

// Deterministic, model-free screen evidence through both real renderers and xterm.
const directory = process.argv[2] ?? join(tmpdir(), "volt-background-jobs-ui");
mkdirSync(directory, { recursive: true });
const previousBindings = getKeybindings();
setKeybindings(new KeybindingsManager());
for (const mode of ["regular", "fullscreen"] as const) {
	for (const width of [80, 120]) {
		for (const color of ["dark", "light"] as const) {
			initTheme(color);
			const now = Date.now();
			const jobs: BackgroundJobSnapshot[] = [
				{
					id: "job_11111111-1111-1111-1111-111111111111",
					toolName: "bash",
					toolCallId: "tests",
					label: "node node_modules/vitest/dist/cli.js --run test/background-jobs.test.ts",
					status: "running",
					startedAt: now - 18_000,
					lastOutputAt: now - 2_000,
					output:
						"RUN test/background-jobs.test.ts\nPASS starts jobs without blocking\nPASS returns latest output snapshot\nPASS cancellation waits for worker cleanup",
					outputTruncated: false,
				},
				{
					id: "job_22222222-2222-2222-2222-222222222222",
					toolName: "bash",
					toolCallId: "check",
					label: "npm run check",
					status: "failed",
					startedAt: now - 50_000,
					endedAt: now - 10_000,
					output:
						"src/example.ts(42,7): error TS2322: Type 'string' is not assignable to type 'number'.\nCommand exited with code 1",
					outputTruncated: false,
				},
				{
					id: "job_33333333-3333-3333-3333-333333333333",
					toolName: "subagent",
					toolCallId: "review",
					label: "Review cancellation and job output retention",
					status: "running",
					startedAt: now - 6_000,
					output: "",
					outputTruncated: false,
				},
			];
			const listeners = new Set<() => void>();
			const source: BackgroundJobSource = {
				list: () => jobs.map(({ output: _output, outputTruncated: _truncated, ...job }) => ({ ...job })),
				get: (id) => {
					const job = jobs.find((job) => job.id === id);
					if (!job) throw new Error("Unknown fixture job");
					return { ...job };
				},
				cancel: (id) => {
					const job = jobs.find((job) => job.id === id);
					if (!job) throw new Error("Unknown fixture job");
					job.status = "cancelling";
					for (const listener of listeners) listener();
					return { ...job };
				},
				subscribe: (listener) => {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
			};
			const terminal = new VirtualTerminal(width, 24);
			const ui: TUI = mode === "regular" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
			const transcript = new Container();
			transcript.addChild(new Text("I started the background tests and am checking the implementation.", 1, 0));
			transcript.addChild(new BackgroundJobView((width) => renderBackgroundJobCard(jobs[0], width, theme)));
			const dock = new Container();
			dock.addChild(new BackgroundJobsStatus(() => source));
			const editor = new Editor(ui, getEditorTheme(), { topBorderLabel: "ASK VOLT · BUILD" });
			dock.addChild(editor);
			dock.addChild(new Text("Volt · background-job UI fixture (no model calls)", 0, 0));
			ui.addChild(transcript);
			ui.addChild(dock);
			if (isViewportTUI(ui))
				ui.setLayoutRoot(
					new VStack([
						{
							component: new ScrollView(transcript, { follow: "end", primary: true }),
							basis: 0,
							grow: 1,
							minSize: 1,
						},
						{ component: dock, basis: "auto", shrink: 1, minSize: 1 },
					]),
				);
			ui.setFocus(editor);
			ui.start();
			const captures: string[] = [];
			const capture = async (name: string) => {
				ui.requestRender();
				await terminal.waitForRender();
				captures.push(`=== ${name} · ${mode} · ${width}x24 · ${color} ===\n${terminal.getViewport().join("\n")}`);
			};
			await capture("Running tests and persistent job status");
			let close = () => {};
			const inspector = new BackgroundJobsInspector(source, {
				getHeight: () => 22,
				requestRender: () => ui.requestRender(),
				onClose: () => close(),
			});
			const overlay = ui.showOverlay(inspector, { width: "100%", margin: { top: 1, bottom: 1, left: 0, right: 0 } });
			close = () => overlay.hide();
			try {
				await capture("Job inspector");
				terminal.sendInput("\r");
				await capture("Retained output");
				terminal.sendInput("\x0b");
				await capture("Cancellation confirmation");
				terminal.sendInput("\x1b");
				jobs[0] = {
					...jobs[0],
					status: "completed",
					endedAt: now + 6000,
					output: "Test Files  1 passed (1)\nTests       12 passed (12)\nDuration    24s",
				};
				for (const listener of listeners) listener();
				await capture("Completed tests");
				const output = Array.from({ length: 2010 }, (_, index) => `output ${String(index).padStart(4, "0")}`);
				jobs[0] = { ...jobs[0], status: "running", endedAt: undefined, output: output.slice(0, 2000).join("\n") };
				for (const listener of listeners) listener();
				await capture("Follow before retention rollover");
				terminal.sendInput("\x1b[H");
				for (let index = 0; index < 30; index++) terminal.sendInput("\x1b[B");
				await capture("Paused reading snapshot");
				jobs[0] = { ...jobs[0], output: output.slice(-2000).join("\n"), outputTruncated: true };
				for (const listener of listeners) listener();
				await capture("Paused after retention rollover");
				terminal.sendInput("\x1b[F");
				await capture("Following latest after retention rollover");
				terminal.sendInput("\x0b");
				await capture("Confirm cancellation");
				terminal.sendInput("\r");
				await capture("Cancelling");
				jobs[0] = {
					...jobs[0],
					status: "cancelled",
					endedAt: now + 6000,
					output: "Worker cleanup finished",
					outputTruncated: false,
				};
				for (const listener of listeners) listener();
				terminal.sendInput("\x1b");
				await capture("Cancelled list without a stale waiting message");
			} finally {
				inspector.dispose();
				overlay.hide();
				ui.stop({ preserveScreen: true });
			}
			writeFileSync(join(directory, `${mode}-${width}-${color}.txt`), captures.join("\n\n"));
		}
	}
}
setKeybindings(previousBindings);
process.stdout.write(`Captured background-job screens in ${directory}\n`);
