/**
 * Private diagnostics of a review run, for auditing how a review reached its result: what each pass read,
 * reasoned, ran, and reported (candidates with their prose, the verifier's accept/reject decisions), which the
 * durable review record leaves out. They are written by default to one owner-only JSONL file per run under the
 * agent directory's `review-diagnostics`, keeping the newest files only; `VOLT_REVIEW_PRIVATE_DIAGNOSTICS=0`
 * turns them off. They never reach the review's work, handoff, session, or remote clients.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "@hansjm10/volt-agent-core";
import type { ImageContent, TextContent } from "@hansjm10/volt-ai";
import { ensurePrivateDirectorySync, writePrivateNewFile } from "../utils/private-files.ts";
import type { ReviewPass } from "./review.ts";
import type { ReviewVerificationReport } from "./review-report.ts";
import type { ReviewUsageAttempt } from "./review-usage.ts";
import { writeWindowsReviewDiagnostic } from "./windows-review-private-diagnostics.ts";

export const REVIEW_PRIVATE_DIAGNOSTICS_ENV = "VOLT_REVIEW_PRIVATE_DIAGNOSTICS";
export const MAX_RETAINED_REVIEW_PRIVATE_DIAGNOSTIC_FILES = 20;
/** The most bytes of pass transcript messages one run's file keeps; later messages are counted, not kept. */
export const MAX_REVIEW_PASS_TRANSCRIPT_BYTES = 4_000_000;

/** The most records of every kind but transcript messages. */
const MAX_PRIVATE_DIAGNOSTIC_RECORDS = 100;
const MAX_PRIVATE_DIAGNOSTIC_MESSAGE_BYTES = 4_000;
/** The most bytes kept of a prompt, a reasoning block, or a reply in a pass transcript. */
const MAX_TRANSCRIPT_TEXT_BYTES = 16_000;
/** The most bytes kept of a tool call's arguments or a tool result in a pass transcript. */
const MAX_TRANSCRIPT_TOOL_BYTES = 8_000;
const PRIVATE_DIAGNOSTIC_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[a-f0-9]{16}\.jsonl$/;

interface ReviewPrivateDiagnosticBase {
	schemaVersion: 1;
	timestamp: string;
	runId: string;
	workflowAction: string;
	phase: ReviewPass;
}

type ReviewPassTranscriptPart =
	| { type: "thinking"; thinking: string }
	| { type: "text"; text: string }
	| { type: "toolCall"; id: string; name: string; arguments: string };

/** A message of a pass's conversation, bounded; a runtime message that is not a model message keeps its role only. */
type ReviewPassTranscriptMessage =
	| { role: "user"; text: string }
	| { role: "assistant"; content: ReviewPassTranscriptPart[]; stopReason: string; error?: string }
	| { role: "toolResult"; toolCallId: string; toolName: string; isError: boolean; text: string }
	| { role: string; omitted: true };

type ReviewPassIdentity = Omit<ReviewUsageAttempt, "attempt" | "kind">;

type ReviewPrivateDiagnosticRecord =
	| (ReviewPrivateDiagnosticBase & {
			kind: "verification_assessment";
			assessment: ReviewVerificationReport["assessment"];
			challenge?: string;
	  })
	| (ReviewPrivateDiagnosticBase & {
			kind: "model_limitation";
			message: string;
	  })
	| (ReviewPrivateDiagnosticBase & {
			kind: "tool_failure";
			toolName: string;
			command?: string;
			result?: string;
	  })
	| (ReviewPrivateDiagnosticBase & {
			kind: "pass_message";
			passId: number;
			round: number;
			index: number;
			message: ReviewPassTranscriptMessage;
	  })
	| (ReviewPrivateDiagnosticBase & {
			kind: "pass_end";
			passId: number;
			round: number;
			purpose: ReviewPassIdentity["purpose"];
			model: string;
			outcome: ReviewPassTranscript["outcome"];
			messageCount: number;
			/** Messages left out once the run's transcript budget was spent. */
			omittedMessages?: number;
			report?: unknown;
			repairErrors?: string[];
	  });

/** What a review pass ran: its conversation, and the report it submitted last (valid or not). */
export interface ReviewPassTranscript {
	readonly identity: ReviewPassIdentity;
	/** `provider/id` of the pass's model. */
	readonly model: string;
	readonly outcome: "completed" | "failed" | "aborted";
	readonly messages: readonly AgentMessage[];
	readonly report?: unknown;
	/** What the host sent the pass back to repair, when its first report was missing or invalid. */
	readonly repairErrors?: readonly string[];
}

export interface ReviewPrivateDiagnostics {
	recordVerificationAssessment(report: Pick<ReviewVerificationReport, "assessment" | "challenge">): void;
	recordModelLimitations(phase: ReviewPass, limitations: readonly string[]): void;
	recordToolFailure(phase: ReviewPass, failure: { toolName: string; command?: string; result: unknown }): void;
	recordPass(pass: ReviewPassTranscript): void;
	flush(): Promise<string | undefined>;
}

function truncateUtf8(value: string, maximumBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
	const suffix = "…";
	let truncated = Buffer.from(value, "utf8")
		.subarray(0, maximumBytes - Buffer.byteLength(suffix, "utf8"))
		.toString("utf8");
	while (Buffer.byteLength(truncated + suffix, "utf8") > maximumBytes) truncated = truncated.slice(0, -1);
	return truncated + suffix;
}

function toolResultText(result: unknown): string | undefined {
	if (typeof result !== "object" || result === null || !("content" in result) || !Array.isArray(result.content)) {
		return undefined;
	}
	const text = result.content
		.flatMap((entry) =>
			typeof entry === "object" &&
			entry !== null &&
			"type" in entry &&
			entry.type === "text" &&
			"text" in entry &&
			typeof entry.text === "string"
				? [entry.text]
				: [],
		)
		.join("\n")
		.trim();
	return text ? truncateUtf8(text, MAX_PRIVATE_DIAGNOSTIC_MESSAGE_BYTES) : undefined;
}

function contentText(content: string | readonly (TextContent | ImageContent)[], maximumBytes: number): string {
	const text =
		typeof content === "string"
			? content
			: content.map((part) => (part.type === "text" ? part.text : `[${part.mimeType} image]`)).join("\n");
	return truncateUtf8(text, maximumBytes);
}

function transcriptMessage(message: AgentMessage): ReviewPassTranscriptMessage {
	switch (message.role) {
		case "user":
			return { role: "user", text: contentText(message.content, MAX_TRANSCRIPT_TEXT_BYTES) };
		case "assistant":
			return {
				role: "assistant",
				content: message.content.map((part): ReviewPassTranscriptPart => {
					if (part.type === "thinking") {
						return {
							type: "thinking",
							thinking: part.redacted ? "[redacted]" : truncateUtf8(part.thinking, MAX_TRANSCRIPT_TEXT_BYTES),
						};
					}
					if (part.type === "text")
						return { type: "text", text: truncateUtf8(part.text, MAX_TRANSCRIPT_TEXT_BYTES) };
					return {
						type: "toolCall",
						id: part.id,
						name: part.name,
						arguments: truncateUtf8(JSON.stringify(part.arguments), MAX_TRANSCRIPT_TOOL_BYTES),
					};
				}),
				stopReason: message.stopReason,
				...(message.error
					? { error: truncateUtf8(message.error.message, MAX_PRIVATE_DIAGNOSTIC_MESSAGE_BYTES) }
					: {}),
			};
		case "toolResult":
			return {
				role: "toolResult",
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				isError: message.isError,
				text: contentText(message.content, MAX_TRANSCRIPT_TOOL_BYTES),
			};
		default:
			return { role: message.role, omitted: true };
	}
}

async function prunePrivateDiagnosticFiles(directoryPath: string): Promise<void> {
	const files = (await readdir(directoryPath, { withFileTypes: true }))
		.filter((entry) => entry.isFile() && PRIVATE_DIAGNOSTIC_FILE_PATTERN.test(entry.name))
		.sort((left, right) => right.name.localeCompare(left.name));
	await Promise.all(
		files
			.slice(MAX_RETAINED_REVIEW_PRIVATE_DIAGNOSTIC_FILES)
			.map((entry) => rm(join(directoryPath, entry.name), { force: true })),
	);
}

export function getReviewPrivateDiagnosticsDirectory(agentDir: string): string {
	return join(agentDir, "review-diagnostics");
}

/** Private diagnostics of the review run `workflowId`: kept unless `VOLT_REVIEW_PRIVATE_DIAGNOSTICS` is `0` or `false`. */
export function createReviewPrivateDiagnostics(options: {
	agentDir: string;
	workflowId?: string;
	workflowAction?: string;
}): ReviewPrivateDiagnostics {
	const setting = process.env[REVIEW_PRIVATE_DIAGNOSTICS_ENV]?.trim().toLowerCase();
	if (setting === "0" || setting === "false" || !options.workflowId || !options.workflowAction) {
		return {
			recordVerificationAssessment: () => {},
			recordModelLimitations: () => {},
			recordToolFailure: () => {},
			recordPass: () => {},
			flush: () => Promise.resolve(undefined),
		};
	}

	const runId = options.workflowId;
	const workflowAction = options.workflowAction;
	const records: ReviewPrivateDiagnosticRecord[] = [];
	const createdAt = new Date();
	let flushPromise: Promise<string | undefined> | undefined;
	/**
	 * Limitations, tool failures, and assessments. Transcript messages have a byte budget of their own, and a pass's
	 * end (with its report) is kept for every pass.
	 */
	let boundedRecords = 0;
	let transcriptBytes = 0;
	const append = (record: ReviewPrivateDiagnosticRecord): void => {
		if (boundedRecords < MAX_PRIVATE_DIAGNOSTIC_RECORDS) {
			records.push(record);
			boundedRecords++;
			return;
		}
		// Preserve the verifier's conclusion even if earlier tool failures filled the log.
		if (record.kind !== "verification_assessment") return;
		const last = records.findLastIndex(
			(candidate) => candidate.kind !== "pass_message" && candidate.kind !== "pass_end",
		);
		if (last >= 0) records[last] = record;
	};
	const baseRecord = (phase: ReviewPass, timestamp = new Date()): ReviewPrivateDiagnosticBase => ({
		schemaVersion: 1,
		timestamp: timestamp.toISOString(),
		runId,
		workflowAction,
		phase,
	});

	return {
		recordVerificationAssessment(report) {
			append({
				...baseRecord("verification"),
				kind: "verification_assessment",
				assessment: report.assessment,
				...(report.challenge
					? { challenge: truncateUtf8(report.challenge, MAX_PRIVATE_DIAGNOSTIC_MESSAGE_BYTES) }
					: {}),
			});
		},
		recordModelLimitations(phase, limitations) {
			for (const limitation of limitations) {
				append({
					...baseRecord(phase),
					kind: "model_limitation",
					message: truncateUtf8(limitation, MAX_PRIVATE_DIAGNOSTIC_MESSAGE_BYTES),
				});
			}
		},
		recordToolFailure(phase, failure) {
			const result = toolResultText(failure.result);
			append({
				...baseRecord(phase),
				kind: "tool_failure",
				toolName: truncateUtf8(failure.toolName, 200),
				...(failure.command
					? { command: truncateUtf8(failure.command, MAX_PRIVATE_DIAGNOSTIC_MESSAGE_BYTES) }
					: {}),
				...(result ? { result } : {}),
			});
		},
		recordPass(pass) {
			const { phase, passId, round, purpose } = pass.identity;
			let kept = 0;
			for (const [index, message] of pass.messages.entries()) {
				const sent =
					"timestamp" in message && Number.isFinite(message.timestamp) ? new Date(message.timestamp) : undefined;
				const record: ReviewPrivateDiagnosticRecord = {
					...baseRecord(phase, sent),
					kind: "pass_message",
					passId,
					round,
					index,
					message: transcriptMessage(message),
				};
				const bytes = Buffer.byteLength(JSON.stringify(record), "utf8");
				if (transcriptBytes + bytes > MAX_REVIEW_PASS_TRANSCRIPT_BYTES) break;
				transcriptBytes += bytes;
				records.push(record);
				kept++;
			}
			const omittedMessages = pass.messages.length - kept;
			records.push({
				...baseRecord(phase),
				kind: "pass_end",
				passId,
				round,
				purpose,
				model: pass.model,
				outcome: pass.outcome,
				messageCount: pass.messages.length,
				...(omittedMessages > 0 ? { omittedMessages } : {}),
				...(pass.report === undefined ? {} : { report: structuredClone(pass.report) }),
				...(pass.repairErrors && pass.repairErrors.length > 0
					? {
							repairErrors: pass.repairErrors.map((error) =>
								truncateUtf8(error, MAX_PRIVATE_DIAGNOSTIC_MESSAGE_BYTES),
							),
						}
					: {}),
			});
		},
		flush() {
			if (flushPromise) return flushPromise;
			flushPromise = (async () => {
				if (records.length === 0) return undefined;
				const directoryPath = getReviewPrivateDiagnosticsDirectory(options.agentDir);
				const timestamp = createdAt.toISOString().replace(/[:.]/g, "-");
				const runHash = createHash("sha256").update(runId).digest("hex").slice(0, 16);
				const filePath = join(directoryPath, `${timestamp}_${runHash}.jsonl`);
				const content = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
				if (process.platform === "win32") {
					await writeWindowsReviewDiagnostic(filePath, content);
				} else {
					ensurePrivateDirectorySync(directoryPath);
					await writePrivateNewFile(filePath, content);
				}
				await prunePrivateDiagnosticFiles(directoryPath);
				return filePath;
			})();
			return flushPromise;
		},
	};
}
