import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolPresentation, UiNode } from "@hansjm10/volt-protocol";
import { PRESENTATION_REMOTE_MAX_SERIALIZED_BYTES } from "@hansjm10/volt-protocol";
import { describe, expect, it } from "vitest";
import { getReadmePath } from "../src/config.ts";
import { type BashOperations, createBashToolDefinition } from "../src/core/tools/bash.ts";
import {
	BUILTIN_PRESENTERS,
	parseEditDiff,
	presentBackground,
	presentBash,
	presentEdit,
	presentRead,
	presentWrite,
} from "../src/core/tools/presenters.ts";
import { createReadTool } from "../src/core/tools/read.ts";
import {
	genericToolPresentation,
	presentToolCall,
	serializedBytes,
	type ToolPresenter,
	type ToolPresentInput,
} from "../src/core/ui/presentation.ts";

const cwd = process.cwd();

function input(
	args: Record<string, unknown>,
	state: ToolPresentInput["state"],
	result?: { text?: string; details?: unknown; isError?: boolean; partial?: boolean },
): ToolPresentInput {
	return {
		args,
		argsComplete: state !== "pending",
		state,
		...(result === undefined
			? {}
			: {
					result: {
						content: result.text === undefined ? [] : [{ type: "text", text: result.text }],
						...(result.details === undefined ? {} : { details: result.details }),
						isError: result.isError ?? false,
						partial: result.partial ?? false,
					},
				}),
		cwd,
	};
}

/** The plain text of a presentation's nodes. */
function plain(nodes: readonly UiNode[] | undefined): string {
	const text = (styled: unknown): string =>
		typeof styled === "string"
			? styled
			: Array.isArray(styled)
				? styled.map((span) => (typeof span === "string" ? span : (span as { text: string }).text)).join("")
				: "";
	return (nodes ?? [])
		.map((node) => {
			switch (node.type) {
				case "text":
					return text(node.text);
				case "terminal":
					return node.lines.map(text).join("\n");
				case "code":
					return node.code;
				case "diff":
					return node.lines.map((line) => `${line.kind}:${line.text}`).join("\n");
				case "card":
					return [
						text(node.title),
						...(node.badges ?? []).map((badge) => badge.label),
						...(node.sections ?? []).map((section) => plain(section.children)),
					].join("\n");
				case "keyValue":
					return node.items.map((item) => `${text(item.label)}: ${text(item.value)}`).join("\n");
				default:
					return "";
			}
		})
		.join("\n");
}

function title(presentation: ToolPresentation): string {
	return typeof presentation.title === "string"
		? presentation.title
		: presentation.title.map((span) => span.text).join("");
}

function present(presenter: ToolPresenter, value: ToolPresentInput): ToolPresentation {
	return presentToolCall({ present: presenter, policy: { owner: "host" } }, "tool", value, 64 * 1024);
}

describe("bash presenter", () => {
	it("starts live with an empty partial result before output arrives", async () => {
		const updates: unknown[] = [];
		const operations: BashOperations = {
			exec: async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				return { exitCode: 0 };
			},
		};
		const running = createBashToolDefinition(cwd, { operations }).execute(
			"tool-bash-1",
			{ command: "sleep 10" },
			undefined,
			(update) => updates.push(update),
			{} as never,
		);
		expect(updates).toEqual([{ content: [] }]);
		await running;
	});

	it("titles the call with its command and the timeout in force", () => {
		const presented = present(presentBash, input({ command: "npm test", timeout: 99_999 }, "running"));
		expect(title(presented)).toBe("$ npm test (timeout 3600s)");
		expect(presented.showsDuration).toBe(true);
		expect(presented.body).toBeUndefined();
	});

	it("shows a long or multi-line command in full below its one-line title", () => {
		const command = "for f in *; do\n  echo $f\ndone";
		const presented = present(presentBash, input({ command }, "done", { text: "a\nb" }));
		expect(title(presented)).toBe("$ for f in *; do echo $f done");
		expect(presented.body?.[0]).toEqual({ type: "code", key: "command", language: "bash", code: command });
	});

	it("keeps a line still being written apart from complete output while running", () => {
		const text = "1\n2\n3\n4\n5\n6\nsev";
		const presented = present(presentBash, input({ command: "build" }, "running", { text, partial: true }));
		const output = presented.body?.find((node) => node.key === "output");
		expect(output).toMatchObject({ type: "terminal", lines: ["1", "2", "3", "4", "5", "6"] });
		expect(presented.body?.find((node) => node.key === "partial")).toMatchObject({ type: "text", text: "sev" });
		expect(plain(presented.summary)).toBe("3\n4\n5\n6\nsev");
		// Output the summary shows whole needs no body.
		const short = present(presentBash, input({ command: "build" }, "running", { text: "one\ntw", partial: true }));
		expect(plain(short.summary)).toBe("one\ntw");
		expect(short.body).toBeUndefined();
	});

	it("collapses finished output longer than five lines to how many lines it wrote", () => {
		const lines = Array.from({ length: 12 }, (_, index) => `line-${index + 1}`);
		const presented = present(presentBash, input({ command: "seq 12" }, "done", { text: lines.join("\n") }));
		expect(presented.summary).toEqual([{ type: "text", key: "lines", text: [{ text: "12 lines", token: "muted" }] }]);
		expect(plain(presented.body)).toBe(lines.join("\n"));

		// A failed command says how it ended beside the count.
		const failed = present(
			presentBash,
			input({ command: "seq 12" }, "done", {
				text: `${lines.join("\n")}\n\nCommand exited with code 2`,
				isError: true,
			}),
		);
		expect(plain(failed.summary)).toBe("exit 2 · 12 lines");
		expect(plain(failed.body)).toBe(`${lines.join("\n")}\nexit 2`);

		// Output that fits shows whole, with no body.
		const short = present(presentBash, input({ command: "seq 5" }, "done", { text: "1\n2\n3\n4\n5" }));
		expect(short.summary?.[0]).toMatchObject({ type: "terminal", lines: ["1", "2", "3", "4", "5"] });
		expect(short.body).toBeUndefined();
	});

	it.each([
		["Command exited with code 2", "exit 2", "error"],
		["Command timed out after 30 seconds", "timed out after 30s", "warning"],
		["Command aborted", "aborted", "warning"],
		[
			"Command produced no output for 300 seconds and was killed as hung. If this command is legitimately silent for longer, pass a larger stallTimeout.",
			"killed after 300s without output",
			"warning",
		],
	])("says how a failed command ended: %s", (status, text, token) => {
		const presented = present(
			presentBash,
			input({ command: "x" }, "done", { text: `out\n\n${status}`, isError: true }),
		);
		expect(presented.summary).toContainEqual({ type: "text", key: "status", text, token });
		expect(plain(presented.body)).not.toContain("Command");
	});

	it("does not duplicate final full output truncation details", async () => {
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				for (let i = 1; i <= 4000; i++) onData(Buffer.from(`line-${String(i).padStart(4, "0")}\n`));
				return { exitCode: 0 };
			},
		};
		const result = await createBashToolDefinition(cwd, { operations }).execute(
			"bash-truncated",
			{ command: "generate output" },
			undefined,
			undefined,
			{} as never,
		);
		const presented = present(presentBash, {
			args: { command: "generate output" },
			argsComplete: true,
			state: "done",
			result: { content: result.content, details: result.details, isError: false, partial: false },
			cwd,
		});
		// The count is of every line the command wrote, not only the ones the tool kept.
		expect(plain(presented.summary)).toBe("4000 lines");
		const body = plain(presented.body);
		expect(body.match(/Full output:/g)).toHaveLength(1);
		expect(body).toContain("Truncated: showing 2000 of 4000 lines");
		expect(body).not.toContain("[Showing lines 2001-4000 of 4000");
		const output = presented.body?.find((node) => node.key === "output");
		expect(output).toMatchObject({ type: "terminal", omittedLines: 2000 });
		expect(output?.type === "terminal" ? output.lines.at(-1) : undefined).toBe("line-4000");
	});

	it("converts ANSI styling to semantic tokens", () => {
		const presented = present(presentBash, input({ command: "x" }, "done", { text: "\x1b[31mfailed\x1b[0m ok" }));
		const terminal = presented.summary?.[0];
		expect(terminal?.type === "terminal" ? terminal.lines[0] : undefined).toEqual([
			{ text: "failed", token: "error" },
			{ text: " ok" },
		]);
		expect(JSON.stringify(presented)).not.toContain("\x1b");
	});
});

describe("read presenter", () => {
	it("titles a read with its path and line range, legacy file_path included", () => {
		expect(title(present(presentRead, input({ file_path: "notes.md" }, "running")))).toBe("read notes.md");
		expect(title(present(presentRead, input({ path: "src/a.ts", offset: 3, limit: 4 }, "running")))).toBe(
			"read src/a.ts:3-6",
		);
	});

	it("collapses text longer than ten lines to how many lines it read and shows it whole expanded", () => {
		const text = Array.from({ length: 14 }, (_, index) => `const v${index} = ${index};`).join("\n");
		const presented = present(presentRead, input({ path: "a.ts" }, "done", { text: `${text}\n\n` }));
		expect(presented.summary).toEqual([{ type: "text", key: "lines", text: "14 lines", token: "muted" }]);
		expect(presented.body?.[0]).toMatchObject({ type: "code", language: "typescript", code: text });

		// Text that fits shows whole as code, with no body.
		const short = present(presentRead, input({ path: "a.ts" }, "done", { text: "const a = 1;\n" }));
		expect(short.summary).toEqual([{ type: "code", key: "code", language: "typescript", code: "const a = 1;" }]);
		expect(short.body).toBeUndefined();
	});

	const outside = process.platform === "win32" ? "C:/outside/AGENTS.md" : "/outside/AGENTS.md";
	it.each([
		[join(cwd, "attio", "SKILL.md"), "[skill] attio"],
		[join(cwd, ".volt", "AGENTS.md"), "read resource .volt/AGENTS.md"],
		[outside, `read resource ${outside}`],
		[getReadmePath(), "read docs README.md"],
	])("shows %s compactly: title only until expanded", (path, expected) => {
		const presented = present(presentRead, input({ path, offset: 120, limit: 210 }, "done", { text: "hidden" }));
		expect(title(presented)).toBe(`${expected}:120-329`);
		expect(presented.summary).toBeUndefined();
		expect(plain(presented.body)).toContain("hidden");
	});

	it("shows how much of the file a limited read left, not the note it leaves the model", () => {
		const text = Array.from({ length: 12 }, (_, index) => `line ${index}`).join("\n");
		const presented = present(
			presentRead,
			input({ path: "a.txt", limit: 12 }, "done", {
				text: `${text}\n\n[50 more lines in file. Use offset=13 to continue.]`,
			}),
		);
		expect(plain(presented.summary)).toBe("12 lines · 50 more in file");
		expect(plain(presented.body)).toContain("line 11\n[50 more lines in file]");
		expect(JSON.stringify(presented)).not.toContain("offset=");

		// A read the summary shows whole says so there.
		const short = present(
			presentRead,
			input({ path: "a.txt", limit: 2 }, "done", {
				text: "a\nb\n\n[8 more lines in file. Use offset=3 to continue.]",
			}),
		);
		expect(short.body).toBeUndefined();
		expect(plain(short.summary)).toBe("a\nb\n[8 more lines in file]");

		// A truncated read says how it was truncated instead.
		const truncated = present(
			presentRead,
			input({ path: "big.txt" }, "done", {
				text: "a\n\n[Showing lines 1-1 of 5000 (50.0KB limit). Use offset=2 to continue.]",
				details: { truncation: { truncated: true, truncatedBy: "bytes", outputLines: 1, totalLines: 5000 } },
			}),
		);
		expect(plain(truncated.body)).toBe("a\n[Truncated: 1 lines shown (50.0KB limit)]");
		expect(plain(truncated.summary)).toBe("[Truncated: 1 lines shown (50.0KB limit)]");
	});

	it("never shows the note the read tool leaves the model", async () => {
		const dir = mkdtempSync(join(tmpdir(), "volt-read-presenter-"));
		try {
			const read = createReadTool(dir);
			const presentFile = async (name: string, lines: number, lineText: string, limit?: number) => {
				const path = join(dir, name);
				writeFileSync(path, Array.from({ length: lines }, (_, index) => `${index} ${lineText}`).join("\n"));
				const args = { path, ...(limit === undefined ? {} : { limit }) };
				const result = await read.execute(name, args);
				// The tool still leaves the model a note, so this checks the presenter against the tool's real wording.
				expect(JSON.stringify(result.content)).toContain("to continue.]");
				const presented = presentRead({
					args,
					argsComplete: true,
					state: "done",
					result: {
						content: result.content,
						...(result.details === undefined ? {} : { details: result.details }),
						isError: false,
						partial: false,
					},
					cwd: dir,
				});
				expect(JSON.stringify(presented)).not.toContain("to continue");
				return presented;
			};

			const limited = await presentFile("limited.txt", 30, "line", 12);
			expect(plain(limited.body)).toMatch(/11 line\n\[18 more lines in file\]$/);
			const byLines = await presentFile("lines.txt", 2500, "line");
			expect(plain(byLines.body)).toContain("Truncated: showing 2000 of 2500 lines");
			const byBytes = await presentFile("bytes.txt", 500, "x".repeat(200));
			expect(plain(byBytes.body)).toContain("limit)]");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("shows truncation, errors, and image notes", () => {
		const truncated = present(
			presentRead,
			input({ path: "big.txt" }, "done", {
				text: "a",
				details: { truncation: { truncated: true, truncatedBy: "lines", outputLines: 2000, totalLines: 5000 } },
			}),
		);
		expect(plain(truncated.body)).toContain("Truncated: showing 2000 of 5000 lines");
		const failed = present(presentRead, input({ path: "x" }, "done", { text: "ENOENT", isError: true }));
		expect(failed.summary).toEqual([{ type: "text", key: "error", text: "ENOENT", token: "error" }]);
		const image = present(presentRead, {
			...input({ path: "a.png" }, "done"),
			result: {
				content: [
					{ type: "text", text: "Read image file [image/png]" },
					{ type: "image", data: "AAAA", mimeType: "image/png" },
				],
				isError: false,
				partial: false,
			},
		});
		expect(plain(image.summary)).toBe("Read image file [image/png]");
		// The client's chrome shows the result's images; the presentation carries none.
		expect(JSON.stringify(image)).not.toContain("AAAA");
	});
});

describe("write presenter", () => {
	it("says what the call is doing while it runs", () => {
		const args = { path: "a.ts", content: "x" };
		expect(present(presentWrite, input(args, "pending")).activity).toBe("Generating content");
		expect(present(presentWrite, input(args, "running")).activity).toBe("Writing file");
		expect(present(presentWrite, input(args, "done", { text: "ok" })).activity).toBeUndefined();
	});

	it("counts the content while it arrives and shows it whole once written when it fits in ten lines", () => {
		const count = (lines: number) => [{ type: "text", key: "lines", text: `${lines} lines`, token: "muted" }];
		const long = `${Array.from({ length: 12 }, (_, index) => `line ${index}`).join("\n")}\n\n`;
		const generating = present(presentWrite, input({ path: "notes.md", content: long }, "pending"));
		expect(generating.summary).toEqual(count(12));
		expect(generating.body?.[0]).toMatchObject({ type: "code", language: "markdown", code: long.trimEnd() });
		const written = present(presentWrite, input({ path: "notes.md", content: long }, "done", { text: "ok" }));
		expect(written.summary).toEqual(count(12));
		expect(written.body?.[0]).toMatchObject({ code: long.trimEnd() });

		// Short content is a count while it arrives too, then shows whole, with no body.
		const short = "a\nb\n\n";
		expect(present(presentWrite, input({ path: "notes.md", content: short }, "running")).summary).toEqual(count(2));
		const done = present(presentWrite, input({ path: "notes.md", content: short }, "done", { text: "ok" }));
		expect(done.summary).toEqual([{ type: "code", key: "code", language: "markdown", code: "a\nb" }]);
		expect(done.body).toBeUndefined();
	});

	it("reports invalid content, errors, and diagnostics", () => {
		expect(plain(present(presentWrite, input({ path: "a", content: 42 }, "pending")).summary)).toContain(
			"invalid content arg",
		);
		const failed = present(
			presentWrite,
			input({ path: "a", content: "x" }, "done", { text: "EACCES", isError: true }),
		);
		expect(plain(failed.summary)).toContain("EACCES");
		const diagnosed = present(
			presentWrite,
			input({ path: "a", content: "x" }, "done", { text: "ok", details: { diagnostics: "a.ts:1 error" } }),
		);
		expect(diagnosed.summary).toContainEqual({
			type: "text",
			key: "diagnostics",
			text: "a.ts:1 error",
			token: "warning",
		});
		// Collapsed to a count, a long write still shows its diagnostics.
		const long = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
		const diagnosedLong = present(
			presentWrite,
			input({ path: "a", content: long }, "done", { text: "ok", details: { diagnostics: "a.ts:1 error" } }),
		);
		expect(plain(diagnosedLong.summary)).toBe("20 lines\na.ts:1 error");
	});
});

describe("edit presenter", () => {
	it("previews each replacement as a diff, with +N -M, before it runs", () => {
		const presented = present(
			presentEdit,
			input(
				{
					path: "a.ts",
					edits: [
						{ oldText: "a\nb", newText: "a\nc\nd" },
						{ oldText: "x", newText: "y" },
					],
				},
				"pending",
			),
		);
		expect(presented.activity).toBe("Generating edits");
		expect(title(presented)).toBe("edit a.ts +3 -2");
		const diff = presented.summary?.find((node) => node.type === "diff");
		// The title names the file, so the diff does not again.
		expect(diff).toMatchObject({ type: "diff", lineNumbers: false });
		expect(diff).not.toHaveProperty("path");
		expect(plain(presented.summary)).toContain("hunk:edit 2 of 2");
	});

	it("accepts the legacy oldText and newText arguments", () => {
		const presented = present(presentEdit, input({ file_path: "a", oldText: "before", newText: "after" }, "running"));
		expect(plain(presented.summary)).toContain("remove:before");
		expect(plain(presented.summary)).toContain("add:after");
	});

	it("shows the file's diff with line numbers once it ran", () => {
		const diff = " 1 keep\n-2 old\n+2 new\n+3 more\n   ...";
		const presented = present(
			presentEdit,
			input({ path: "a.ts", edits: [] }, "done", { text: "ok", details: { diff } }),
		);
		expect(title(presented)).toBe("edit a.ts +2 -1");
		expect(parseEditDiff(diff)).toEqual([
			{ kind: "context", text: "keep", oldLine: 1 },
			{ kind: "remove", text: "old", oldLine: 2 },
			{ kind: "add", text: "new", newLine: 2 },
			{ kind: "add", text: "more", newLine: 3 },
			{ kind: "hunk", text: "…" },
		]);
		expect(presented.summary?.find((node) => node.type === "diff")).toMatchObject({ lineNumbers: true });
	});

	it("shows only the error of a failed edit", () => {
		const presented = present(
			presentEdit,
			input({ path: "a", edits: [{ oldText: "a", newText: "b" }] }, "done", { text: "not found", isError: true }),
		);
		expect(presented.summary).toEqual([{ type: "text", key: "error", text: "not found", token: "error" }]);
	});
});

describe("background job card", () => {
	const background = presentBackground(presentBash);

	it("presents a call without background as the tool does", () => {
		expect(present(background, input({ command: "ls" }, "done", { text: "a" }))).toEqual(
			present(presentBash, input({ command: "ls" }, "done", { text: "a" })),
		);
	});

	it("keeps the tool's title and shows the job it started as a card", () => {
		expect(present(background, input({ command: "npm test", background: true }, "running"))).toEqual({
			title: [{ text: "$ ", bold: true }, { text: "npm test" }],
			activity: "Starting background job",
		});
		const job = { id: "job_1", tool: "bash", toolCallId: "call", label: "npm test", status: "running" };
		const presented = present(
			background,
			input({ command: "npm test", background: true }, "done", {
				text: "Background job job_1: running",
				details: { job },
			}),
		);
		expect(presented.summary?.[0]).toMatchObject({
			type: "card",
			title: "Background job",
			badges: [{ label: "Started", token: "warning" }],
		});
		expect(plain(presented.summary)).toContain("Job: job_1");
	});

	it("says when a job failed to start", () => {
		const presented = present(
			background,
			input({ command: "x", background: true }, "done", {
				text: "At most 8 background jobs may run",
				isError: true,
			}),
		);
		expect(plain(presented.summary)).toBe("Background job failed to start\nAt most 8 background jobs may run");
	});
});

describe("presenting calls", () => {
	it("gives a call whose presenter throws the generic presentation", () => {
		const presented = presentToolCall(
			{
				present: () => {
					throw new Error("broken");
				},
				policy: { owner: "host" },
			},
			"custom",
			input({ value: 1 }, "done", { text: "result text" }),
			64 * 1024,
		);
		expect(presented.title).toBe("custom");
		expect(plain(presented.body)).toContain('"value": 1');
		expect(plain(presented.body)).toContain("result text");
	});

	it("gives a call whose presenter returns invalid data the generic presentation", () => {
		const presented = presentToolCall(
			{ present: () => ({ title: 42 }) as unknown as ToolPresentation, policy: { owner: "host" } },
			"custom",
			input({}, "running"),
			64 * 1024,
		);
		expect(presented).toEqual({ title: "custom" });
	});

	it("drops the actions an extension may not bind", () => {
		const presented = presentToolCall(
			{
				present: () => ({
					title: "t",
					actions: [
						{ id: "own", label: "Own", intent: { type: "extension.intent.demo.run" } },
						{ id: "other", label: "Other", intent: { type: "extension.intent.other.run" } },
						{ id: "host", label: "Prompt", intent: { type: "prompt", input: { text: "rm -rf" } } },
					],
				}),
				policy: { owner: "extension", extensionId: "demo", ownsWork: () => false },
			},
			"custom",
			input({}, "running"),
			64 * 1024,
		);
		expect(presented.actions?.map((action) => action.id)).toEqual(["own"]);
	});

	it("fits a large presentation by dropping its oldest output lines, and keeps it within the bound", () => {
		const lines = Array.from({ length: 2000 }, (_, index) => `${index}: ${"x".repeat(60)}`);
		const presented = present(presentBash, input({ command: "x" }, "done", { text: lines.join("\n") }));
		expect(serializedBytes(presented)).toBeLessThanOrEqual(64 * 1024);
		const output = presented.body?.find((node) => node.key === "output");
		expect(output?.type === "terminal" ? output.lines.at(-1) : undefined).toBe(lines.at(-1));
		expect(output?.type === "terminal" ? (output.omittedLines ?? 0) + output.lines.length : 0).toBe(2000);
		const remote = presentToolCall(
			{ present: presentBash, policy: { owner: "host" } },
			"bash",
			input({ command: "x" }, "done", { text: lines.join("\n") }),
			PRESENTATION_REMOTE_MAX_SERIALIZED_BYTES,
		);
		expect(serializedBytes(remote)).toBeLessThanOrEqual(PRESENTATION_REMOTE_MAX_SERIALIZED_BYTES);
	});

	it("keeps the generic presentation within the bound whatever the call holds", () => {
		const huge = "y".repeat(200_000);
		const presented = genericToolPresentation(
			"custom",
			input({ data: huge }, "done", { text: `${huge}\n${huge}` }),
			PRESENTATION_REMOTE_MAX_SERIALIZED_BYTES,
		);
		expect(serializedBytes(presented)).toBeLessThanOrEqual(PRESENTATION_REMOTE_MAX_SERIALIZED_BYTES);
		expect(presented.title).toBe("custom");
	});

	it("presents calls of a log read without a runtime with the built-in presenters", () => {
		for (const tool of [
			"bash",
			"read",
			"write",
			"edit",
			"grep",
			"find",
			"ls",
			"lsp",
			"inspect",
			"web_search",
			"web_fetch",
			"mcp",
			"request_user_input",
			"jobs",
			"subagent",
			"subagent_registry",
			"update_plan",
			"submit_plan",
			"update_plan_progress",
			"request_replan",
		]) {
			expect(BUILTIN_PRESENTERS.tool(tool), tool).toBeDefined();
		}
		expect(BUILTIN_PRESENTERS.tool("image_gen")).toBeUndefined();
		expect(BUILTIN_PRESENTERS.message("work_notice")).toBeDefined();
		expect(BUILTIN_PRESENTERS.message("review")).toBeDefined();
		expect(BUILTIN_PRESENTERS.message("anything")).toBeUndefined();
	});

	it("refuses a presenter that returns a promise, observing its rejection", async () => {
		const presented = presentToolCall(
			{
				present: (() => Promise.reject(new Error("async presenter"))) as unknown as ToolPresenter,
				policy: { owner: "host" },
			},
			"custom",
			input({}, "running"),
			64 * 1024,
		);
		expect(presented).toEqual({ title: "custom" });
		// An unobserved rejection would fail this test run.
		await new Promise((resolve) => setTimeout(resolve, 10));
	});

	it("checks actions on a plain copy: a getter or toJSON cannot change an intent after the check", () => {
		let reads = 0;
		const intent = {
			get type() {
				reads++;
				return reads === 1 ? "extension.intent.demo.ok" : "approve_host_request";
			},
		};
		class Sneaky {
			type = "extension.intent.demo.ok";
			toJSON() {
				return { type: "cancel_work", input: { workId: "other" } };
			}
		}
		const presented = presentToolCall(
			{
				present: () =>
					({
						title: "t",
						actions: [
							{ id: "getter", label: "A", intent },
							{ id: "json", label: "B", intent: new Sneaky() },
						],
					}) as unknown as ToolPresentation,
				policy: { owner: "extension", extensionId: "demo", ownsWork: () => false },
			},
			"custom",
			input({}, "running"),
			64 * 1024,
		);
		expect(JSON.stringify(presented)).not.toContain("approve_host_request");
		expect(JSON.stringify(presented)).not.toContain("cancel_work");
		expect(presented.actions?.map((action) => action.intent.type) ?? []).toEqual(["extension.intent.demo.ok"]);
	});

	it("fits many small nodes in linear time", () => {
		const body = Array.from({ length: 6_000 }, (_, index) => ({
			type: "code" as const,
			key: `c${index}`,
			code: `line ${index} ${"x".repeat(60)}`,
		}));
		const started = performance.now();
		const presented = presentToolCall(
			{ present: () => ({ title: "t", body }), policy: { owner: "host" } },
			"custom",
			input({}, "done", { text: "" }),
			PRESENTATION_REMOTE_MAX_SERIALIZED_BYTES,
		);
		expect(performance.now() - started).toBeLessThan(1_500);
		expect(serializedBytes(presented)).toBeLessThanOrEqual(PRESENTATION_REMOTE_MAX_SERIALIZED_BYTES);
	});

	it("previews a large replacement without diffing it line by line", () => {
		const big = Array.from({ length: 6_000 }, (_, index) => `line ${index}`).join("\n");
		const started = performance.now();
		const presented = present(
			presentEdit,
			input({ path: "a", edits: [{ oldText: big, newText: `${big}\nmore` }] }, "pending"),
		);
		expect(performance.now() - started).toBeLessThan(1_000);
		expect(title(presented)).toBe("edit a +6001 -6000");
	});

	it("keeps the generic presentation's lines within the line bound", () => {
		const presented = genericToolPresentation("custom", input({}, "done", { text: "z".repeat(10_000) }), 64 * 1024);
		const terminal = presented.body?.find((node) => node.type === "terminal");
		const line = terminal?.type === "terminal" ? terminal.lines[0] : undefined;
		expect(typeof line === "string" ? line.length : 0).toBeLessThanOrEqual(4_096);
	});

	it("shows paths as the call spells them, so redaction can find them", () => {
		const path = `${process.env.HOME ?? "/home/user"}/work/project/src/a.ts`;
		expect(title(present(presentRead, input({ path }, "running")))).toBe(`read ${path}`);
		expect(title(present(presentWrite, input({ path, content: "" }, "running")))).toBe(`write ${path}`);
	});
});
