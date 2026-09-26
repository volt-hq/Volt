/**
 * Config-driven multi-server LSP manager.
 *
 * Routes files to language servers by extension, lazily spawns one client per
 * (server, project root), and formats post-mutation diagnostics for tool
 * results. Server start failures are reported once and then suppressed.
 */

import { lstatSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalizePath, resolvePath } from "../../utils/paths.ts";
import type { HostInteraction } from "../host-interaction.ts";
import type { ToolDiagnosticsProvider } from "../tools/diagnostics-provider.ts";
import type { LspNavigationProvider } from "../tools/lsp.ts";
import type { LspClient, LspDiagnostic, LspDiagnosticResult, LspPosition, LspRange } from "./client.ts";
import type { LspLaunchSource } from "./command-resolver.ts";
import {
	type LspInstallRecipe,
	languageIdForExtension,
	type ResolvedLspConfig,
	type ResolvedLspServerConfig,
	SEVERITY_NAMES,
} from "./config.ts";
import {
	type DiagnosticFeedbackSnapshot,
	LspDiagnosticFeedback,
	MAX_AUTOMATIC_REPORT_BYTES,
} from "./diagnostic-feedback.ts";
import { isManagedLspObservation, recordManagedLspLocations, recordManagedLspSymbols } from "./managed-observation.ts";
import {
	LspOperationError,
	type LspProjectContext,
	type LspResult,
	lspErrorResult,
	lspResult,
	lspSucceeded,
} from "./outcome.ts";
import { swiftContextCaveat, swiftProjectContext } from "./project-context.ts";
import {
	canonicalizeLspPath,
	effectiveInstallRecipe,
	installRecipeIdentity,
	isPathAtOrInside,
	type LspFailureNotice,
	type LspInstallAttemptResult,
	type LspInstallInitiator,
	type LspInstallRunner,
	LspServerCore,
	type LspServerCoreSubscriber,
	type LspServerLease,
	type LspStartFailureEvent,
	lspServerKey,
	MAX_START_ATTEMPTS,
	MissingLspExecutableError,
	type ServerFailureState,
	UnusableLspExecutableError,
} from "./server-core.ts";
import { type LspWorkspaceEdit, normalizeWorkspaceEdit } from "./workspace-edit.ts";
import type { WorkspaceEditApplyResult, WorkspaceEditDocumentSnapshot } from "./workspace-edit-applier.ts";

export {
	type LspInstallCommandOptions,
	type LspInstallCommandResult,
	type LspInstallRunner,
	runDefaultLspInstallCommand,
} from "./server-core.ts";

export interface LspManagerOptions {
	/** Runtime cwd used only to shorten displayed tool paths. */
	cwd: string;
	/**
	 * Default project root and base for commands/traces, not an access boundary. Defaults to cwd.
	 * Ignored with `server`, whose core already fixes the project root.
	 */
	projectCwd?: string;
	config: ResolvedLspConfig;
	hostInteraction?: HostInteraction;
	/** Used only for a private core; a shared core keeps the runner it was created with. */
	installRunner?: LspInstallRunner;
	/** Host-owned live policy; false in restricted modes. Checked again after consent. */
	installAllowed?: () => boolean;
	/**
	 * Shared server state from LspServerPool. The manager takes ownership of the
	 * lease and releases it on dispose. Without it, the manager owns a private core.
	 */
	server?: LspServerLease;
}

export interface LspServerStatus {
	name: string;
	/** Canonical session project directory used as the command/trace base. */
	workspaceRoot: string;
	/** Canonical project root used to initialize this server client, possibly outside workspaceRoot. */
	root: string;
	alive: boolean;
	openDocuments: number;
	/** Milliseconds since the server was last used */
	idleMs: number;
	resolvedExecutable?: string;
	unresolvedCommand?: string;
	launchSource: LspLaunchSource;
	attempts: number;
	lastError?: string;
	state?: "unused" | "disabled" | "starting" | "ready" | "degraded" | "failed" | "blocked" | "idle";
	version?: string;
	serverInfo?: { name: string; version?: string };
	capabilities?: string[];
	lastSuccess?: string;
	lastFailure?: string;
	requestError?: string;
	startupStderr?: string;
	breaker?: "closed" | "open";
	operations?: number;
	failures?: number;
	totalDurationMs?: number;
	lastDurationMs?: number;
	coverage?: string;
	projectContext?: LspProjectContext;
}

/** Internal display evidence; diagnostic reports must survive health-warning suppression. */
interface LspOperationResult extends LspResult {
	diagnosticsText?: string;
}

type LspClientErrorResult = { retry: true } | { retry: false; message?: string; failure?: LspResult };

const MAX_REFERENCES = 50;
const MAX_SYMBOL_LINES = 200;

function pathEntryExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

const SYMBOL_KIND_NAMES: Record<number, string> = {
	1: "file",
	2: "module",
	3: "namespace",
	4: "package",
	5: "class",
	6: "method",
	7: "property",
	8: "field",
	9: "constructor",
	10: "enum",
	11: "interface",
	12: "function",
	13: "variable",
	14: "constant",
	15: "string",
	16: "number",
	17: "boolean",
	18: "array",
	19: "object",
	20: "key",
	21: "null",
	22: "enum member",
	23: "struct",
	24: "event",
	25: "operator",
	26: "type parameter",
};

interface LspLocation {
	uri: string;
	range: LspRange;
}

interface LspLocationLink {
	targetUri: string;
	targetRange: LspRange;
	targetSelectionRange?: LspRange;
}

interface LspDocumentSymbol {
	name: string;
	kind: number;
	range?: LspRange;
	selectionRange?: LspRange;
	location?: { uri?: string; range: LspRange };
	children?: LspDocumentSymbol[];
}

interface LspHoverResult {
	contents: unknown;
}

interface CallHierarchyItem {
	name: string;
	kind: number;
	uri: string;
	range: LspRange;
	selectionRange?: LspRange;
}

interface LspCommand {
	title?: string;
	command: string;
	arguments?: unknown[];
}

interface LspCodeAction {
	title: string;
	kind?: string;
	edit?: LspWorkspaceEdit;
	command?: LspCommand;
}

interface NormalizedCodeAction {
	title: string;
	kind?: string;
	edit?: LspWorkspaceEdit;
	command?: LspCommand;
	/** Raw action payload, used for codeAction/resolve */
	raw: unknown;
}

function positionLeq(a: LspPosition, b: LspPosition): boolean {
	return a.line < b.line || (a.line === b.line && a.character <= b.character);
}

function rangesOverlap(a: LspRange, b: LspRange): boolean {
	return positionLeq(a.start, b.end) && positionLeq(b.start, a.end);
}

/** Normalize codeAction results: bare Commands and CodeAction literals. */
function normalizeCodeActions(result: unknown): NormalizedCodeAction[] {
	if (!Array.isArray(result)) {
		return [];
	}
	const actions: NormalizedCodeAction[] = [];
	for (const item of result) {
		if (!item || typeof item !== "object" || typeof (item as { title?: unknown }).title !== "string") {
			continue;
		}
		const entry = item as LspCodeAction & { command?: LspCommand | string };
		if (typeof entry.command === "string") {
			// Bare Command shape.
			actions.push({ title: entry.title, command: entry as unknown as LspCommand, raw: item });
		} else {
			actions.push({ title: entry.title, kind: entry.kind, edit: entry.edit, command: entry.command, raw: item });
		}
	}
	return actions;
}

type DocumentSession = { error: LspResult } | { client: LspClient; uri: string; content: string; absolutePath: string };

/** Normalize definition results: Location | Location[] | LocationLink[] | null. */
function normalizeLocations(result: unknown): LspLocation[] {
	if (!result) {
		return [];
	}
	const items = Array.isArray(result) ? result : [result];
	const locations: LspLocation[] = [];
	for (const item of items) {
		const location = item as Partial<LspLocation> & Partial<LspLocationLink>;
		if (typeof location.uri === "string" && location.range) {
			locations.push({ uri: location.uri, range: location.range });
		} else if (typeof location.targetUri === "string") {
			const range = location.targetSelectionRange ?? location.targetRange;
			if (range) {
				locations.push({ uri: location.targetUri, range });
			}
		}
	}
	return locations;
}

/** Extract plain text from LSP hover contents (string | MarkedString[] | MarkupContent). */
function hoverContentsToText(contents: unknown): string {
	if (typeof contents === "string") {
		return contents;
	}
	if (Array.isArray(contents)) {
		return contents
			.map((entry) => hoverContentsToText(entry))
			.filter((text) => text.length > 0)
			.join("\n\n");
	}
	if (contents && typeof contents === "object" && "value" in contents) {
		const value = (contents as { value: unknown }).value;
		return typeof value === "string" ? value : "";
	}
	return "";
}

/**
 * Locate a symbol occurrence in document text.
 *
 * Prefers a word-boundary match on the hinted line, then a word-boundary match
 * anywhere in the file, then plain substring matches.
 */
function findSymbolPosition(content: string, symbol: string, line?: number): LspPosition | undefined {
	const lines = content.split("\n");
	const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const wordPattern = new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`);

	const searchLine = (index: number): LspPosition | undefined => {
		const text = lines[index];
		if (text === undefined) {
			return undefined;
		}
		const wordMatch = wordPattern.exec(text);
		if (wordMatch) {
			return { line: index, character: wordMatch.index };
		}
		const plainIndex = text.indexOf(symbol);
		return plainIndex === -1 ? undefined : { line: index, character: plainIndex };
	};

	if (line !== undefined && line >= 1 && line <= lines.length) {
		const position = searchLine(line - 1);
		if (position) {
			return position;
		}
	}
	for (let index = 0; index < lines.length; index++) {
		const text = lines[index];
		const wordMatch = wordPattern.exec(text);
		if (wordMatch) {
			return { line: index, character: wordMatch.index };
		}
	}
	for (let index = 0; index < lines.length; index++) {
		const plainIndex = lines[index].indexOf(symbol);
		if (plainIndex !== -1) {
			return { line: index, character: plainIndex };
		}
	}
	return undefined;
}

/**
 * Per-session LSP view. Server processes and startup/failure accounting live in
 * an LspServerCore that may be shared with other sessions; delivery history,
 * failure reporting, host interaction, and install policy stay per view.
 */
export class LspManager implements ToolDiagnosticsProvider, LspNavigationProvider, LspServerCoreSubscriber {
	private cwd: string;
	private displayCwd: string;
	private projectCwd: string;
	private config: ResolvedLspConfig;
	private core: LspServerCore;
	private lease: LspServerLease;
	private unsubscribe: () => void;
	private automaticTransitions = new Map<string, { sequence: number; transition: string }>();
	private operationSequence = 0;
	private feedback = new LspDiagnosticFeedback();
	private feedbackSequence = 0;
	private contextTransitions = new Map<string, { sequence: number; context: LspProjectContext }>();
	/** First start failure this view reported per shared failure record; later ones stay silent. */
	private reportedFailures = new WeakMap<ServerFailureState, LspStartFailureEvent>();
	private hostInteraction: HostInteraction | undefined;
	private installAllowed: () => boolean;
	private installInitiator: LspInstallInitiator;
	private viewDisposed = false;
	/** Stops only this view's waits; the shared core keeps running. */
	private viewAbort = new AbortController();

	constructor(options: LspManagerOptions) {
		this.cwd = resolvePath(options.cwd);
		this.displayCwd = canonicalizePath(this.cwd);
		this.config = options.config;
		if (options.server) {
			this.lease = options.server;
		} else {
			const core = new LspServerCore({
				projectCwd: options.projectCwd ?? this.cwd,
				config: options.config,
				installRunner: options.installRunner,
			});
			this.lease = { core, release: () => core.dispose() };
		}
		this.core = this.lease.core;
		this.projectCwd = this.core.projectCwd;
		this.hostInteraction = options.hostInteraction;
		this.installAllowed = options.installAllowed ?? (() => true);
		this.installInitiator = {
			host: () => this.hostInteraction,
			installAllowed: () => this.installAllowed(),
		};
		this.unsubscribe = this.core.subscribe(this);
	}

	/** View or shared core disposed. */
	private get disposed(): boolean {
		return this.viewDisposed || this.core.isDisposed;
	}

	setHostInteraction(hostInteraction: HostInteraction | undefined): void {
		this.hostInteraction = hostInteraction;
	}

	/** @internal Core notification. */
	clientReplaced(key: string): void {
		this.feedback.forget(key);
	}

	/** @internal Core notification. */
	documentClosed(key: string, path: string): void {
		this.feedback.forget(key, path);
	}

	/** @internal Core notification. */
	restarted(): void {
		this.automaticTransitions.clear();
		this.feedback.clear();
		this.contextTransitions.clear();
	}

	/** @internal Core notification. */
	failuresReset(): void {
		this.automaticTransitions.clear();
	}

	private canonicalizeRequestedPath(inputPath: string): Promise<{ path: string } | { error: string }> {
		return canonicalizeLspPath(inputPath, this.cwd);
	}

	private async resolveLocationPath(uri: string): Promise<{ path: string } | { error: string }> {
		try {
			return await this.canonicalizeRequestedPath(fileURLToPath(uri));
		} catch {
			return { error: `Unsupported LSP document URI: ${uri}` };
		}
	}

	getWorkspaceRoot(): string {
		return this.projectCwd;
	}

	/** Status of all spawned language servers. */
	getStatus(): LspServerStatus[] {
		const now = Date.now();
		const keys = new Set([
			...this.core.clients.keys(),
			...this.core.startFailures.keys(),
			...this.core.launches.keys(),
		]);
		for (const server of [...this.config.servers, ...(this.config.disabledServers ?? [])]) {
			if (![...keys].some((key) => key.startsWith(`${server.name}\u0000`)))
				keys.add(this.serverKey(server.name, this.projectCwd));
		}
		return [...keys].map((key) => {
			const [name, root] = key.split("\u0000");
			const client = this.core.clients.get(key);
			const launch = this.core.launches.get(key);
			const failure = this.core.startFailures.get(key);
			const server = [...this.config.servers, ...(this.config.disabledServers ?? [])].find(
				(entry) => entry.name === name,
			);
			const disabled = !this.config.enabled || this.config.disabledServers?.some((entry) => entry.name === name);
			const metrics = this.core.metrics.get(key);
			const state: LspServerStatus["state"] = disabled
				? "disabled"
				: failure
					? failure.count >= MAX_START_ATTEMPTS
						? "blocked"
						: "failed"
					: client?.isReady
						? metrics?.requestError
							? "degraded"
							: "ready"
						: client?.isAlive
							? "starting"
							: client
								? "failed"
								: launch
									? launch.resolvedExecutable
										? "idle"
										: "blocked"
									: "unused";
			return {
				name,
				workspaceRoot: this.projectCwd,
				root,
				alive: client?.isAlive ?? false,
				state,
				breaker: failure && failure.count >= MAX_START_ATTEMPTS ? ("open" as const) : ("closed" as const),
				...this.core.startupEvidence.get(key),
				...(this.core.versions.has(key) ? { version: this.core.versions.get(key) } : {}),
				...(client?.getServerInfo() ? { serverInfo: client.getServerInfo() } : {}),
				...(client?.getCapabilities()
					? {
							capabilities: Object.keys(client.getCapabilities()!).filter((capability) =>
								Boolean(client.getCapabilities()![capability]),
							),
						}
					: {}),
				...(client?.getStartupStderr() ? { startupStderr: client.getStartupStderr() } : {}),
				...metrics,
				...this.projectContextEvidence(name, root),
				openDocuments: client?.openDocumentCount ?? 0,
				idleMs: now - (this.core.lastUsedAt.get(key) ?? now),
				...(launch?.resolvedExecutable
					? { resolvedExecutable: launch.resolvedExecutable }
					: {
							unresolvedCommand:
								launch?.unusableExecutable ?? launch?.requestedExecutable ?? server?.command[0] ?? "unknown",
						}),
				launchSource: launch?.source ?? "path",
				attempts: this.core.startAttempts.get(key) ?? 0,
				...(failure ? { lastError: failure.lastError } : {}),
			};
		});
	}

	async status(absolutePath?: string): Promise<LspResult> {
		let statuses = this.getStatus();
		if (absolutePath) {
			const canonical = await this.canonicalizeRequestedPath(absolutePath);
			if ("error" in canonical) return lspResult("invalid-input", canonical.error);
			const server =
				this.findServer(canonical.path) ??
				this.config.disabledServers?.find((entry) => entry.fileExtensions.includes(extname(canonical.path)));
			if (!server) return lspResult("success", this.noServerMessage(canonical.path), { reason: "no-server" });
			const root = this.findRoot(canonical.path, server.rootMarkers);
			statuses = statuses.filter((entry) => entry.name === server.name && entry.root === root);
			if (!statuses.length)
				statuses = [
					{
						name: server.name,
						workspaceRoot: this.projectCwd,
						root,
						state:
							!this.config.enabled || this.config.disabledServers?.some((entry) => entry.name === server.name)
								? "disabled"
								: "unused",
						alive: false,
						openDocuments: 0,
						idleMs: 0,
						attempts: 0,
						launchSource: "path",
						breaker: "closed",
						unresolvedCommand: server.command[0],
						...this.projectContextEvidence(server.name, root),
					},
				];
		}
		const text = statuses
			.map((entry) =>
				[
					`${entry.name}: ${entry.state} — ${entry.root}`,
					`  ${entry.resolvedExecutable ?? entry.unresolvedCommand} (${entry.launchSource}); version ${entry.version ?? entry.serverInfo?.version ?? "unknown"}; breaker ${entry.breaker}`,
					`  capabilities: ${entry.capabilities?.join(", ") || (entry.capabilities ? "none advertised" : "unknown")}`,
					`  operations ${entry.operations ?? 0}; failures ${entry.failures ?? 0}; last ${Math.round(entry.lastDurationMs ?? 0)}ms`,
					`  last success: ${entry.lastSuccess ?? "none"}; last failure: ${entry.lastFailure ?? "none"}`,
					...(entry.lastError ? [`  startup: ${entry.lastError}`] : []),
					...(entry.requestError ? [`  request: ${entry.requestError}`] : []),
					...(entry.projectContext ? [`  project context: ${entry.projectContext}`] : []),
					...(entry.coverage ? [`  ${entry.coverage}`] : []),
				].join("\n"),
			)
			.join("\n");
		return lspResult(
			"success",
			`${text || "No configured language servers."}\nReady means transport initialized, not verified build settings or complete indexing. Status does not start servers.`,
			{
				resultCount: statuses.length,
				...(absolutePath && statuses.length === 1
					? { server: statuses[0].name, root: statuses[0].root, projectContext: statuses[0].projectContext }
					: {}),
			},
		);
	}

	private projectContextEvidence(name: string, root: string): Pick<LspServerStatus, "projectContext" | "coverage"> {
		if (name !== "swift") return {};
		const projectContext = swiftProjectContext(root);
		return { projectContext, coverage: swiftContextCaveat(projectContext) };
	}

	private async runOperation(
		absolutePath: string,
		operation: () => Promise<LspOperationResult>,
		automatic: boolean,
	): Promise<LspResult> {
		const startedAt = performance.now();
		const sequence = ++this.operationSequence;
		const canonical = await this.canonicalizeRequestedPath(absolutePath);
		const path = "path" in canonical ? canonical.path : absolutePath;
		const server = this.findServer(path);
		const root = server ? this.findRoot(path, server.rootMarkers) : this.projectCwd;
		const key = this.serverKey(server?.name ?? "none", root);
		const context = { coldStartMs: 0, managedReads: new Map<LspClient, () => void>() };
		this.core.activeOperations.set(key, (this.core.activeOperations.get(key) ?? 0) + 1);
		let operationResult: LspOperationResult;
		try {
			operationResult = await this.core.operationContext.run(context, operation);
		} catch (error) {
			operationResult = lspErrorResult(error);
		} finally {
			for (const release of context.managedReads.values()) release();
			this.core.activeOperations.set(key, Math.max(0, (this.core.activeOperations.get(key) ?? 1) - 1));
		}
		const durationMs = performance.now() - startedAt;
		const { diagnosticsText, ...evidence } = operationResult;
		const result: LspResult = {
			...evidence,
			language: languageIdForExtension(extname(path)),
			...(server ? { server: server.name, root } : {}),
			...(server?.name === "swift"
				? { projectContext: operationResult.projectContext ?? swiftProjectContext(root) }
				: {}),
			coldStartMs: Math.min(durationMs, context.coldStartMs),
		};
		if (!server) return result;
		const metrics = this.core.metrics.get(key) ?? {
			operations: 0,
			failures: 0,
			totalDurationMs: 0,
			lastDurationMs: 0,
		};
		metrics.operations++;
		metrics.totalDurationMs += durationMs;
		metrics.lastDurationMs = durationMs;
		if (lspSucceeded(result)) {
			metrics.lastSuccess = new Date().toISOString();
			delete metrics.requestError;
		} else if (result.outcome !== "skipped") {
			metrics.failures++;
			metrics.lastFailure = new Date().toISOString();
			if (!this.core.startFailures.has(key)) metrics.requestError = result.text.slice(0, 1000);
		}
		this.core.metrics.set(key, metrics);
		if (automatic) {
			const transition = `${result.outcome}:${result.reason}`;
			const previous = this.automaticTransitions.get(key);
			if (!lspSucceeded(result) && (previous?.transition === transition || (previous?.sequence ?? 0) > sequence))
				result.text = diagnosticsText ?? "";
			if ((previous?.sequence ?? 0) <= sequence) this.automaticTransitions.set(key, { sequence, transition });
			if (Buffer.byteLength(result.text) > MAX_AUTOMATIC_REPORT_BYTES) {
				const suffix = "\n... automatic LSP report truncated; use lsp diagnostics or status.";
				result.text =
					Buffer.from(result.text)
						.subarray(0, MAX_AUTOMATIC_REPORT_BYTES - Buffer.byteLength(suffix))
						.toString("utf8")
						.replace(/\uFFFD$/, "") + suffix;
			}
		}
		return result;
	}

	/** Path of the active trace file, if tracing is enabled. */
	getTraceFile(): string | undefined {
		return this.core.getTraceFile();
	}

	/** Enable or disable protocol tracing for current and future servers. */
	setTraceFile(filePath: string | undefined): Promise<void> {
		return this.core.setTraceFile(filePath);
	}

	/** Synchronously stop tracing during non-awaitable process teardown. */
	closeTraceSync(): void {
		this.core.closeTraceSync();
	}

	/** Dispose all running servers. They respawn lazily on next use. Returns the number stopped. */
	restart(): number {
		return this.core.restart();
	}

	/**
	 * Collect diagnostics for a file that was just written.
	 *
	 * Also reports other open files that went from clean to failing as a result
	 * of this change (best-effort: depends on the server republishing for open
	 * documents within the settle window).
	 *
	 * Returns structured evidence even when display text is suppressed for a
	 * clean/skipped check or an already reported failure transition.
	 */
	async getDiagnostics(absolutePath: string, content: string, signal?: AbortSignal): Promise<LspResult> {
		const sequence = ++this.feedbackSequence;
		return this.runOperation(
			absolutePath,
			() => this.getDiagnosticsOperation(absolutePath, content, sequence, signal),
			true,
		);
	}

	private async getDiagnosticsOperation(
		absolutePath: string,
		content: string,
		sequence: number,
		signal?: AbortSignal,
	): Promise<LspOperationResult> {
		if (this.disposed) return lspResult("unavailable", "LSP manager disposed", { reason: "disposed" });
		if (!this.config.enabled) return lspResult("skipped", "", { reason: "disabled" });
		if (signal?.aborted) return lspResult("cancelled", "LSP operation aborted", { reason: "aborted" });
		const canonical = await this.canonicalizeRequestedPath(absolutePath);
		if ("error" in canonical) {
			return lspResult("invalid-input", `lsp(workspace): ${canonical.error}`);
		}
		absolutePath = canonical.path;
		const server = this.findServer(absolutePath);
		if (!server)
			return lspResult("skipped", "", {
				reason: this.config.disabledServers?.some((entry) => entry.fileExtensions.includes(extname(absolutePath)))
					? "disabled"
					: "no-server",
			});
		if (!(server.autoDiagnostics ?? this.config.autoDiagnostics))
			return lspResult("skipped", "", { reason: "auto-diagnostics-disabled" });
		const root = this.findRoot(absolutePath, server.rootMarkers);
		const key = this.serverKey(server.name, root);

		while (!this.disposed) {
			const failure = this.core.startFailures.get(key);
			if (failure && failure.count >= MAX_START_ATTEMPTS)
				return lspResult("unavailable", "", { reason: "breaker-open" });

			let client: LspClient;
			try {
				client = this.core.getClient(server, root);
			} catch (error) {
				if (error instanceof UnusableLspExecutableError) {
					return lspResult("unavailable", this.handleUnusableExecutable(server, error).message ?? "", {
						reason: "unusable-executable",
					});
				}
				if (!(error instanceof MissingLspExecutableError)) throw error;
				const result = await this.handleMissingExecutable(server, error, signal);
				if (result.retry) continue;
				if (result.failure) return result.failure;
				return lspResult(signal?.aborted ? "cancelled" : "unavailable", result.message ?? "", {
					reason: signal?.aborted ? "aborted" : error.reason,
				});
			}
			const cleanBefore = this.collectCleanOpenDocuments(client, absolutePath);
			let diagnostics: LspDiagnosticResult;
			try {
				await this.core.ensureStarted(server, key, client, signal);
				diagnostics = await client.getDiagnostics(
					absolutePath,
					content,
					this.config.settleMs,
					this.config.firstSettleMs,
					signal,
				);
			} catch (error) {
				const result = await this.handleClientError(server, key, client, error);
				if (result.retry) {
					continue;
				}
				return { ...lspErrorResult(error), text: result.message ?? "" };
			}
			if (this.disposed || this.core.clients.get(key) !== client)
				return lspResult("unavailable", "", { reason: "disposed" });

			if (lspSucceeded(diagnostics) && diagnostics.epoch !== client.getDiagnosticEpoch()) {
				diagnostics = {
					...lspResult("timeout", "Diagnostics collection superseded", {
						reason: "superseded-collection",
						freshness: "stale",
					}),
					diagnostics: [],
				};
			}
			const projectContext = server.name === "swift" ? swiftProjectContext(root) : undefined;
			let contextWarning = "";
			const previousContext = this.contextTransitions.get(key);
			if (projectContext && diagnostics.outcome !== "cancelled" && sequence >= (previousContext?.sequence ?? 0)) {
				if (
					previousContext?.context !== projectContext &&
					(projectContext === "not-detected" || projectContext === "unknown")
				)
					contextWarning = swiftContextCaveat(projectContext);
				this.contextTransitions.delete(key);
				this.contextTransitions.set(key, { sequence, context: projectContext });
				if (this.contextTransitions.size > 256)
					this.contextTransitions.delete(this.contextTransitions.keys().next().value!);
			}
			const snapshots: DiagnosticFeedbackSnapshot[] = [];
			if (lspSucceeded(diagnostics) && diagnostics.epoch === client.getDiagnosticEpoch()) {
				snapshots.push({
					path: absolutePath,
					displayPath: this.displayPath(absolutePath),
					diagnostics: diagnostics.diagnostics,
					freshness: diagnostics.freshness,
				});
			}
			// Even when the target timed out, independent current publications can
			// provide useful feedback. Never lend them the target's confidence.
			if (diagnostics.outcome !== "cancelled") {
				for (const path of client.getOpenDocumentPaths()) {
					if (path === absolutePath) continue;
					const snapshot = client.getPublicationSnapshot(path);
					if (snapshot)
						snapshots.push({
							...snapshot,
							path,
							displayPath: this.displayPath(path),
							otherFile: true,
							wasClean: cleanBefore.has(path),
						});
				}
			}
			const diagnosticsText = this.feedback.render(
				key,
				sequence,
				snapshots.map((snapshot) => ({ ...snapshot, projectContext })),
				this.config.maxSeverity,
				this.config.maxDiagnostics,
				contextWarning,
			);
			const { diagnostics: _items, epoch: _epoch, ...evidence } = diagnostics;
			return {
				...evidence,
				projectContext,
				diagnosticsText,
				text:
					diagnosticsText ||
					(lspSucceeded(evidence) ? "" : "Diagnostics not verified; use a build/check for confirmation."),
			};
		}

		return lspResult("unavailable", "", { reason: "disposed" });
	}

	/** Other open documents with a current publication and no reportable diagnostics. */
	dispose(): void {
		if (this.viewDisposed) return;
		this.viewDisposed = true;
		this.viewAbort.abort();
		this.unsubscribe();
		this.feedback.clear();
		this.contextTransitions.clear();
		this.automaticTransitions.clear();
		this.lease.release();
	}

	private collectCleanOpenDocuments(client: LspClient, excludePath: string): Set<string> {
		const clean = new Set<string>();
		for (const path of client.getOpenDocumentPaths()) {
			if (path === excludePath) {
				continue;
			}
			const published = client.getPublishedDiagnostics(path);
			// Missing or invalidated evidence cannot establish a clean baseline.
			if (published === undefined) continue;
			const reportable = published.filter((diagnostic) => (diagnostic.severity ?? 1) <= this.config.maxSeverity);
			if (reportable.length === 0) {
				clean.add(path);
			}
		}
		return clean;
	}

	// =========================================================================
	// Navigation (LspNavigationProvider)
	// =========================================================================

	async definition(absolutePath: string, symbol: string, line?: number, signal?: AbortSignal): Promise<LspResult> {
		return this.runOperation(absolutePath, () => this.definitionOperation(absolutePath, symbol, line, signal), false);
	}

	private async definitionOperation(
		absolutePath: string,
		symbol: string,
		line?: number,
		signal?: AbortSignal,
	): Promise<LspResult> {
		return this.locationQuery("textDocument/definition", "definition", absolutePath, symbol, line, signal);
	}

	async references(absolutePath: string, symbol: string, line?: number, signal?: AbortSignal): Promise<LspResult> {
		return this.runOperation(absolutePath, () => this.referencesOperation(absolutePath, symbol, line, signal), false);
	}

	private async referencesOperation(
		absolutePath: string,
		symbol: string,
		line?: number,
		signal?: AbortSignal,
	): Promise<LspResult> {
		return this.locationQuery("textDocument/references", "references", absolutePath, symbol, line, signal);
	}

	async implementations(
		absolutePath: string,
		symbol: string,
		line?: number,
		signal?: AbortSignal,
	): Promise<LspResult> {
		return this.runOperation(
			absolutePath,
			() => this.implementationsOperation(absolutePath, symbol, line, signal),
			false,
		);
	}

	private async implementationsOperation(
		absolutePath: string,
		symbol: string,
		line?: number,
		signal?: AbortSignal,
	): Promise<LspResult> {
		return this.locationQuery("textDocument/implementation", "implementations", absolutePath, symbol, line, signal);
	}

	async typeDefinition(absolutePath: string, symbol: string, line?: number, signal?: AbortSignal): Promise<LspResult> {
		return this.runOperation(
			absolutePath,
			() => this.typeDefinitionOperation(absolutePath, symbol, line, signal),
			false,
		);
	}

	private async typeDefinitionOperation(
		absolutePath: string,
		symbol: string,
		line?: number,
		signal?: AbortSignal,
	): Promise<LspResult> {
		return this.locationQuery("textDocument/typeDefinition", "type definition", absolutePath, symbol, line, signal);
	}

	async hover(absolutePath: string, symbol: string, line?: number, signal?: AbortSignal): Promise<LspResult> {
		return this.runOperation(absolutePath, () => this.hoverOperation(absolutePath, symbol, line, signal), false);
	}

	private async hoverOperation(
		absolutePath: string,
		symbol: string,
		line?: number,
		signal?: AbortSignal,
	): Promise<LspResult> {
		const session = await this.openSession(absolutePath, signal);
		if ("error" in session) {
			return session.error;
		}
		const position = findSymbolPosition(session.content, symbol, line);
		if (!position) {
			return lspResult("invalid-input", `Symbol "${symbol}" not found in ${this.displayPath(absolutePath)}.`);
		}
		try {
			const result = (await session.client.sendRequest(
				"textDocument/hover",
				{ textDocument: { uri: session.uri }, position },
				signal,
			)) as LspHoverResult | null;
			const text = result ? hoverContentsToText(result.contents).trim() : "";
			return lspResult(
				text.length > 0 ? "success" : "empty",
				text.length > 0 ? text : `No hover information for "${symbol}".`,
				{ resultCount: text.length > 0 ? 1 : 0 },
			);
		} catch (error) {
			return this.describeRequestError(absolutePath, error);
		}
	}

	async documentSymbols(absolutePath: string, signal?: AbortSignal): Promise<LspResult> {
		return this.runOperation(absolutePath, () => this.documentSymbolsOperation(absolutePath, signal), false);
	}

	private async documentSymbolsOperation(absolutePath: string, signal?: AbortSignal): Promise<LspResult> {
		const session = await this.openSession(absolutePath, signal);
		if ("error" in session) {
			return session.error;
		}
		try {
			const result = (await session.client.sendRequest(
				"textDocument/documentSymbol",
				{ textDocument: { uri: session.uri } },
				signal,
			)) as LspDocumentSymbol[] | null;
			await recordManagedLspSymbols(
				result ?? [],
				session.absolutePath,
				(uri) => this.resolveLocationPath(uri),
				MAX_SYMBOL_LINES,
			);
			if (!result || result.length === 0) {
				return lspResult("empty", `No symbols found in ${this.displayPath(absolutePath)}.`);
			}
			const lines: string[] = [];
			this.appendSymbolLines(result, 0, lines);
			if (lines.length > MAX_SYMBOL_LINES) {
				const extra = lines.length - MAX_SYMBOL_LINES;
				const omitted = isManagedLspObservation() ? "... additional symbols omitted" : `... and ${extra} more`;
				return lspResult("success", [...lines.slice(0, MAX_SYMBOL_LINES), omitted].join("\n"), {
					resultCount: lines.length,
				});
			}
			return lspResult("success", lines.join("\n"), { resultCount: lines.length });
		} catch (error) {
			return this.describeRequestError(absolutePath, error);
		}
	}

	async callHierarchy(
		absolutePath: string,
		symbol: string,
		direction: "incoming" | "outgoing",
		line?: number,
		signal?: AbortSignal,
	): Promise<LspResult> {
		return this.runOperation(
			absolutePath,
			() => this.callHierarchyOperation(absolutePath, symbol, direction, line, signal),
			false,
		);
	}

	private async callHierarchyOperation(
		absolutePath: string,
		symbol: string,
		direction: "incoming" | "outgoing",
		line?: number,
		signal?: AbortSignal,
	): Promise<LspResult> {
		const session = await this.openSession(absolutePath, signal);
		if ("error" in session) {
			return session.error;
		}
		const position = findSymbolPosition(session.content, symbol, line);
		if (!position) {
			return lspResult("invalid-input", `Symbol "${symbol}" not found in ${this.displayPath(absolutePath)}.`);
		}
		try {
			const items = (await session.client.sendRequest(
				"textDocument/prepareCallHierarchy",
				{ textDocument: { uri: session.uri }, position },
				signal,
			)) as CallHierarchyItem[] | null;
			if (!items || items.length === 0) {
				return lspResult("empty", `No call hierarchy available for "${symbol}" (it may not be a callable symbol).`);
			}
			const item = items[0];
			const label = direction === "incoming" ? "callers of" : "calls made by";
			const method = direction === "incoming" ? "callHierarchy/incomingCalls" : "callHierarchy/outgoingCalls";
			const calls = (await session.client.sendRequest(method, { item }, signal)) as Array<{
				from?: CallHierarchyItem;
				to?: CallHierarchyItem;
			}> | null;
			if (!calls || calls.length === 0) {
				return lspResult("empty", `No ${label} "${item.name}" found.`);
			}
			const shown = calls.slice(0, MAX_REFERENCES);
			const lines: string[] = [`${direction === "incoming" ? "Callers of" : "Calls made by"} "${item.name}":`];
			for (const call of shown) {
				const target = direction === "incoming" ? call.from : call.to;
				if (!target) {
					continue;
				}
				const kind = SYMBOL_KIND_NAMES[target.kind] ?? "symbol";
				const canonical = await this.resolveLocationPath(target.uri);
				const path = "error" in canonical ? target.uri : this.displayPath(canonical.path);
				const targetLine = (target.selectionRange ?? target.range).start.line + 1;
				lines.push(`${target.name} (${kind}) ${path}:${targetLine}`);
			}
			if (calls.length > shown.length) {
				lines.push(`... and ${calls.length - shown.length} more`);
			}
			return lspResult("success", lines.join("\n"), { resultCount: calls.length });
		} catch (error) {
			return this.describeRequestError(absolutePath, error);
		}
	}

	async workspaceSymbols(absolutePath: string, query: string, signal?: AbortSignal): Promise<LspResult> {
		return this.runOperation(absolutePath, () => this.workspaceSymbolsOperation(absolutePath, query, signal), false);
	}

	private async workspaceSymbolsOperation(
		absolutePath: string,
		query: string,
		signal?: AbortSignal,
	): Promise<LspResult> {
		const session = await this.openSession(absolutePath, signal);
		if ("error" in session) {
			return session.error;
		}
		try {
			const result = (await session.client.sendRequest("workspace/symbol", { query }, signal)) as Array<{
				name: string;
				kind: number;
				containerName?: string;
				location?: { uri: string; range?: LspRange };
			}> | null;
			await recordManagedLspSymbols(result ?? [], undefined, (uri) => this.resolveLocationPath(uri), MAX_REFERENCES);
			if (!result || result.length === 0) {
				return lspResult("empty", `No workspace symbols matching "${query}".`);
			}
			const shown = result.slice(0, MAX_REFERENCES);
			const lines = await Promise.all(
				shown.map(async (symbol) => {
					const kind = SYMBOL_KIND_NAMES[symbol.kind] ?? "symbol";
					const container = symbol.containerName ? ` in ${symbol.containerName}` : "";
					let location = "";
					if (symbol.location?.uri) {
						const canonical = await this.resolveLocationPath(symbol.location.uri);
						const path = "error" in canonical ? symbol.location.uri : this.displayPath(canonical.path);
						const line = symbol.location.range ? `:${symbol.location.range.start.line + 1}` : "";
						location = ` ${path}${line}`;
					}
					return `${symbol.name} (${kind})${container}${location}`;
				}),
			);
			if (result.length > shown.length) {
				lines.push(`... and ${result.length - shown.length} more`);
			}
			return lspResult("success", lines.join("\n"), { resultCount: result.length });
		} catch (error) {
			return this.describeRequestError(absolutePath, error);
		}
	}

	async fileDiagnostics(absolutePath: string, signal?: AbortSignal): Promise<LspResult> {
		return this.runOperation(absolutePath, () => this.fileDiagnosticsOperation(absolutePath, signal), false);
	}

	private async fileDiagnosticsOperation(absolutePath: string, signal?: AbortSignal): Promise<LspResult> {
		// openSession applies the start-failure breaker and failure accounting,
		// so a broken server is not respawned on every diagnostics request.
		const session = await this.openSession(absolutePath, signal);
		if ("error" in session) {
			return session.error;
		}
		try {
			const diagnostics = await session.client.getDiagnostics(
				session.absolutePath,
				session.content,
				this.config.settleMs,
				this.config.firstSettleMs,
				signal,
			);
			const { diagnostics: items, epoch: _epoch, ...evidence } = diagnostics;
			const text = lspSucceeded(evidence)
				? ((items.length && evidence.freshness === "unverified"
						? `Best-effort diagnostics (unversioned):\n${this.formatDiagnostics(session.absolutePath, items) ?? "No reportable diagnostics."}`
						: this.formatDiagnostics(session.absolutePath, items)) ??
					`No diagnostics in ${this.displayPath(session.absolutePath)}${evidence.freshness === "unverified" ? " (best-effort, unversioned publication)" : ""}.`)
				: `${evidence.text}; diagnostics are ${evidence.freshness}, not a clean check.`;
			const server = this.findServer(session.absolutePath);
			const projectContext = server?.name === "swift" ? swiftProjectContext(session.client.rootDir) : undefined;
			return {
				...evidence,
				projectContext,
				text: projectContext
					? `${text}\nSwift project context: ${projectContext}. ${swiftContextCaveat(projectContext)}`
					: text,
			};
		} catch (error) {
			return this.describeRequestError(absolutePath, error);
		}
	}

	private async locationQuery(
		method: string,
		label: string,
		absolutePath: string,
		symbol: string,
		line?: number,
		signal?: AbortSignal,
	): Promise<LspResult> {
		const session = await this.openSession(absolutePath, signal);
		if ("error" in session) {
			return session.error;
		}
		const position = findSymbolPosition(session.content, symbol, line);
		if (!position) {
			return lspResult("invalid-input", `Symbol "${symbol}" not found in ${this.displayPath(absolutePath)}.`);
		}
		try {
			const result = await session.client.sendRequest(
				method,
				{
					textDocument: { uri: session.uri },
					position,
					...(method === "textDocument/references" ? { context: { includeDeclaration: true } } : {}),
				},
				signal,
			);
			const locations = normalizeLocations(result);
			if (method === "textDocument/definition" || method === "textDocument/references") {
				await recordManagedLspLocations(locations, (uri) => this.resolveLocationPath(uri), MAX_REFERENCES);
			}
			if (locations.length === 0) {
				return lspResult("empty", `No ${label} found for "${symbol}".`);
			}
			const shown = locations.slice(0, MAX_REFERENCES);
			const lines = await Promise.all(shown.map((location) => this.formatLocation(location)));
			if (locations.length > shown.length) {
				lines.push(`... and ${locations.length - shown.length} more`);
			}
			return lspResult("success", lines.join("\n"), { resultCount: locations.length });
		} catch (error) {
			return this.describeRequestError(absolutePath, error);
		}
	}

	/** Route a file to its server, read it from disk, and sync it. Returns an error message on failure. */
	private async openSession(absolutePath: string, signal?: AbortSignal): Promise<DocumentSession> {
		if (!this.config.enabled) return { error: lspResult("unavailable", "LSP is disabled.", { reason: "disabled" }) };
		if (signal?.aborted) return { error: lspResult("cancelled", "LSP operation aborted", { reason: "aborted" }) };
		const canonical = await this.canonicalizeRequestedPath(absolutePath);
		if ("error" in canonical) {
			return { error: lspResult("invalid-input", `lsp(workspace): ${canonical.error}`) };
		}
		absolutePath = canonical.path;
		const server = this.findServer(absolutePath);
		if (!server) {
			const disabled = this.config.disabledServers?.some((entry) =>
				entry.fileExtensions.includes(extname(absolutePath)),
			);
			return {
				error: lspResult(
					"unavailable",
					disabled ? "Language server disabled for this file." : this.noServerMessage(absolutePath),
					{ reason: disabled ? "disabled" : "no-server" },
				),
			};
		}
		let content: string;
		try {
			content = await readFile(absolutePath, "utf-8");
		} catch (error) {
			return {
				error: lspResult(
					"invalid-input",
					`Could not read ${this.displayPath(absolutePath)}: ${error instanceof Error ? error.message : String(error)}`,
				),
			};
		}
		const root = this.findRoot(absolutePath, server.rootMarkers);
		const key = this.serverKey(server.name, root);

		while (!this.disposed) {
			const failure = this.core.startFailures.get(key);
			if (failure && failure.count >= MAX_START_ATTEMPTS) {
				return {
					error: lspResult(
						"unavailable",
						`lsp(${server.name}): server unavailable after ${failure.count} failed starts. Last error: ${failure.lastError}`,
						{ reason: "breaker-open" },
					),
				};
			}
			let client: LspClient;
			try {
				client = this.core.getClient(server, root);
			} catch (error) {
				if (error instanceof UnusableLspExecutableError) {
					const result = this.handleUnusableExecutable(server, error);
					return {
						error: lspResult("unavailable", result.message ?? `lsp(${server.name}): ${error.message}`, {
							reason: "unusable-executable",
						}),
					};
				}
				if (!(error instanceof MissingLspExecutableError)) throw error;
				const result = await this.handleMissingExecutable(server, error, signal);
				if (result.retry) continue;
				if (result.failure) return { error: result.failure };
				return {
					error: lspResult(
						signal?.aborted ? "cancelled" : "unavailable",
						result.message ?? `lsp(${server.name}): ${error.message}`,
						{ reason: signal?.aborted ? "aborted" : error.reason },
					),
				};
			}
			try {
				await this.core.ensureStarted(server, key, client, signal);
				const uri = await client.openDocument(absolutePath, content, signal);
				await this.refreshStale(client, absolutePath);
				return { client, uri, content, absolutePath };
			} catch (error) {
				const result = await this.handleClientError(server, key, client, error);
				if (result.retry) {
					continue;
				}
				return {
					error: {
						...lspErrorResult(error),
						text:
							result.message ?? `lsp(${server.name}): ${error instanceof Error ? error.message : String(error)}`,
					},
				};
			}
		}

		return { error: lspResult("unavailable", `lsp(${server.name}): LSP manager disposed.`, { reason: "disposed" }) };
	}

	async rename(
		absolutePath: string,
		symbol: string,
		newName: string,
		line?: number,
		signal?: AbortSignal,
	): Promise<LspResult> {
		return this.runOperation(
			absolutePath,
			() => this.renameOperation(absolutePath, symbol, newName, line, signal),
			false,
		);
	}

	private async renameOperation(
		absolutePath: string,
		symbol: string,
		newName: string,
		line?: number,
		signal?: AbortSignal,
	): Promise<LspResult> {
		const session = await this.openSession(absolutePath, signal);
		if ("error" in session) {
			return session.error;
		}
		const position = findSymbolPosition(session.content, symbol, line);
		if (!position) {
			return lspResult("invalid-input", `Symbol "${symbol}" not found in ${this.displayPath(absolutePath)}.`);
		}
		try {
			const snapshots = session.client.captureWorkspaceEditSnapshots();
			const result = (await session.client.sendRequest(
				"textDocument/rename",
				{ textDocument: { uri: session.uri }, position, newName },
				signal,
			)) as LspWorkspaceEdit | null;
			if (!result || normalizeWorkspaceEdit(result).length === 0) {
				return lspResult("empty", `Rename of "${symbol}" is not available at this position.`);
			}
			const applied = await this.core.applyWorkspaceEdit(session.client, result, snapshots);
			this.assertWorkspaceEditApplied(applied);
			return lspResult("success", `Renamed "${symbol}" to "${newName}":\n${applied.summary}`, {
				resultCount: applied.changes.length,
			});
		} catch (error) {
			return this.describeRequestError(absolutePath, error);
		}
	}

	async codeFix(
		absolutePath: string,
		options: { symbol?: string; line?: number; title?: string; kind?: string },
		signal?: AbortSignal,
	): Promise<LspResult> {
		return this.runOperation(absolutePath, () => this.codeFixOperation(absolutePath, options, signal), false);
	}

	private async codeFixOperation(
		absolutePath: string,
		options: { symbol?: string; line?: number; title?: string; kind?: string },
		signal?: AbortSignal,
	): Promise<LspResult> {
		const session = await this.openSession(absolutePath, signal);
		if ("error" in session) {
			return session.error;
		}
		const contentLines = session.content.split("\n");
		let range: LspRange;
		if (options.symbol) {
			const position = findSymbolPosition(session.content, options.symbol, options.line);
			if (!position) {
				return lspResult(
					"invalid-input",
					`Symbol "${options.symbol}" not found in ${this.displayPath(absolutePath)}.`,
				);
			}
			range = {
				start: position,
				end: { line: position.line, character: position.character + options.symbol.length },
			};
		} else if (options.line !== undefined && options.line >= 1 && options.line <= contentLines.length) {
			const lineIndex = options.line - 1;
			range = {
				start: { line: lineIndex, character: 0 },
				end: { line: lineIndex, character: contentLines[lineIndex].length },
			};
		} else {
			range = {
				start: { line: 0, character: 0 },
				end: {
					line: Math.max(0, contentLines.length - 1),
					character: contentLines[contentLines.length - 1]?.length ?? 0,
				},
			};
		}

		// Servers derive quick fixes from the diagnostics passed in the context,
		// so make sure we have them before asking for code actions.
		let published = session.client.getPublishedDiagnostics(session.absolutePath);
		if (published === undefined || published.length === 0) {
			try {
				published = (
					await session.client.getDiagnostics(
						session.absolutePath,
						session.content,
						this.config.settleMs,
						this.config.firstSettleMs,
						signal,
					)
				).diagnostics;
			} catch {
				// Code actions may still be available without diagnostics context.
			}
		}
		const diagnostics = (published ?? []).filter((diagnostic) => rangesOverlap(diagnostic.range, range));
		try {
			const snapshots = session.client.captureWorkspaceEditSnapshots();
			const result = await session.client.sendRequest(
				"textDocument/codeAction",
				{
					textDocument: { uri: session.uri },
					range,
					context: { diagnostics, ...(options.kind ? { only: [options.kind] } : {}) },
				},
				signal,
			);
			const actions = normalizeCodeActions(result);
			if (actions.length === 0) {
				return lspResult("empty", "No code actions available at this position.");
			}
			const describe = (action: NormalizedCodeAction): string =>
				`- ${action.title}${action.kind ? ` (${action.kind})` : ""}`;
			let chosen: NormalizedCodeAction | undefined;
			if (options.title) {
				const wanted = options.title.toLowerCase();
				chosen =
					actions.find((action) => action.title.toLowerCase() === wanted) ??
					actions.find((action) => action.title.toLowerCase().includes(wanted));
				if (!chosen) {
					return lspResult(
						"needs-selection",
						`No code action matching "${options.title}". Available:\n${actions.map(describe).join("\n")}`,
					);
				}
			} else if (actions.length === 1) {
				chosen = actions[0];
			} else {
				return lspResult(
					"needs-selection",
					`Multiple code actions available; rerun with a title to apply one:\n${actions.map(describe).join("\n")}`,
				);
			}
			return await this.applyCodeAction(session.client, chosen, snapshots, signal);
		} catch (error) {
			return this.describeRequestError(absolutePath, error);
		}
	}

	private async applyCodeAction(
		client: LspClient,
		action: NormalizedCodeAction,
		snapshots: WorkspaceEditDocumentSnapshot[],
		signal?: AbortSignal,
	): Promise<LspResult> {
		let edit = action.edit;
		if (!edit && client.supportsMethod("codeAction/resolve") === true) {
			// Servers may defer the edit to codeAction/resolve.
			try {
				snapshots = client.captureWorkspaceEditSnapshots();
				const resolved = (await client.sendRequest("codeAction/resolve", action.raw, signal)) as {
					edit?: LspWorkspaceEdit;
				} | null;
				edit = resolved?.edit;
			} catch {
				// Fall back to the command below.
			}
		}
		if (edit && normalizeWorkspaceEdit(edit).length > 0) {
			const applied = await this.core.applyWorkspaceEdit(client, edit, snapshots);
			this.assertWorkspaceEditApplied(applied);
			return lspResult("success", `Applied "${action.title}":\n${applied.summary}`, {
				resultCount: applied.changes.length,
			});
		}
		if (action.command) {
			return this.core.withClientCommandQueue(client, async () => {
				const context: { snapshots: WorkspaceEditDocumentSnapshot[]; summaries: string[]; failure?: string } = {
					snapshots: client.captureWorkspaceEditSnapshots(),
					summaries: [],
				};
				this.core.commandApplyContexts.set(client, context);
				try {
					await client.sendRequest(
						"workspace/executeCommand",
						{ command: action.command?.command, arguments: action.command?.arguments ?? [] },
						signal,
					);
				} finally {
					this.core.commandApplyContexts.delete(client);
				}
				if (context.failure) throw new LspOperationError("edit-failed", "workspace-edit-rejected", context.failure);
				if (context.summaries.length > 0) {
					return lspResult("success", `Applied "${action.title}":\n${context.summaries.join("\n")}`, {
						resultCount: context.summaries.length,
					});
				}
				return lspResult("success", `Executed "${action.title}" (no workspace edits reported).`);
			});
		}
		return lspResult("empty", `Code action "${action.title}" produced no edits.`);
	}

	private assertWorkspaceEditApplied(result: WorkspaceEditApplyResult): void {
		if (result.applied) {
			return;
		}
		const index = result.failedChange === undefined ? "" : ` at operation ${result.failedChange}`;
		throw new LspOperationError(
			"edit-failed",
			"workspace-edit-rejected",
			`LSP workspace edit failed${index}: ${result.failureReason ?? "unknown failure"}`,
		);
	}

	/** Re-sync open documents that changed on disk outside edit/write (best-effort). */
	private async refreshStale(client: LspClient, excludePath: string): Promise<void> {
		try {
			await client.refreshStaleDocuments(excludePath);
		} catch {
			// Staleness refresh must never fail the operation that triggered it.
		}
	}

	private appendSymbolLines(symbols: LspDocumentSymbol[], depth: number, lines: string[]): void {
		for (const symbol of symbols) {
			// Foreground keeps its full count. Managed discovery must not traverse
			// an unbounded/deep tree again merely to render discarded tool text.
			if (isManagedLspObservation() && lines.length > MAX_SYMBOL_LINES) return;
			const range = symbol.selectionRange ?? symbol.location?.range;
			const line = range ? `:${range.start.line + 1}` : "";
			const kind = SYMBOL_KIND_NAMES[symbol.kind] ?? "symbol";
			lines.push(`${"  ".repeat(depth)}${symbol.name} (${kind})${line}`);
			if (symbol.children && symbol.children.length > 0) {
				this.appendSymbolLines(symbol.children, depth + 1, lines);
			}
		}
	}

	private async formatLocation(location: LspLocation): Promise<string> {
		const canonical = await this.resolveLocationPath(location.uri);
		if ("error" in canonical) {
			return `${location.uri}:${location.range.start.line + 1}:${location.range.start.character + 1}`;
		}
		const path = canonical.path;
		const line = location.range.start.line + 1;
		const column = location.range.start.character + 1;
		let snippet = "";
		try {
			const content = await readFile(path, "utf-8");
			const text = content.split("\n")[location.range.start.line]?.trim();
			if (text) {
				snippet = `  ${text}`;
			}
		} catch {
			// Snippets are best-effort.
		}
		return `${this.displayPath(path)}:${line}:${column}${snippet}`;
	}

	private noServerMessage(absolutePath: string): string {
		const ext = extname(absolutePath) || "(no extension)";
		return `No language server configured for ${ext} files. Configure one under lsp.servers in settings.`;
	}

	private describeRequestError(absolutePath: string, error: unknown): LspResult {
		const server = this.findServer(absolutePath);
		const name = server?.name ?? "unknown";
		return {
			...lspErrorResult(error),
			text: `lsp(${name}): ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	private displayPath(absolutePath: string): string {
		const rel = relative(this.displayCwd, absolutePath);
		return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : absolutePath;
	}

	private findServer(absolutePath: string): ResolvedLspServerConfig | undefined {
		const ext = extname(absolutePath).toLowerCase();
		if (!ext) {
			return undefined;
		}
		return this.config.servers.find((server) => server.fileExtensions.includes(ext));
	}

	private serverKey(serverName: string, root: string): string {
		return lspServerKey(serverName, root);
	}

	private findRoot(absolutePath: string, rootMarkers: string[]): string {
		const inProject = isPathAtOrInside(this.projectCwd, absolutePath);
		const home = canonicalizePath(homedir());
		const directories: string[] = [];
		let dir = dirname(absolutePath);
		let fallback = inProject ? this.projectCwd : dir;
		while (true) {
			directories.push(dir);
			if (inProject && dir === this.projectCwd) break;
			if (!inProject && pathEntryExists(resolve(dir, ".git"))) {
				fallback = dir;
				break;
			}
			const parent = dirname(dir);
			// Do not infer a whole home directory or filesystem as an external
			// project. A file requested directly in either directory still works.
			if (parent === dir || (!inProject && (parent === home || parent === dirname(parent)))) break;
			dir = parent;
		}
		// Preserve marker priority within the current project or external repo.
		for (const marker of rootMarkers) {
			if (marker !== basename(marker) || marker === "." || marker === "..") continue;
			for (const directory of directories) {
				if (pathEntryExists(resolve(directory, marker))) return directory;
			}
		}
		return fallback;
	}

	private async handleClientError(
		server: ResolvedLspServerConfig,
		key: string,
		client: LspClient,
		error: unknown,
	): Promise<LspClientErrorResult> {
		const notice: LspFailureNotice = await this.core.handleClientError(server, key, client, error);
		return {
			retry: false,
			message: "event" in notice ? this.reportStartFailure(server, notice.event) : notice.message,
		};
	}

	/** Account a start failure in the shared breaker and report it if this view has not yet. */
	private recordStartFailure(
		server: ResolvedLspServerConfig,
		key: string,
		message: string,
		extraMessage?: string,
	): string | undefined {
		return this.reportStartFailure(server, this.core.recordStartFailure(server, key, message, extraMessage));
	}

	/**
	 * The first failure event for a shared failure record is reported (to every
	 * waiter of that event); later failures for the record stay silent in this view.
	 */
	private reportStartFailure(server: ResolvedLspServerConfig, event: LspStartFailureEvent): string | undefined {
		if (this.disposed) return undefined;
		const first = this.reportedFailures.get(event.state);
		if (first !== undefined && first !== event) return undefined;
		this.reportedFailures.set(event.state, event);
		return `lsp(${server.name}): ${event.actionable} (further failures for this server root will be silent until /lsp restart or /reload)`;
	}

	private hasReportedFailure(key: string): boolean {
		const state = this.core.startFailures.get(key);
		return state !== undefined && this.reportedFailures.has(state);
	}

	/** A delivered install/readiness failure counts as this view's report for the record. */
	private markFailureReported(key: string): void {
		const state = this.core.startFailures.get(key);
		if (state && !this.reportedFailures.has(state))
			this.reportedFailures.set(state, { state, actionable: state.lastError });
	}

	private handleUnusableExecutable(
		server: ResolvedLspServerConfig,
		error: UnusableLspExecutableError,
	): { retry: false; message?: string } {
		return { retry: false, message: this.recordStartFailure(server, error.key, error.message) };
	}

	private async handleMissingExecutable(
		server: ResolvedLspServerConfig,
		error: MissingLspExecutableError,
		signal?: AbortSignal,
	): Promise<LspClientErrorResult> {
		// Do not join a foreground install or consume its prompt/breaker state.
		// This policy belongs to the operation, not the shared server startup.
		if (isManagedLspObservation()) return { retry: false, message: error.message };
		const reported = this.hasReportedFailure(error.key);
		const recipe = effectiveInstallRecipe(server, error.launch);
		const installEligible =
			error.launch.bare &&
			(error.reason === "missing-executable" || error.reason === "incompatible-version") &&
			recipe !== undefined &&
			recipe.binary === error.launch.requestedExecutable;
		const installPending = recipe && this.core.installAttempts.has(installRecipeIdentity(recipe));
		if (!this.disposed && installEligible && (!reported || installPending)) {
			// Readiness, like installation, must finish even if every operation stops waiting.
			const installSignal = this.core.installAbortController.signal;
			const attempt = this.tryInstallMissingServer(server, recipe, error.key);
			const result = await this.waitForInstallAttempt(attempt, signal);
			// Restart/disposal revokes this attempt, including host prompt rejections.
			// Never let its completion restore failures against the reset manager.
			if (installSignal.aborted || this.disposed)
				return {
					retry: false,
					failure: lspResult("cancelled", "LSP install cancelled.", { reason: "aborted" }),
				};
			if (result.retry) return { retry: true };
			if (result.failure || result.cancelled) {
				if (!result.cancelled) this.markFailureReported(error.key);
				return { retry: false, message: result.message, failure: result.failure };
			}
			return {
				retry: false,
				message: this.recordStartFailure(server, error.key, error.message, result.message),
			};
		}
		return { retry: false, message: this.recordStartFailure(server, error.key, error.message) };
	}

	private async tryInstallMissingServer(
		server: ResolvedLspServerConfig,
		recipe: LspInstallRecipe,
		key: string,
	): Promise<LspInstallAttemptResult> {
		if (isManagedLspObservation() || !this.installAllowed() || /^(1|true|yes)$/i.test(process.env.VOLT_OFFLINE ?? ""))
			return { retry: false, message: "Automatic LSP repair is unavailable in offline/restricted contexts." };
		return (await this.core.installMissingServer(server, recipe, key, this.installInitiator)) ?? { retry: false };
	}

	private waitForInstallAttempt(
		attempt: Promise<LspInstallAttemptResult>,
		signal?: AbortSignal,
	): Promise<LspInstallAttemptResult> {
		const guardedAttempt = attempt.catch((error: unknown) => this.createInstallAttemptFailure(error));
		if (!signal) return guardedAttempt;
		const cancelled = { retry: false, message: "LSP install cancelled.", cancelled: true } as const;
		if (signal.aborted) return Promise.resolve(cancelled);

		return new Promise((resolveAttempt) => {
			let settled = false;
			const finish = (result: LspInstallAttemptResult): void => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", onAbort);
				resolveAttempt(result);
			};
			function onAbort(): void {
				finish(cancelled);
			}
			signal.addEventListener("abort", onAbort, { once: true });
			void guardedAttempt.then(finish);
		});
	}

	private createInstallAttemptFailure(error: unknown): LspInstallAttemptResult {
		return {
			retry: false,
			message: `LSP install prompt failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	private formatDiagnostics(absolutePath: string, diagnostics: LspDiagnostic[]): string | undefined {
		const filtered = diagnostics
			.filter((diagnostic) => (diagnostic.severity ?? 1) <= this.config.maxSeverity)
			.sort((a, b) => (a.severity ?? 1) - (b.severity ?? 1) || a.range.start.line - b.range.start.line);
		if (filtered.length === 0) {
			return undefined;
		}
		const shown = filtered.slice(0, this.config.maxDiagnostics);
		const displayPath = this.displayPath(absolutePath);
		const lines = shown.map((diagnostic) => {
			const severity = SEVERITY_NAMES[diagnostic.severity ?? 1] ?? "error";
			const line = diagnostic.range.start.line + 1;
			const column = diagnostic.range.start.character + 1;
			const code =
				diagnostic.code !== undefined
					? ` [${diagnostic.source ? `${diagnostic.source} ` : ""}${diagnostic.code}]`
					: "";
			const message = diagnostic.message.replace(/\s+/g, " ").trim();
			return `${displayPath}(${line},${column}): ${severity}: ${message}${code}`;
		});
		if (filtered.length > shown.length) {
			lines.push(`... and ${filtered.length - shown.length} more`);
		}
		return lines.join("\n");
	}
}
