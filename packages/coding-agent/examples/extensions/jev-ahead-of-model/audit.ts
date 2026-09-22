import type {
	ExtensionContext,
	ExtensionWorkContribution,
	ExtensionWorkStatus,
	ExtensionWorkTaskContext,
	JsonValue,
	SessionEntry,
} from "@hansjm10/volt-coding-agent";
import type { JevResult } from "./client.ts";
import type { AheadReport } from "./index.ts";
import { MAX_AHEAD_EVALUATIONS } from "./limits.ts";
import type { AheadStage } from "./pipeline.ts";

export const AHEAD_AUDIT_TYPE = "jev-ahead-audit";

export interface AheadEvaluationAudit {
	cycle: number;
	stage: AheadStage;
	attempt: number;
	startedAt: string;
	questions: number;
	/** Exact bounded JSON body, captured before credential resolution. Never includes HTTP headers. */
	requestBody?: string;
	dispatchedAt?: string;
	finishedAt?: string;
	result?: JevResult;
}

export interface AheadAudit {
	requestId: string;
	sessionId: string;
	branchId: string;
	runtimeId: string;
	startedAt: string;
	sealedAt: string;
	reason: "agent_end" | "session_shutdown" | "superseded" | "disabled";
	/** Work had not drained at sealing. Missing results are unobserved, never assumed successful. */
	interrupted: boolean;
	evaluations: AheadEvaluationAudit[];
	publications: Array<{
		cycle: number;
		contribution: ExtensionWorkContribution;
		publishedAt?: string;
		omittedReason?: "foreground_read";
		/** Absent when omitted, sealing preceded publication, or a publication result was not observed. */
		result?: ReturnType<ExtensionWorkTaskContext["context"]["put"]>;
	}>;
	report: AheadReport;
	finalContributions?: ExtensionWorkStatus["contributions"];
}

/** Only these validated fields are rendered as text; details remain escaped JSON. */
function auditData(entry: SessionEntry): Record<string, JsonValue> | undefined {
	if (entry.type !== "custom" || entry.customType !== AHEAD_AUDIT_TYPE) return;
	const data = entry.data;
	if (
		!data ||
		typeof data !== "object" ||
		Array.isArray(data) ||
		typeof data.requestId !== "string" ||
		!/^[a-zA-Z0-9_-]{1,128}$/.test(data.requestId) ||
		typeof data.startedAt !== "string" ||
		!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(data.startedAt) ||
		typeof data.interrupted !== "boolean" ||
		!Array.isArray(data.evaluations) ||
		data.evaluations.length > MAX_AHEAD_EVALUATIONS
	)
		return;
	return data;
}

export function auditText(ctx: ExtensionContext, entryId?: string): string {
	const entries = ctx.sessionManager.getEntries();
	if (entryId !== undefined) {
		const entry =
			entryId === "latest" ? entries.findLast((item) => auditData(item)) : ctx.sessionManager.getEntry(entryId);
		const data = entry && auditData(entry);
		return data ? JSON.stringify(data, null, 2) : "No matching Ahead audit in this session.";
	}
	const lines = [
		`Ahead audit history: latest 10 requests across this session's branches. ${ctx.sessionManager.getSessionRef() ? "SQLite session." : "In-memory session; not durable."}`,
	];
	for (const entry of entries
		.filter((item) => auditData(item))
		.slice(-10)
		.reverse()) {
		const data = auditData(entry)!;
		lines.push(
			`${entry.id} · ${data.startedAt} · ${(data.evaluations as JsonValue[]).length} evaluations${data.interrupted ? " · interrupted; results may be incomplete" : ""} · request ${data.requestId}`,
		);
	}
	if (lines.length === 1) lines.push("No saved Ahead audits.");
	lines.push(
		"Use /ahead audit <entry-id> for exact inputs, results, decisions and admission observations; /ahead audit shows the latest.",
	);
	return lines.join("\n");
}
