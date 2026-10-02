import { auditLsp, type LspAuditOptions, type LspAuditReport } from "../core/session-store/lsp-audit.ts";

export const LSP_AUDIT_HELP = `Usage: volt lsp audit [--json | --format text|json] [--since <ISO date>] [--until <ISO date>]
                      [--session-dir <directory>] [--all-workspaces]

Offline, read-only LSP usage and outcome audit. Defaults to the last 14 days
in the canonical current workspace. --until is exclusive. --session-dir
selects an existing sessions.sqlite directory; --all-workspaces includes all
workspaces in that directory, or all default stores when no directory is set.
No authentication, provider requests, or language servers are started.
Reports are bounded and content-free; incomplete coverage is reported explicitly.
Exit status: 0 complete, 2 partial coverage/invalid arguments, 130 cancelled.`;

export function parseLspAuditArgs(args: string[]): { options: LspAuditOptions; json: boolean; help: boolean } {
	const options: LspAuditOptions = {};
	let json = false;
	let help = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--json") json = true;
		else if (arg === "--all-workspaces") options.allWorkspaces = true;
		else if (arg === "--help" || arg === "-h") help = true;
		else if (["--since", "--until", "--session-dir", "--format"].includes(arg)) {
			const value = args[++i];
			if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
			if (arg === "--since") options.since = value;
			else if (arg === "--until") options.until = value;
			else if (arg === "--session-dir") options.sessionDir = value;
			else {
				if (value !== "text" && value !== "json") throw new Error("--format must be text or json.");
				json = value === "json";
			}
		} else throw new Error("Unknown LSP audit option. Run volt lsp audit --help.");
	}
	return { options, json, help };
}

export function formatLspAudit(report: LspAuditReport): string {
	const counts = (values: Record<string, number>) =>
		Object.entries(values)
			.map(([key, value]) => `${key}=${value}`)
			.join(", ") || "none";
	const lines = [
		`LSP audit: ${report.window.since} to ${report.window.until} (until exclusive)`,
		`Scope: ${report.scope}; coverage: ${report.coverage.partial ? "PARTIAL" : "complete"}${report.coverage.cancelled ? " (cancelled)" : ""}`,
		`Stores: ${report.coverage.storesRead}/${report.coverage.storesDiscovered}; skipped: ${counts(report.coverage.skippedStores)}`,
		`Scanned: ${report.coverage.sessionsScanned} sessions, ${report.coverage.entriesScanned} entries, ${report.coverage.bytesScanned} bytes; oversized: ${report.coverage.oversizedEntries}`,
		`Limits: ${counts(report.coverage.limits)}; reached: ${report.coverage.limitsReached.join(", ") || "none"}`,
		`Operations: ${report.totals.operations}; explicit: ${report.totals.explicit}; automatic: ${report.totals.automatic}`,
		`Tool-active conversations: ${report.utilization.toolActiveConversations}; explicit LSP: ${report.utilization.withExplicitLsp}; automatic LSP: ${report.utilization.withAutomaticLsp}; any LSP: ${report.utilization.withAnyLsp}`,
		`Utilization: explicit=${report.utilization.explicitRate === null ? "unknown" : `${(report.utilization.explicitRate * 100).toFixed(1)}%`}; any=${report.utilization.anyRate === null ? "unknown" : `${(report.utilization.anyRate * 100).toFixed(1)}%`}`,
		`Root conversations: ${report.utilization.cohorts.root.withLsp}/${report.utilization.cohorts.root.toolActive}; subagent conversations: ${report.utilization.cohorts.subagent.withLsp}/${report.utilization.cohorts.subagent.toolActive}`,
		report.utilization.definition,
		`Outcomes: ${counts(report.totals.outcomes)}`,
		`Reasons: ${counts(report.totals.reasons)}`,
		`Freshness: ${counts(report.totals.freshness)}; source: ${counts(report.totals.sources)}`,
		`Startup failures: ${report.totals.startupFailures}; diagnostics: ${report.totals.diagnosticCount}; results: ${report.totals.resultCount}`,
	];
	for (const [label, groups] of [
		["Action", report.byAction],
		["Language", report.byLanguage],
		["Day", report.byDay],
		["Cohort", report.byCohort],
	] as const) {
		for (const [key, value] of Object.entries(groups))
			lines.push(
				`${label} ${key}: ${value.operations} (explicit=${value.explicit}, automatic=${value.automatic}); outcomes ${counts(value.outcomes)}; reasons ${counts(value.reasons)}; freshness ${counts(value.freshness)}`,
			);
	}
	for (const [key, value] of Object.entries(report.latencyMs))
		lines.push(
			`Latency ${key} (ms): n=${value.samples}, p50=${value.p50 ?? "unknown"}, p95=${value.p95 ?? "unknown"}`,
		);
	lines.push(
		report.latencyDefinition,
		`Uninstrumented: explicit=${report.uninstrumented.explicit}, edit/write checks unknown=${report.uninstrumented.automaticChecksUnknown}; historical outcomes unknown`,
		`Context only: grep=${report.contextOnly.grepResults}, bash=${report.contextOnly.bashResults}. ${report.contextOnly.note}`,
		`Deduplication: ${report.deduplication.copiesRemoved} copies removed; original context unavailable=${report.deduplication.originalContextUnavailable}. ${report.deduplication.definition}`,
	);
	return lines.join("\n");
}

/** Returns false for other CLI commands, before any normal startup work. */
export async function handleLspAuditCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "lsp" || args[1] !== "audit") return false;
	const controller = new AbortController();
	const abort = () => controller.abort();
	try {
		const parsed = parseLspAuditArgs(args.slice(2));
		if (parsed.help) {
			console.log(LSP_AUDIT_HELP);
			return true;
		}
		process.once("SIGINT", abort);
		process.once("SIGTERM", abort);
		const report = await auditLsp({ ...parsed.options, signal: controller.signal });
		console.log(parsed.json ? JSON.stringify(report, null, 2) : formatLspAudit(report));
		process.exitCode = report.coverage.cancelled ? 130 : report.coverage.partial ? 2 : 0;
	} catch (error) {
		console.error(error instanceof Error ? error.message : "LSP audit failed.");
		process.exitCode = 2;
	} finally {
		process.removeListener("SIGINT", abort);
		process.removeListener("SIGTERM", abort);
	}
	return true;
}
