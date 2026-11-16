import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createReviewPrivateDiagnostics,
	getReviewPrivateDiagnosticsDirectory,
	MAX_RETAINED_REVIEW_PRIVATE_DIAGNOSTIC_FILES,
	MAX_REVIEW_PASS_TRANSCRIPT_BYTES,
	REVIEW_PRIVATE_DIAGNOSTICS_ENV,
} from "../src/core/review-private-diagnostics.ts";

const roots: string[] = [];

function createAgentDir(): string {
	const root = mkdtempSync(join(tmpdir(), "volt-review-private-diagnostics-"));
	roots.push(root);
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	return agentDir;
}

afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function readRecords(filePath: string): Array<Record<string, unknown>> {
	return readFileSync(filePath, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("private review diagnostics", () => {
	it("keeps diagnostics when the setting is absent", async () => {
		vi.stubEnv(REVIEW_PRIVATE_DIAGNOSTICS_ENV, undefined);
		const diagnostics = createReviewPrivateDiagnostics({
			agentDir: createAgentDir(),
			workflowId: "review:default",
			workflowAction: "review.pr",
		});
		diagnostics.recordModelLimitations("discovery", ["kept by default"]);

		const filePath = await diagnostics.flush();
		expect(filePath).toBeDefined();
		expect(readRecords(filePath!)).toEqual([expect.objectContaining({ message: "kept by default" })]);
	});

	it.each(["0", "false", " FALSE "])("stays disabled with diagnostics=%s", async (setting) => {
		vi.stubEnv(REVIEW_PRIVATE_DIAGNOSTICS_ENV, setting);
		const agentDir = createAgentDir();
		const diagnostics = createReviewPrivateDiagnostics({
			agentDir,
			workflowId: "review:disabled",
			workflowAction: "review.pr",
		});
		diagnostics.recordModelLimitations("discovery", ["private limitation"]);
		diagnostics.recordVerificationAssessment({ assessment: "incomplete", challenge: "private challenge" });
		diagnostics.recordPass({
			identity: { passId: 1, phase: "discovery", purpose: "findings", round: 1 },
			model: "faux/model",
			outcome: "completed",
			messages: [fauxAssistantMessage("private reasoning")],
		});

		await expect(diagnostics.flush()).resolves.toBeUndefined();
		expect(existsSync(getReviewPrivateDiagnosticsDirectory(agentDir))).toBe(false);
	});

	it("writes bounded model limitations and failed tool output to an owner-only per-run JSONL file", async () => {
		vi.stubEnv(REVIEW_PRIVATE_DIAGNOSTICS_ENV, "1");
		const agentDir = createAgentDir();
		const diagnostics = createReviewPrivateDiagnostics({
			agentDir,
			workflowId: "review:private-details",
			workflowAction: "review.pr",
		});
		diagnostics.recordModelLimitations("discovery", ["Discovery could not run the focused test."]);
		diagnostics.recordModelLimitations("verification", ["Verification was limited to static inspection."]);
		diagnostics.recordToolFailure("verification", {
			toolName: "review_read_file",
			result: { content: [{ type: "text", text: `failed: ${"x".repeat(5_000)}` }] },
		});

		const filePath = await diagnostics.flush();
		expect(filePath).toBeDefined();
		expect(await diagnostics.flush()).toBe(filePath);
		const records = readFileSync(filePath!, "utf8")
			.trim()
			.split("\n")
			.map((line): unknown => JSON.parse(line));
		expect(records).toEqual([
			expect.objectContaining({
				kind: "model_limitation",
				phase: "discovery",
				message: "Discovery could not run the focused test.",
				runId: "review:private-details",
			}),
			expect.objectContaining({
				kind: "model_limitation",
				phase: "verification",
				message: "Verification was limited to static inspection.",
			}),
			expect.objectContaining({
				kind: "tool_failure",
				phase: "verification",
				toolName: "review_read_file",
				result: expect.stringMatching(/…$/),
			}),
		]);
		if (process.platform !== "win32") {
			expect(statSync(getReviewPrivateDiagnosticsDirectory(agentDir)).mode & 0o777).toBe(0o700);
			expect(statSync(filePath!).mode & 0o777).toBe(0o600);
		}
	});

	it.each([
		{ assessment: "complete" as const },
		{ assessment: "incomplete" as const, challenge: "An omitted defect needs independent verification." },
	])("writes the verifier assessment without limitations: $assessment", async (report) => {
		vi.stubEnv(REVIEW_PRIVATE_DIAGNOSTICS_ENV, "1");
		const diagnostics = createReviewPrivateDiagnostics({
			agentDir: createAgentDir(),
			workflowId: "review:assessment-only",
			workflowAction: "review.pr",
		});
		diagnostics.recordVerificationAssessment(report);

		const filePath = await diagnostics.flush();
		expect(filePath).toBeDefined();
		expect(await diagnostics.flush()).toBe(filePath);
		const records = readFileSync(filePath!, "utf8")
			.trim()
			.split("\n")
			.map((line): unknown => JSON.parse(line));
		expect(records).toEqual([
			{
				schemaVersion: 1,
				timestamp: expect.any(String),
				runId: "review:assessment-only",
				workflowAction: "review.pr",
				phase: "verification",
				kind: "verification_assessment",
				...report,
			},
		]);
	});

	it("bounds UTF-8 challenge bytes while preserving the assessment", async () => {
		vi.stubEnv(REVIEW_PRIVATE_DIAGNOSTICS_ENV, "1");
		const diagnostics = createReviewPrivateDiagnostics({
			agentDir: createAgentDir(),
			workflowId: "review:bounded-challenge",
			workflowAction: "review.pr",
		});
		diagnostics.recordVerificationAssessment({ assessment: "incomplete", challenge: "界".repeat(2_000) });

		const filePath = await diagnostics.flush();
		expect(filePath).toBeDefined();
		const record: unknown = JSON.parse(readFileSync(filePath!, "utf8"));
		expect(record).toMatchObject({ assessment: "incomplete", challenge: expect.stringMatching(/…$/) });
		if (typeof record !== "object" || !record || !("challenge" in record) || typeof record.challenge !== "string")
			throw new Error("Expected a retained challenge");
		expect(Buffer.byteLength(record.challenge, "utf8")).toBeLessThanOrEqual(4_000);
	});

	it("retains the verifier conclusion when tool failures fill the record limit", async () => {
		vi.stubEnv(REVIEW_PRIVATE_DIAGNOSTICS_ENV, "1");
		const diagnostics = createReviewPrivateDiagnostics({
			agentDir: createAgentDir(),
			workflowId: "review:full-log",
			workflowAction: "review.pr",
		});
		for (let index = 0; index < 110; index++) {
			diagnostics.recordToolFailure("verification", { toolName: "review_file", result: {} });
		}
		diagnostics.recordVerificationAssessment({ assessment: "incomplete", challenge: "Important omitted defect." });
		diagnostics.recordToolFailure("presentation", { toolName: "review_diff", result: {} });

		const filePath = await diagnostics.flush();
		expect(filePath).toBeDefined();
		const records = readFileSync(filePath!, "utf8")
			.trim()
			.split("\n")
			.map((line): unknown => JSON.parse(line));
		expect(records).toHaveLength(100);
		expect(records.at(-1)).toMatchObject({
			kind: "verification_assessment",
			assessment: "incomplete",
			challenge: "Important omitted defect.",
		});
	});

	it("keeps each pass's bounded transcript, last report, and repair errors", async () => {
		vi.stubEnv(REVIEW_PRIVATE_DIAGNOSTICS_ENV, "1");
		const diagnostics = createReviewPrivateDiagnostics({
			agentDir: createAgentDir(),
			workflowId: "review:transcript",
			workflowAction: "review.pr",
		});
		const report = {
			summary: "One optional gap.",
			candidates: [{ candidateId: "c1", priority: 3 }],
			limitations: [],
		};
		diagnostics.recordPass({
			identity: { passId: 1, phase: "discovery", purpose: "findings", round: 1 },
			model: "faux/review-model",
			outcome: "completed",
			messages: [
				{ role: "user", content: "<review_request>…</review_request>", timestamp: 1_000 },
				fauxAssistantMessage(
					[
						fauxThinking(`The reconnect masks a drop. ${"t".repeat(20_000)}`),
						fauxText("Reading the connector."),
						fauxToolCall("review_file", { path: "src/connector.ts" }, { id: "call-1" }),
					],
					{ stopReason: "toolUse", timestamp: 2_000 },
				),
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "review_file",
					content: [
						{ type: "text", text: "r".repeat(10_000) },
						{ type: "image", data: "AAAA", mimeType: "image/png" },
					],
					isError: false,
					timestamp: 3_000,
				},
				fauxAssistantMessage([{ type: "thinking", thinking: "", redacted: true }]),
				{ role: "custom", customType: "note", content: "not a model message", display: false, timestamp: 4_000 },
			],
			report,
			repairErrors: ["candidates[0] anchor is outside the change"],
		});

		const records = readRecords((await diagnostics.flush())!);
		expect(records.map((record) => record.kind)).toEqual([
			"pass_message",
			"pass_message",
			"pass_message",
			"pass_message",
			"pass_message",
			"pass_end",
		]);
		expect(records[0]).toMatchObject({
			phase: "discovery",
			passId: 1,
			round: 1,
			index: 0,
			timestamp: new Date(1_000).toISOString(),
			message: { role: "user", text: "<review_request>…</review_request>" },
		});
		const [thinking, text, toolCall] = (records[1]!.message as { content: Array<Record<string, string>> }).content;
		expect(thinking).toMatchObject({
			type: "thinking",
			thinking: expect.stringMatching(/^The reconnect masks a drop\..*…$/),
		});
		expect(Buffer.byteLength(thinking!.thinking!, "utf8")).toBeLessThanOrEqual(16_000);
		expect(text).toEqual({ type: "text", text: "Reading the connector." });
		expect(toolCall).toEqual({
			type: "toolCall",
			id: "call-1",
			name: "review_file",
			arguments: JSON.stringify({ path: "src/connector.ts" }),
		});
		expect(records[1]!.message).toMatchObject({ role: "assistant", stopReason: "toolUse" });
		expect(records[2]!.message).toMatchObject({
			role: "toolResult",
			toolName: "review_file",
			isError: false,
			text: expect.stringMatching(/…$/),
		});
		expect(Buffer.byteLength((records[2]!.message as { text: string }).text, "utf8")).toBeLessThanOrEqual(8_000);
		expect(records[3]!.message).toMatchObject({ content: [{ type: "thinking", thinking: "[redacted]" }] });
		expect(records[4]!.message).toEqual({ role: "custom", omitted: true });
		expect(records[5]).toMatchObject({
			kind: "pass_end",
			phase: "discovery",
			purpose: "findings",
			model: "faux/review-model",
			outcome: "completed",
			messageCount: 5,
			report,
			repairErrors: ["candidates[0] anchor is outside the change"],
		});
		expect(records[5]).not.toHaveProperty("omittedMessages");
	});

	it("counts messages past the run's transcript budget and still keeps every pass's end and the verifier conclusion", async () => {
		vi.stubEnv(REVIEW_PRIVATE_DIAGNOSTICS_ENV, "1");
		const diagnostics = createReviewPrivateDiagnostics({
			agentDir: createAgentDir(),
			workflowId: "review:transcript-budget",
			workflowAction: "review.pr",
		});
		const messages = Array.from({ length: 300 }, () => fauxAssistantMessage("m".repeat(16_000)));
		diagnostics.recordPass({
			identity: { passId: 1, phase: "discovery", purpose: "findings", round: 1 },
			model: "faux/model",
			outcome: "completed",
			messages,
			report: { summary: "discovery report" },
		});
		for (let index = 0; index < 110; index++) {
			diagnostics.recordToolFailure("verification", { toolName: "review_file", result: {} });
		}
		diagnostics.recordPass({
			identity: { passId: 2, phase: "verification", purpose: "findings", round: 1 },
			model: "faux/model",
			outcome: "failed",
			messages: messages.slice(0, 3),
		});
		diagnostics.recordVerificationAssessment({ assessment: "complete" });

		const records = readRecords((await diagnostics.flush())!);
		const transcriptBytes = records
			.filter((record) => record.kind === "pass_message")
			.reduce((sum, record) => sum + Buffer.byteLength(JSON.stringify(record), "utf8"), 0);
		expect(transcriptBytes).toBeLessThanOrEqual(MAX_REVIEW_PASS_TRANSCRIPT_BYTES);
		const kept = records.filter((record) => record.kind === "pass_message" && record.passId === 1).length;
		expect(kept).toBeGreaterThan(0);
		expect(records.filter((record) => record.kind === "pass_end")).toEqual([
			expect.objectContaining({
				passId: 1,
				messageCount: 300,
				omittedMessages: 300 - kept,
				report: { summary: "discovery report" },
			}),
			expect.objectContaining({ passId: 2, outcome: "failed", messageCount: 3, omittedMessages: 3 }),
		]);
		expect(records.filter((record) => record.kind === "tool_failure").length).toBe(99);
		expect(records).toContainEqual(
			expect.objectContaining({ kind: "verification_assessment", assessment: "complete" }),
		);
	});

	it("retains only the newest bounded set of per-run files", async () => {
		vi.stubEnv(REVIEW_PRIVATE_DIAGNOSTICS_ENV, "true");
		const agentDir = createAgentDir();
		for (let index = 0; index <= MAX_RETAINED_REVIEW_PRIVATE_DIAGNOSTIC_FILES; index++) {
			const diagnostics = createReviewPrivateDiagnostics({
				agentDir,
				workflowId: `review:retention-${index}`,
				workflowAction: "review.pr",
			});
			diagnostics.recordModelLimitations("discovery", [`limitation ${index}`]);
			await diagnostics.flush();
		}

		expect(readdirSync(getReviewPrivateDiagnosticsDirectory(agentDir))).toHaveLength(
			MAX_RETAINED_REVIEW_PRIVATE_DIAGNOSTIC_FILES,
		);
	});
});
