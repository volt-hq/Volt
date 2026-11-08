import type { ToolPresentation, UiNode } from "@hansjm10/volt-protocol";
import { PRESENTATION_REMOTE_MAX_SERIALIZED_BYTES } from "@hansjm10/volt-protocol";
import { describe, expect, it } from "vitest";
import { BUILTIN_PRESENTERS } from "../../src/core/tools/presenters.ts";
import type { RunCodeDetails, RunCodeProgress } from "../../src/core/tools/run-code.ts";
import { presentRunCode } from "../../src/core/tools/run-code-presenter.ts";
import {
	HOST_UI_POLICY,
	normalizeToolPresentation,
	serializedBytes,
	type ToolPresentInput,
} from "../../src/core/ui/presentation.ts";

type Steps = Extract<UiNode, { type: "progress"; kind: "steps" }>;

const NOW = 1_762_620_000_000;
const SCRIPT = "const files = await tools.find({ pattern: '*.ts' });\nreturn files.length;";

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
		cwd: "/",
	};
}

function running(progress: RunCodeProgress, output = ""): ToolPresentInput {
	return input({ code: SCRIPT }, "running", { text: output, details: progress, partial: true });
}

function done(details: RunCodeDetails, output: string, args: Record<string, unknown> = { code: SCRIPT }) {
	return input(args, "done", { text: output, details, isError: details.status === "failed" });
}

function finalDetails(partial: Partial<RunCodeDetails>): RunCodeDetails {
	const calls = partial.calls ?? [];
	const callTotals = { completed: 0, failed: 0, cancelled: 0, unsettled: 0 };
	for (const call of calls) callTotals[call.status]++;
	return {
		status: "completed",
		language: "javascript",
		wallMs: 1200,
		calls,
		callTotals,
		complete: true,
		output: { truncated: false, items: 0, characters: 0 },
		images: { shown: [], unshown: [] },
		...partial,
	};
}

function node<T extends UiNode["type"]>(nodes: readonly UiNode[] | undefined, key: string, type: T) {
	const found = nodes?.find((candidate) => candidate.key === key);
	expect(found?.type).toBe(type);
	return found as Extract<UiNode, { type: T }>;
}

function plain(text: unknown): string {
	return typeof text === "string"
		? text
		: Array.isArray(text)
			? text.map((span: { text: string }) => span.text).join("")
			: "";
}

/** The presentation a paired device receives: normalized and fitted to its bound, which throws if it cannot fit. */
function forPairedDevice(presentation: ToolPresentation): ToolPresentation {
	return normalizeToolPresentation(presentation, {
		policy: HOST_UI_POLICY,
		maxBytes: PRESENTATION_REMOTE_MAX_SERIALIZED_BYTES,
	});
}

describe("run_code presenter", () => {
	it("is the built-in presenter of run_code calls", () => {
		expect(BUILTIN_PRESENTERS.tool("run_code")?.present).toBe(presentRunCode);
	});

	it("titles a call by its description, else the first line of its script", () => {
		const described = presentRunCode({
			...input({ code: SCRIPT, description: "  Count the TS files  " }, "pending"),
			argsComplete: true,
		});
		expect(described.title).toStrictEqual([{ text: "Count the TS files" }]);
		expect(described.activity).toBe("Waiting to run");

		const streaming = presentRunCode({ ...input({ code: "\n\n  const a" }, "pending"), argsComplete: false });
		expect(streaming.title).toStrictEqual([{ text: "const a", code: true }]);
		expect(streaming.activity).toBe("Writing script");
		expect(node(streaming.body, "script", "code")).toMatchObject({ language: "javascript", code: "\n\n  const a" });

		const blank = presentRunCode(input({ code: SCRIPT, description: "   " }, "running"));
		expect(blank.title).toStrictEqual([{ text: "const files = await tools.find({ pattern: '*.ts' });", code: true }]);
		expect(blank.activity).toBe("Running script");
		expect(blank.showsDuration).toBe(true);

		expect(plain(presentRunCode(input({}, "pending")).title)).toBe("run_code …");
	});

	it("shows a running script's newest calls with their times, and its newest output", () => {
		const calls = [
			{ seq: 1, tool: "read", argsPreview: 'path="a.ts"', status: "completed", startedAt: NOW, endedAt: NOW + 40 },
			{
				seq: 2,
				tool: "edit",
				argsPreview: "",
				status: "failed",
				startedAt: NOW + 50,
				endedAt: NOW + 60,
				error: "no match",
			},
			{
				seq: 3,
				tool: "wait",
				argsPreview: "",
				status: "cancelled",
				startedAt: NOW + 70,
				endedAt: NOW + 80,
				error: "cancelled",
			},
			{ seq: 4, tool: "read", argsPreview: "", status: "completed", startedAt: NOW + 90, endedAt: NOW + 95 },
			{ seq: 5, tool: "read", argsPreview: "", status: "completed", startedAt: NOW + 96, endedAt: NOW + 99 },
			{ seq: 6, tool: "mcp.github.search", argsPreview: 'query="bug"', status: "running", startedAt: NOW + 100 },
			{ seq: 7, tool: "bash", argsPreview: 'command="ls"', status: "running", startedAt: NOW + 110 },
		] satisfies RunCodeProgress["calls"];
		const presented = presentRunCode(
			running(
				{
					status: "running",
					language: "typescript",
					calls,
					callTotals: { running: 2, completed: 9, failed: 1, cancelled: 1 },
					outputLines: 250,
				},
				"line 149\nline 150",
			),
		);

		expect(presented.activity).toBe("Running script: 13 calls, 2 running");
		const recent = node(presented.summary, "recent", "progress") as Steps;
		expect(recent.title).toBeUndefined();
		expect(recent.steps.map((step) => step.key)).toStrictEqual(["#3", "#4", "#5", "#6", "#7"]);

		expect(node(presented.body, "script", "code")).toMatchObject({ language: "typescript", code: SCRIPT });
		const steps = node(presented.body, "calls", "progress") as Steps;
		expect(steps.title).toBe("13 tool calls, newest 7 shown");
		expect(steps.steps.slice(0, 3)).toStrictEqual([
			{ key: "#1", label: 'read path="a.ts"', status: "done", startedAt: NOW, endedAt: NOW + 40 },
			{
				key: "#2",
				label: "edit",
				status: "failed",
				detail: [{ text: "no match", token: "error" }],
				startedAt: NOW + 50,
				endedAt: NOW + 60,
			},
			{
				key: "#3",
				label: "wait",
				status: "skipped",
				detail: [{ text: "cancelled", token: "error" }],
				startedAt: NOW + 70,
				endedAt: NOW + 80,
			},
		]);
		expect(steps.steps.at(-1)).toStrictEqual({
			key: "#7",
			label: 'bash command="ls"',
			status: "active",
			startedAt: NOW + 110,
		});
		expect(node(presented.body, "output", "terminal")).toStrictEqual({
			type: "terminal",
			key: "output",
			lines: ["line 149", "line 150"],
			omittedLines: 248,
		});
		// The body's nodes keep their keys, so the next update reaches clients as a patch.
		expect(presented.body?.map((child) => child.key)).toStrictEqual(["script", "calls", "output"]);
	});

	it("summarizes a run that ended, with its calls' durations and errors and its result's newest lines", () => {
		const succeeded = presentRunCode(
			done(
				finalDetails({
					calls: [
						{
							seq: 1,
							tool: "read",
							argsPreview: 'path="a.ts"',
							status: "completed",
							readOnly: true,
							durationMs: 40,
						},
						{ seq: 2, tool: "bash", status: "completed", readOnly: false, durationMs: 2500 },
					],
				}),
				"Script completed in 1.2s (2 tool calls)\nReturn value: 7",
				{ code: SCRIPT, description: "Count files" },
			),
		);
		expect(succeeded.activity).toBeUndefined();
		expect(succeeded.summary).toStrictEqual([{ type: "text", key: "status", text: "2 tool calls, 1.2s" }]);
		expect((node(succeeded.body, "calls", "progress") as Steps).steps).toStrictEqual([
			{ key: "#1", label: 'read path="a.ts"', status: "done", detail: [{ text: "40ms", token: "muted" }] },
			{ key: "#2", label: "bash", status: "done", detail: [{ text: "2.5s", token: "muted" }] },
		]);
		expect(node(succeeded.body, "output", "terminal").lines).toStrictEqual([
			"Script completed in 1.2s (2 tool calls)",
			"Return value: 7",
		]);

		const resultLines = Array.from({ length: 150 }, (_, index) => `result line ${index + 1}`);
		const failed = presentRunCode(
			done(
				finalDetails({
					status: "failed",
					failureKind: "timeout",
					language: "typescript",
					wallMs: 6400,
					calls: [
						{ seq: 1, tool: "edit", status: "failed", readOnly: false, durationMs: 12, error: "no match" },
						{ seq: 2, tool: "wait", status: "cancelled", readOnly: false, durationMs: 3 },
						{ seq: 3, tool: "bash", status: "unsettled", readOnly: false, durationMs: 5000 },
					],
					complete: false,
				}),
				resultLines.join("\n"),
			),
		);
		expect(failed.summary).toStrictEqual([
			{
				type: "text",
				key: "status",
				text: "Timed out · 3 tool calls, 1 failed, 1 cancelled, 1 still running at the end, 6.4s",
				token: "error",
			},
		]);
		expect(node(failed.body, "script", "code").language).toBe("typescript");
		expect((node(failed.body, "calls", "progress") as Steps).steps).toStrictEqual([
			{ key: "#1", label: "edit", status: "failed", detail: [{ text: "12ms · no match", token: "error" }] },
			{ key: "#2", label: "wait", status: "skipped", detail: [{ text: "3ms", token: "muted" }] },
			{ key: "#3", label: "bash", status: "failed", detail: [{ text: "may have applied · 5.0s", token: "error" }] },
		]);
		expect(plain(node(failed.body, "incomplete", "text").text)).toContain("dropped");
		const output = node(failed.body, "output", "terminal");
		expect(output.lines).toHaveLength(100);
		expect(output.lines[0]).toBe("result line 51");
		expect(output.omittedLines).toBe(50);
	});

	it("lists at most the newest 50 calls and counts every call in its title", () => {
		const calls = Array.from({ length: 200 }, (_, index) => ({
			seq: index + 1,
			tool: "read",
			argsPreview: `path="f${index + 1}.ts"`,
			status: "completed" as const,
			readOnly: true,
			durationMs: 1,
		}));
		const presented = presentRunCode(done(finalDetails({ calls }), "Script completed"));
		const steps = node(presented.body, "calls", "progress") as Steps;
		expect(steps.title).toBe("200 tool calls, newest 50 shown");
		expect(steps.steps.map((step) => step.key)).toStrictEqual(
			Array.from({ length: 50 }, (_, index) => `#${index + 151}`),
		);
	});

	it("falls back to the result when details are missing or malformed, and keeps step keys unique", () => {
		for (const details of [undefined, "details", 7, { status: "unknown" }, { status: "running", calls: "x" }]) {
			const presented = presentRunCode(
				input({ code: SCRIPT }, "done", { text: "Error: it broke", details, isError: true }),
			);
			expect(presented.summary).toStrictEqual([
				{ type: "text", key: "error", text: "Error: it broke", token: "error" },
			]);
			expect(presented.body?.map((child) => child.key)).toStrictEqual(["script", "output"]);
			expect(() => forPairedDevice(presented)).not.toThrow();
		}

		const malformed = presentRunCode(
			done(
				{
					status: "completed",
					wallMs: -1,
					callTotals: "many",
					calls: [
						null,
						{ seq: "1", tool: "read", status: "completed" },
						{ seq: 2, tool: 7, status: "completed" },
						{ seq: 3, tool: "read", status: "running" },
						{ seq: 4, tool: "read", status: "completed", durationMs: "slow", error: 5 },
						{ seq: 4, tool: "edit", status: "failed" },
					],
				} as unknown as RunCodeDetails,
				"Script completed",
			),
		);
		// Without totals, the card counts the calls it could read.
		expect(malformed.summary).toStrictEqual([{ type: "text", key: "status", text: "1 tool call, 1 failed" }]);
		expect((node(malformed.body, "calls", "progress") as Steps).steps).toStrictEqual([
			{ key: "#4", label: "edit", status: "failed" },
		]);
		expect(() => forPairedDevice(malformed)).not.toThrow();
	});

	it("fits the paired-device bound whatever the calls hold, trimming only the script and the output", () => {
		const wide = "字".repeat(400);
		const calls = Array.from({ length: 200 }, (_, index) => ({
			seq: index + 1,
			tool: `mcp.${wide}.${wide}`,
			argsPreview: `query="${wide}"`,
			status: "failed" as const,
			readOnly: false,
			durationMs: 1,
			error: `\u0001${wide}`,
		}));
		const script = Array.from({ length: 4000 }, (_, index) => `const v${index} = "${wide.slice(0, 40)}";`).join("\n");
		const output = Array.from({ length: 3000 }, (_, index) => `${index}: ${"x".repeat(4000)}`).join("\n");

		const ended = forPairedDevice(
			presentRunCode(
				done(finalDetails({ status: "failed", failureKind: "script_error", calls }), output, { code: script }),
			),
		);
		expect(serializedBytes(ended)).toBeLessThanOrEqual(PRESENTATION_REMOTE_MAX_SERIALIZED_BYTES);
		expect((node(ended.body, "calls", "progress") as Steps).steps.length).toBeGreaterThan(0);
		expect(node(ended.body, "script", "code").code.endsWith("…")).toBe(true);
		expect(plain(ended.summary?.[0]?.type === "text" ? ended.summary[0].text : "")).toContain("Script error");

		const live = forPairedDevice(
			presentRunCode({
				...running(
					{
						status: "running",
						language: "javascript",
						calls: calls.slice(-50).map(({ seq, tool, argsPreview, error }) => ({
							seq,
							tool,
							argsPreview,
							status: "failed",
							startedAt: NOW,
							endedAt: NOW + 1,
							error,
						})),
						callTotals: { running: 0, completed: 0, failed: 200, cancelled: 0 },
						outputLines: 3000,
					},
					output.split("\n").slice(-100).join("\n"),
				),
				args: { code: script },
			}),
		);
		expect(serializedBytes(live)).toBeLessThanOrEqual(PRESENTATION_REMOTE_MAX_SERIALIZED_BYTES);
		expect((node(live.summary, "recent", "progress") as Steps).steps.length).toBeGreaterThan(0);
		expect((node(live.body, "calls", "progress") as Steps).steps.length).toBeGreaterThan(0);
	});
});
