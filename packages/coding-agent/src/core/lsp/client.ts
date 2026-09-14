/**
 * Minimal LSP client speaking JSON-RPC over stdio.
 *
 * Implements only what the diagnostics feedback loop needs: the initialize
 * handshake, full-text document synchronization, push diagnostics
 * (textDocument/publishDiagnostics), and pull diagnostics
 * (textDocument/diagnostic) when the server advertises support.
 */

import type { ChildProcess } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnProcess, spawnProcessSync } from "../../utils/child-process.ts";
import { getSubprocessEnv } from "../../utils/process-env.ts";
import type { LspLaunchSource } from "./command-resolver.ts";
import { languageIdForExtension } from "./config.ts";
import { LspOperationError, type LspResult, lspErrorResult, lspResult, waitForLsp } from "./outcome.ts";
import type { LspTracer } from "./trace.ts";
import type { AppliedWorkspaceChange, WorkspaceEditDocumentSnapshot } from "./workspace-edit-applier.ts";

export interface LspPosition {
	line: number;
	character: number;
}

export interface LspRange {
	start: LspPosition;
	end: LspPosition;
}

export interface LspDiagnostic {
	range: LspRange;
	severity?: number;
	code?: number | string;
	source?: string;
	message: string;
}

export interface LspClientOptions {
	serverName: string;
	command: string[];
	rootDir: string;
	/** Exact inherited environment used to resolve and launch the executable. */
	environment?: NodeJS.ProcessEnv;
	/** Launch context included in protocol traces. */
	launchContext?: {
		configuredCommand: string[];
		source: LspLaunchSource;
		workspaceRoot: string;
		attempt: number;
	};
	initializationOptions?: unknown;
	/**
	 * Server configuration. Sent via workspace/didChangeConfiguration after the
	 * handshake and used to answer workspace/configuration section requests.
	 */
	settings?: unknown;
	/** Timeout for individual LSP requests (including initialize). Default: 30000 */
	requestTimeoutMs?: number;
	/** Handler for server-initiated workspace/applyEdit requests. */
	onApplyEdit?: (edit: unknown) => Promise<boolean | LspApplyEditResult>;
	/** Protocol tracer. Can also be set later via setTracer(). */
	tracer?: LspTracer;
	/** @internal Injectable process spawner for deterministic transport tests. */
	serverSpawner?: (command: string[], cwd: string, environment: NodeJS.ProcessEnv) => ChildProcess;
	/** @internal Revalidate and resolve a tracked path immediately before disk refresh. */
	resolveTrackedDocumentPath?: (absolutePath: string) => Promise<string | undefined>;
}

export interface LspApplyEditResult {
	applied: boolean;
	failureReason?: string;
	failedChange?: number;
}

interface PendingRequest {
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

export interface LspDiagnosticResult extends LspResult {
	diagnostics: LspDiagnostic[];
}

interface PublishedDiagnostics {
	diagnostics: LspDiagnostic[];
	epoch: number;
	seq: number;
	/** Document version from the publish notification, when the server provided one */
	version?: number;
}

interface PublishWaiter {
	uri: string;
	sinceSeq: number;
	resolve: () => void;
}

interface TrackedDocument {
	uri: string;
	absolutePath: string;
	version: number;
	/** The exact content last synced to the server */
	content: string;
	/** Disk stat at last sync, used as a cheap staleness filter */
	mtimeMs?: number;
	size?: number;
}

/** LSP FileChangeType values for workspace/didChangeWatchedFiles */
const FILE_CHANGE_TYPE_CREATED = 1;
const FILE_CHANGE_TYPE_CHANGED = 2;
const FILE_CHANGE_TYPE_DELETED = 3;

interface JsonRpcMessage {
	jsonrpc: "2.0";
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string };
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const MAX_STARTUP_STDERR_CHARS = 8000;
const STARTUP_STDERR_IDLE_GRACE_MS = 100;
const STARTUP_STDERR_MAX_DRAIN_MS = 1000;

/**
 * How long to re-wait for a fresher publish after an unversioned one when the
 * server has never tagged any publish with a version. Such servers publish
 * exactly once per change in the common case, so a full settle-window re-wait
 * would just run to the deadline on every edit; a racing stale publish and its
 * corrected follow-up arrive close together in practice.
 */
const UNVERSIONED_REPUBLISH_GRACE_MS = 250;

/**
 * A JSON-RPC error response: the server actively rejected the request (as
 * opposed to a timeout, abort, or server exit on our side).
 */
class LspResponseError extends LspOperationError {
	readonly code: number;

	constructor(code: number, message: string) {
		super(
			code === -32601 ? "unsupported" : "request-failed",
			code === -32601 ? "method-not-found" : "server-rejected",
			`LSP error ${code}: ${message}`,
		);
		this.code = code;
	}
}

function spawnServer(command: string[], cwd: string, environment: NodeJS.ProcessEnv): ChildProcess {
	return spawnProcess(command[0], command.slice(1), {
		cwd,
		env: environment,
		stdio: ["pipe", "pipe", "pipe"],
	});
}

function waitForStartupStderrDrain(child: ChildProcess): Promise<void> {
	const stderr = child.stderr;
	if (!stderr || stderr.readableEnded || stderr.destroyed) return Promise.resolve();
	return new Promise((resolve) => {
		let settled = false;
		let terminated = child.exitCode !== null || child.signalCode !== null;
		let idleTimer: NodeJS.Timeout | undefined;
		let deadlineTimer: NodeJS.Timeout | undefined;
		const cleanup = (): void => {
			if (idleTimer) clearTimeout(idleTimer);
			if (deadlineTimer) clearTimeout(deadlineTimer);
			stderr.removeListener("data", onData);
			stderr.removeListener("end", finish);
			child.removeListener("error", onTermination);
			child.removeListener("exit", onTermination);
			child.removeListener("close", finish);
		};
		const finish = (): void => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve();
		};
		const armIdleTimer = (): void => {
			if (idleTimer) clearTimeout(idleTimer);
			idleTimer = setTimeout(finish, STARTUP_STDERR_IDLE_GRACE_MS);
			idleTimer.unref();
		};
		const onData = (): void => {
			if (terminated) armIdleTimer();
		};
		const onTermination = (): void => {
			terminated = true;
			if (!deadlineTimer) {
				deadlineTimer = setTimeout(finish, STARTUP_STDERR_MAX_DRAIN_MS);
				deadlineTimer.unref();
			}
			armIdleTimer();
		};
		stderr.on("data", onData);
		stderr.once("end", finish);
		child.once("error", onTermination);
		child.once("exit", onTermination);
		child.once("close", finish);
		if (terminated) onTermination();
	});
}

function killProcessTree(child: ChildProcess): void {
	if (child.pid === undefined || child.exitCode !== null) {
		return;
	}
	try {
		if (process.platform === "win32") {
			spawnProcessSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
				encoding: "utf-8",
				stdio: "ignore",
			});
		} else {
			child.kill("SIGKILL");
		}
	} catch {
		// Process is already gone.
	}
}

/** Look up a dot-separated configuration section (e.g. "python.analysis") in a settings object. */
function lookupConfigSection(settings: unknown, section: unknown): unknown {
	if (typeof section !== "string" || section.length === 0) {
		return settings ?? null;
	}
	let current: unknown = settings;
	for (const part of section.split(".")) {
		if (current === null || typeof current !== "object") {
			return null;
		}
		current = (current as Record<string, unknown>)[part];
	}
	return current ?? null;
}

/** Normalize a file URI for map keys (Windows URIs vary in drive-letter casing and escaping). */
function normalizeUri(uri: string): string {
	let decoded = uri;
	try {
		decoded = decodeURIComponent(uri);
	} catch {
		// Keep the raw URI when decoding fails.
	}
	return process.platform === "win32" ? decoded.toLowerCase() : decoded;
}

function validDiagnostics(value: unknown): value is LspDiagnostic[] {
	return (
		Array.isArray(value) &&
		value.every((item: unknown) => {
			if (!item || typeof item !== "object") return false;
			const diagnostic = item as Partial<LspDiagnostic>;
			return (
				typeof diagnostic.message === "string" &&
				[diagnostic.range?.start, diagnostic.range?.end].every(
					(position) =>
						position &&
						Number.isInteger(position.line) &&
						position.line >= 0 &&
						Number.isInteger(position.character) &&
						position.character >= 0,
				) &&
				(diagnostic.severity === undefined || [1, 2, 3, 4].includes(diagnostic.severity))
			);
		})
	);
}

function isPathAtOrInside(parentPath: string, candidatePath: string): boolean {
	const rel = relative(parentPath, candidatePath);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export class LspClient {
	private options: LspClientOptions;
	private rootUri: string;
	private child: ChildProcess | undefined;
	private startPromise: Promise<void> | undefined;
	private startFailure = false;
	private alive = false;
	private disposed = false;
	private exitError: Error | undefined;
	private startupComplete = false;
	private startupStderr = "";
	private startupProcessTerminated = false;
	private startupStderrDrained: Promise<void> = Promise.resolve();

	private nextRequestId = 1;
	private pendingRequests = new Map<number, PendingRequest>();
	private readBuffer: Buffer = Buffer.alloc(0);

	private supportsPullDiagnostics = false;
	private capabilities: Record<string, unknown> | undefined;
	private serverInfo: { name: string; version?: string } | undefined;
	private diagnosticEpoch = 0;
	startupDurationMs = 0;

	get isReady(): boolean {
		return this.isAlive && this.startupComplete;
	}
	/** Startup remains owned by this client even when every caller stops waiting. */
	get isStarting(): boolean {
		return this.startPromise !== undefined && !this.startupComplete && !this.disposed;
	}
	getServerInfo(): { name: string; version?: string } | undefined {
		return this.serverInfo;
	}
	getCapabilities(): Record<string, unknown> | undefined {
		return this.capabilities;
	}
	getStartupStderr(): string {
		return this.startupStderr;
	}

	supportsMethod(method: string): boolean | undefined {
		if (!this.capabilities) return undefined;
		const providers: Record<string, string> = {
			"textDocument/definition": "definitionProvider",
			"textDocument/references": "referencesProvider",
			"textDocument/implementation": "implementationProvider",
			"textDocument/typeDefinition": "typeDefinitionProvider",
			"textDocument/hover": "hoverProvider",
			"textDocument/documentSymbol": "documentSymbolProvider",
			"workspace/symbol": "workspaceSymbolProvider",
			"textDocument/rename": "renameProvider",
			"textDocument/codeAction": "codeActionProvider",
			"textDocument/prepareCallHierarchy": "callHierarchyProvider",
			"callHierarchy/incomingCalls": "callHierarchyProvider",
			"callHierarchy/outgoingCalls": "callHierarchyProvider",
			"workspace/executeCommand": "executeCommandProvider",
			"textDocument/diagnostic": "diagnosticProvider",
		};
		if (method === "codeAction/resolve") {
			const provider = this.capabilities.codeActionProvider;
			return (
				typeof provider === "object" &&
				provider !== null &&
				"resolveProvider" in provider &&
				provider.resolveProvider === true
			);
		}
		return providers[method] ? Boolean(this.capabilities[providers[method]]) : undefined;
	}
	private documents = new Map<string, TrackedDocument>();
	private published = new Map<string, PublishedDiagnostics>();
	private publishSeq = 0;
	private publishWaiters: PublishWaiter[] = [];
	private everPublished = false;
	private everPublishedVersioned = false;
	private tracer: LspTracer | undefined;

	constructor(options: LspClientOptions) {
		this.options = options;
		this.rootUri = pathToFileURL(options.rootDir).toString();
		this.tracer = options.tracer;
	}

	/** Enable or disable protocol tracing for this client. */
	setTracer(tracer: LspTracer | undefined): void {
		this.tracer = tracer;
	}

	get isAlive(): boolean {
		return this.alive && !this.disposed;
	}

	/** Whether the spawn/initialize handshake failed. Such a client never recovers. */
	get startFailed(): boolean {
		return this.startFailure;
	}

	/**
	 * Own one initialize handshake, including failure cleanup, for this client's lifetime.
	 * Callers may abandon their waits; the stored rejection remains observable to later callers.
	 */
	start(): Promise<void> {
		if (!this.startPromise) {
			const startedAt = performance.now();
			this.startPromise = this.disposed
				? Promise.reject(new LspOperationError("unavailable", "disposed", "LSP client is disposed"))
				: this.doStart()
						.finally(() => {
							this.startupDurationMs = performance.now() - startedAt;
						})
						.catch(async (error: unknown) => {
							this.startFailure = true;
							if (this.startupProcessTerminated) await this.startupStderrDrained;
							const original = error instanceof Error ? error : new Error(String(error));
							const stderr = this.startupStderr.trim();
							const enriched = new LspOperationError(
								original instanceof LspOperationError && original.outcome === "timeout"
									? "timeout"
									: "unavailable",
								original instanceof LspOperationError && original.outcome === "timeout"
									? "startup-timeout"
									: "startup-failed",
								stderr ? `${original.message}\nStartup stderr:\n${stderr}` : original.message,
							);
							this.exitError = enriched;
							this.dispose();
							throw enriched;
						});
			// Observe the terminal promise, not just doStart(): the enrichment catch rethrows.
			// Do not replace it with the caught promise, which would hide failure from callers.
			void this.startPromise.catch(() => {});
		}
		return this.startPromise;
	}

	private async doStart(): Promise<void> {
		const launch = this.options.launchContext;
		this.tracer?.log(
			this.options.serverName,
			"info",
			launch
				? `workspace: ${launch.workspaceRoot}; server root: ${this.options.rootDir}; configured argv: ${JSON.stringify(launch.configuredCommand)}; executable: ${this.options.command[0]}; source: ${launch.source}; attempt: ${launch.attempt}`
				: `server root: ${this.options.rootDir}; executable: ${this.options.command[0]}`,
		);
		this.tracer?.log(
			this.options.serverName,
			"info",
			`spawning: ${this.options.command.join(" ")} (root: ${this.options.rootDir})`,
		);
		const child = (this.options.serverSpawner ?? spawnServer)(
			this.options.command,
			this.options.rootDir,
			this.options.environment ?? getSubprocessEnv(),
		);
		this.child = child;
		this.startupStderrDrained = waitForStartupStderrDrain(child);

		const spawnFailure = new Promise<never>((_, reject) => {
			child.once("error", (error) => {
				this.startupProcessTerminated = true;
				this.handleExit(new Error(`Failed to start LSP server "${this.options.serverName}": ${error.message}`));
				reject(this.exitError);
			});
			child.once("exit", (code) => {
				this.startupProcessTerminated = true;
				if (!this.disposed && !this.alive) {
					this.handleExit(
						new Error(
							`LSP server "${this.options.serverName}" exited during startup (code ${code ?? "unknown"})`,
						),
					);
					reject(this.exitError);
				}
			});
		});
		// Avoid unhandled rejection when startup succeeds and this promise loses the race.
		spawnFailure.catch(() => {});

		child.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
		// Drain stderr so the server cannot block on a full pipe.
		child.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf-8");
			if (!this.startupComplete) {
				const next = this.startupStderr + text;
				this.startupStderr =
					next.length <= MAX_STARTUP_STDERR_CHARS ? next : next.slice(next.length - MAX_STARTUP_STDERR_CHARS);
			}
			this.tracer?.log(this.options.serverName, "stderr", text);
		});
		child.stdin?.on("error", () => {});
		child.on("exit", (code) => {
			this.tracer?.log(this.options.serverName, "info", `process exited (code ${code ?? "unknown"})`);
			if (this.alive) {
				this.handleExit(new Error(`LSP server "${this.options.serverName}" exited (code ${code ?? "unknown"})`));
			}
		});

		this.alive = true;
		const initializeResult = (await Promise.race([
			this.request("initialize", {
				processId: process.pid,
				rootUri: this.rootUri,
				workspaceFolders: [{ uri: this.rootUri, name: basename(this.options.rootDir) }],
				capabilities: {
					textDocument: {
						synchronization: { dynamicRegistration: false, didSave: false },
						publishDiagnostics: { versionSupport: true, relatedInformation: false },
						diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
						definition: { dynamicRegistration: false, linkSupport: true },
						implementation: { dynamicRegistration: false, linkSupport: true },
						typeDefinition: { dynamicRegistration: false, linkSupport: true },
						references: { dynamicRegistration: false },
						hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
						documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
						rename: { dynamicRegistration: false, prepareSupport: false },
						callHierarchy: { dynamicRegistration: false },
						codeAction: {
							dynamicRegistration: false,
							codeActionLiteralSupport: {
								codeActionKind: { valueSet: ["quickfix", "refactor", "source"] },
							},
							resolveSupport: { properties: ["edit"] },
						},
					},
					workspace: {
						configuration: true,
						workspaceFolders: true,
						didChangeWatchedFiles: { dynamicRegistration: false },
						didChangeConfiguration: { dynamicRegistration: false },
						symbol: { dynamicRegistration: false },
						applyEdit: true,
						workspaceEdit: {
							documentChanges: true,
							resourceOperations: ["create", "rename", "delete"],
							failureHandling: "abort",
						},
					},
					window: { workDoneProgress: false },
				},
				initializationOptions: this.options.initializationOptions,
			}),
			spawnFailure,
		])) as { capabilities?: Record<string, unknown>; serverInfo?: { name: string; version?: string } } | undefined;

		if (!initializeResult || typeof initializeResult !== "object") {
			throw new LspOperationError("request-failed", "invalid-initialize", "Malformed LSP initialize result");
		}
		this.capabilities = initializeResult.capabilities;
		this.serverInfo = initializeResult.serverInfo;
		this.supportsPullDiagnostics = Boolean(initializeResult?.capabilities?.diagnosticProvider);
		this.notify("initialized", {});
		if (this.options.settings !== undefined) {
			this.notify("workspace/didChangeConfiguration", { settings: this.options.settings });
		}
		this.startupComplete = true;
	}

	/**
	 * Sync a document and collect its diagnostics.
	 *
	 * Refreshes other open documents from disk first, so dependency changes made
	 * outside the tools are reflected. Uses pull diagnostics when the server
	 * supports them; otherwise waits for the server to publish diagnostics for
	 * the document. The first collection on a fresh server waits up to
	 * firstSettleMs (servers like tsserver publish nothing until the project has
	 * loaded); afterwards settleMs applies.
	 */
	async getDiagnostics(
		absolutePath: string,
		content: string,
		settleMs: number,
		firstSettleMs?: number,
		signal?: AbortSignal,
	): Promise<LspDiagnosticResult> {
		if (signal?.aborted) throw new LspOperationError("cancelled", "aborted", "Diagnostics collection aborted");
		await waitForLsp(this.start(), signal);
		const sinceSeq = this.publishSeq;
		const refreshed = await this.refreshStaleDocuments(absolutePath);
		const { uri, changed } = await this.syncContent(absolutePath, content);
		const key = normalizeUri(uri);
		if (signal?.aborted) throw new LspOperationError("cancelled", "aborted", "Diagnostics collection aborted");

		const epoch = this.diagnosticEpoch;
		const document = this.documents.get(key);
		const version = document?.version;
		// Recover dependency changes, never a replacement of the requested snapshot.
		const isCurrentDocument = (): boolean =>
			this.documents.get(key) === document && document?.version === version && document?.content === content;
		let pullFailure: LspResult | undefined;
		const collected = (diagnostics: LspDiagnostic[], evidence: Partial<LspResult>): LspDiagnosticResult => ({
			...lspResult(diagnostics.length ? "success" : "empty", "", evidence),
			diagnostics,
			diagnosticCount: diagnostics.length,
		});
		if (this.supportsPullDiagnostics) {
			// A dependency sync can supersede even a request-ordered pull. Retry
			// against the latest epoch, sharing the original two-request time budget.
			// Explicit server rejections still get only one retry.
			const requestTimeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
			const pullDeadline = performance.now() + 2 * requestTimeoutMs;
			let rejections = 0;
			while (rejections < 2 && performance.now() < pullDeadline) {
				const pullEpoch = this.diagnosticEpoch;
				try {
					const result = (await this.request(
						"textDocument/diagnostic",
						{ textDocument: { uri } },
						signal,
						Math.min(requestTimeoutMs, pullDeadline - performance.now()),
					)) as { kind?: string; items?: LspDiagnostic[] } | undefined;
					if (result?.kind !== "full" || !validDiagnostics(result.items)) {
						pullFailure = lspResult("request-failed", "Invalid pull diagnostics result", {
							reason: "invalid-pull",
						});
						break;
					}
					if (pullEpoch === this.diagnosticEpoch && isCurrentDocument()) {
						this.everPublished = true;
						return collected(result.items, { source: "pull", freshness: "fresh", reason: "current-pull" });
					}
					pullFailure = lspResult("timeout", "Pull diagnostics superseded by document synchronization", {
						reason: "superseded-pull",
					});
					if (!isCurrentDocument()) break;
				} catch (error) {
					// Retry once on an explicit server rejection (e.g. ContentModified
					// while recomputing): those come back fast, so a retry is cheap.
					// Timeouts, aborts, and server exits would only double the worst-case
					// latency, so fall back to published diagnostics immediately.
					pullFailure = lspErrorResult(error);
					if (pullFailure.outcome === "cancelled" || pullFailure.outcome === "timeout" || !this.isAlive) {
						return { ...pullFailure, diagnostics: [] };
					}
					if (!(error instanceof LspResponseError) || !isCurrentDocument()) {
						break;
					}
					rejections++;
				}
			}
		}

		// Reuse the last publish only when nothing changed at all: unchanged
		// content cannot republish, but refreshed dependencies can change this
		// document's diagnostics, so any refresh forces a fresh wait.
		const existing = this.published.get(key);
		if (
			!pullFailure &&
			!changed &&
			refreshed.length === 0 &&
			existing?.epoch === this.diagnosticEpoch &&
			isCurrentDocument()
		) {
			return collected(existing.diagnostics, {
				source: "cache",
				freshness: existing.version === undefined ? "unverified" : "fresh",
				reason: "unchanged-publication",
			});
		}

		const timeoutMs = this.everPublished ? settleMs : Math.max(settleMs, firstSettleMs ?? settleMs);
		const deadline = performance.now() + timeoutMs;
		let waitSinceSeq = sinceSeq;
		let entry: PublishedDiagnostics | undefined;
		while (true) {
			const collectionEpoch = this.diagnosticEpoch;
			await this.waitForPublish(key, waitSinceSeq, Math.max(0, deadline - performance.now()), signal);
			entry = this.published.get(key);
			// Unversioned publications may race a document or dependency sync.
			// Apply the same grace window after recovery as after our own sync,
			// but never extend the collection's original deadline.
			if (
				(changed || refreshed.length > 0 || collectionEpoch !== epoch) &&
				entry !== undefined &&
				entry.epoch === collectionEpoch &&
				entry.seq > waitSinceSeq &&
				entry.version === undefined
			) {
				// Versioned servers get the remaining deadline to correct an anomalous
				// unversioned publish; unversioned-only servers get a short grace period.
				const remainingMs = this.everPublishedVersioned
					? deadline - performance.now()
					: Math.min(deadline - performance.now(), UNVERSIONED_REPUBLISH_GRACE_MS);
				if (remainingMs > 0) {
					await this.waitForPublish(key, entry.seq, remainingMs, signal);
					entry = this.published.get(key) ?? entry;
				}
			}
			if (signal?.aborted)
				return {
					...lspResult("cancelled", "Diagnostics collection aborted", { reason: "aborted" }),
					diagnostics: [],
				};
			if (!this.isAlive)
				return {
					...lspResult("unavailable", "Language server exited during diagnostics", { reason: "server-exit" }),
					diagnostics: [],
				};
			if (!isCurrentDocument()) break;
			if (
				entry &&
				entry.seq > waitSinceSeq &&
				entry.epoch === this.diagnosticEpoch &&
				collectionEpoch === this.diagnosticEpoch
			) {
				return collected(entry.diagnostics, {
					source: "push",
					freshness: entry.version === undefined ? "unverified" : "fresh",
					reason: entry.version === undefined ? "unversioned-publication" : "current-publication",
				});
			}
			if (performance.now() >= deadline) break;
			// Restart at the current epoch. Retain a publication already received
			// in that epoch, but advance past stale entries so they cannot spin the wait.
			if (entry && entry.epoch !== this.diagnosticEpoch) waitSinceSeq = Math.max(waitSinceSeq, entry.seq);
		}
		return {
			...lspResult(
				pullFailure?.outcome ?? "timeout",
				pullFailure?.text ?? "No current diagnostic publication before deadline",
				{
					reason: pullFailure?.reason ?? "no-current-publication",
					source: entry ? "cache" : "none",
					freshness: entry ? "stale" : "unknown",
				},
			),
			diagnostics: [],
		};
	}

	/** Sync a document to the server and return its URI. Starts the server if needed. */
	async openDocument(absolutePath: string, content: string, signal?: AbortSignal): Promise<string> {
		if (signal?.aborted) throw new LspOperationError("cancelled", "aborted", "LSP operation aborted");
		await waitForLsp(this.start(), signal);
		const { uri } = await this.syncContent(absolutePath, content);
		return uri;
	}

	/**
	 * Re-sync any open document whose on-disk content changed outside the edit
	 * and write tools (e.g. via bash). Deleted documents are closed. Servers are
	 * additionally notified via workspace/didChangeWatchedFiles so they can
	 * invalidate caches. Returns the absolute paths that were refreshed.
	 */
	async refreshStaleDocuments(excludePath?: string): Promise<string[]> {
		if (!this.isAlive) {
			return [];
		}
		const excludeKey = excludePath ? normalizeUri(pathToFileURL(excludePath).toString()) : undefined;
		const refreshed: Array<{ uri: string; type: number; absolutePath: string }> = [];
		const closeDocument = (key: string, document: TrackedDocument): void => {
			this.documents.delete(key);
			this.published.delete(key);
			this.notify("textDocument/didClose", { textDocument: { uri: document.uri } });
			refreshed.push({ uri: document.uri, type: FILE_CHANGE_TYPE_DELETED, absolutePath: document.absolutePath });
		};
		for (const [key, document] of [...this.documents]) {
			if (key === excludeKey) {
				continue;
			}
			let refreshPath = document.absolutePath;
			if (this.options.resolveTrackedDocumentPath) {
				try {
					const resolvedPath = await this.options.resolveTrackedDocumentPath(document.absolutePath);
					if (!resolvedPath) {
						closeDocument(key, document);
						continue;
					}
					refreshPath = resolvedPath;
				} catch {
					closeDocument(key, document);
					continue;
				}
			}
			let fileStat: { mtimeMs: number; size: number };
			try {
				fileStat = await stat(refreshPath);
			} catch {
				// File was deleted (or became unreadable): close it on the server.
				closeDocument(key, document);
				continue;
			}
			if (fileStat.mtimeMs === document.mtimeMs && fileStat.size === document.size) {
				continue;
			}
			let content: string;
			try {
				content = await readFile(refreshPath, "utf-8");
			} catch {
				continue;
			}
			document.mtimeMs = fileStat.mtimeMs;
			document.size = fileStat.size;
			if (content === document.content) {
				continue;
			}
			document.content = content;
			document.version++;
			this.notify("textDocument/didChange", {
				textDocument: { uri: document.uri, version: document.version },
				contentChanges: [{ text: content }],
			});
			refreshed.push({ uri: document.uri, type: FILE_CHANGE_TYPE_CHANGED, absolutePath: document.absolutePath });
		}
		if (refreshed.length > 0) {
			this.diagnosticEpoch++;
			this.notify("workspace/didChangeWatchedFiles", {
				changes: refreshed.map(({ uri, type }) => ({ uri, type })),
			});
		}
		return refreshed.map(({ absolutePath }) => absolutePath);
	}

	/** Send an arbitrary LSP request. Starts the server if needed. */
	async sendRequest(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
		if (signal?.aborted) throw new LspOperationError("cancelled", "aborted", "LSP operation aborted");
		await waitForLsp(this.start(), signal);
		if (this.supportsMethod(method) === false) {
			throw new LspOperationError(
				"unsupported",
				"capability-absent",
				`Server does not advertise ${method}; use search/build fallback.`,
			);
		}
		return this.request(method, params, signal);
	}

	/** Whether the document is currently open (synced) on the server. */
	isDocumentOpen(absolutePath: string): boolean {
		return this.documents.has(normalizeUri(pathToFileURL(absolutePath).toString()));
	}

	/** Root directory this language server was initialized with. */
	get rootDir(): string {
		return this.options.rootDir;
	}

	/** Number of documents currently open on the server. */
	get openDocumentCount(): number {
		return this.documents.size;
	}

	/** Absolute paths of all documents currently open on the server. */
	getOpenDocumentPaths(): string[] {
		return [...this.documents.values()].map((document) => document.absolutePath);
	}

	/** Last published diagnostics for a document, if any. */
	getPublishedDiagnostics(absolutePath: string): LspDiagnostic[] {
		const entry = this.published.get(normalizeUri(pathToFileURL(absolutePath).toString()));
		return entry?.epoch === this.diagnosticEpoch ? entry.diagnostics : [];
	}

	/** @internal Capture the exact tracked-document state at the start of an LSP request. */
	captureWorkspaceEditSnapshots(): WorkspaceEditDocumentSnapshot[] {
		return [...this.documents.values()].map((document) => ({
			uri: document.uri,
			absolutePath: document.absolutePath,
			version: document.version,
			content: document.content,
		}));
	}

	/** @internal Reconcile successful on-disk WorkspaceEdit operations with server state. */
	async applyWorkspaceChanges(changes: readonly AppliedWorkspaceChange[]): Promise<void> {
		if (changes.length) this.diagnosticEpoch++;
		for (const change of changes) {
			if (change.kind === "edit" || change.kind === "create") {
				const uri = pathToFileURL(change.path).toString();
				const key = normalizeUri(uri);
				const document = this.documents.get(key);
				if (document) {
					document.content = change.content;
					document.version++;
					await this.updateTrackedStat(document);
					this.notify("textDocument/didChange", {
						textDocument: { uri: document.uri, version: document.version },
						contentChanges: [{ text: change.content }],
					});
				} else {
					this.notifyWatchedFile(
						uri,
						change.kind === "create" && !change.overwritten ? FILE_CHANGE_TYPE_CREATED : FILE_CHANGE_TYPE_CHANGED,
					);
				}
				continue;
			}

			if (change.kind === "rename") {
				const destinationDocuments = [...this.documents.entries()].filter(([, document]) =>
					isPathAtOrInside(change.newPath, document.absolutePath),
				);
				for (const [key, document] of destinationDocuments) {
					this.documents.delete(key);
					this.published.delete(key);
					this.notify("textDocument/didClose", { textDocument: { uri: document.uri } });
				}

				const sourceDocuments = [...this.documents.entries()].filter(([, document]) =>
					isPathAtOrInside(change.oldPath, document.absolutePath),
				);
				if (sourceDocuments.length === 0) {
					this.notifyWatchedFile(pathToFileURL(change.oldPath).toString(), FILE_CHANGE_TYPE_DELETED);
					this.notifyWatchedFile(pathToFileURL(change.newPath).toString(), FILE_CHANGE_TYPE_CREATED);
					continue;
				}
				for (const [key, document] of sourceDocuments) {
					this.documents.delete(key);
					this.published.delete(key);
					this.notify("textDocument/didClose", { textDocument: { uri: document.uri } });
					const suffix = relative(change.oldPath, document.absolutePath);
					const absolutePath = suffix ? join(change.newPath, suffix) : change.newPath;
					const uri = pathToFileURL(absolutePath).toString();
					const content = suffix || change.content === undefined ? document.content : change.content;
					const moved: TrackedDocument = { uri, absolutePath, version: 1, content };
					await this.updateTrackedStat(moved);
					this.documents.set(normalizeUri(uri), moved);
					this.notify("textDocument/didOpen", {
						textDocument: {
							uri,
							languageId: languageIdForExtension(extname(absolutePath)),
							version: 1,
							text: content,
						},
					});
				}
				continue;
			}

			const deletedDocuments = [...this.documents.entries()].filter(([, document]) =>
				isPathAtOrInside(change.path, document.absolutePath),
			);
			if (deletedDocuments.length === 0) {
				this.notifyWatchedFile(pathToFileURL(change.path).toString(), FILE_CHANGE_TYPE_DELETED);
				continue;
			}
			for (const [key, document] of deletedDocuments) {
				this.documents.delete(key);
				this.published.delete(key);
				this.notify("textDocument/didClose", { textDocument: { uri: document.uri } });
			}
		}
	}

	private async updateTrackedStat(document: TrackedDocument): Promise<void> {
		try {
			const metadata = await stat(document.absolutePath);
			document.mtimeMs = metadata.mtimeMs;
			document.size = metadata.size;
		} catch {
			document.mtimeMs = undefined;
			document.size = undefined;
		}
	}

	private notifyWatchedFile(uri: string, type: number): void {
		this.notify("workspace/didChangeWatchedFiles", { changes: [{ uri, type }] });
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		const child = this.child;
		this.handleExit(new Error(`LSP client for "${this.options.serverName}" was disposed`));
		if (!child) {
			return;
		}
		try {
			this.sendMessage({ jsonrpc: "2.0", method: "exit" });
		} catch {
			// Best-effort graceful exit.
		}
		const killTimer = setTimeout(() => killProcessTree(child), 2000);
		killTimer.unref();
		child.once("exit", () => clearTimeout(killTimer));
		if (process.platform === "win32") {
			// cross-spawn may launch a command shim process, so terminate the whole
			// process tree instead of risking an orphaned language server.
			killProcessTree(child);
			clearTimeout(killTimer);
			return;
		}
		try {
			child.kill();
		} catch {
			// Process is already gone.
		}
	}

	// =========================================================================
	// Document sync and diagnostics collection
	// =========================================================================

	/**
	 * Sync explicit content for a document (didOpen on first sight, didChange
	 * after). Returns whether the synced view actually changed.
	 */
	private async syncContent(absolutePath: string, content: string): Promise<{ uri: string; changed: boolean }> {
		const uri = pathToFileURL(absolutePath).toString();
		const key = normalizeUri(uri);
		const existing = this.documents.get(key);

		let mtimeMs: number | undefined;
		let size: number | undefined;
		try {
			const fileStat = await stat(absolutePath);
			mtimeMs = fileStat.mtimeMs;
			size = fileStat.size;
		} catch {
			// Stat is only a staleness filter; missing files still sync in-memory content.
		}

		if (!existing) {
			this.diagnosticEpoch++;
			this.documents.set(key, { uri, absolutePath, version: 1, content, mtimeMs, size });
			this.notify("textDocument/didOpen", {
				textDocument: {
					uri,
					languageId: languageIdForExtension(extname(absolutePath)),
					version: 1,
					text: content,
				},
			});
			return { uri, changed: true };
		}

		existing.mtimeMs = mtimeMs;
		existing.size = size;
		if (existing.content === content) {
			return { uri, changed: false };
		}
		this.diagnosticEpoch++;
		existing.content = content;
		existing.version++;
		this.notify("textDocument/didChange", {
			textDocument: { uri, version: existing.version },
			contentChanges: [{ text: content }],
		});
		return { uri, changed: true };
	}

	private waitForPublish(key: string, sinceSeq: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
		const existing = this.published.get(key);
		if ((existing && existing.seq > sinceSeq) || !this.isAlive || signal?.aborted) {
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			let settled = false;
			const finish = (): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", finish);
				const index = this.publishWaiters.indexOf(waiter);
				if (index !== -1) {
					this.publishWaiters.splice(index, 1);
				}
				resolve();
			};
			const timer = setTimeout(finish, timeoutMs);
			timer.unref();
			const waiter: PublishWaiter = { uri: key, sinceSeq, resolve: finish };
			this.publishWaiters.push(waiter);
			signal?.addEventListener("abort", finish, { once: true });
		});
	}

	// =========================================================================
	// JSON-RPC transport
	// =========================================================================

	private request(
		method: string,
		params: unknown,
		signal?: AbortSignal,
		timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
	): Promise<unknown> {
		if (!this.alive) {
			return Promise.reject(this.exitError ?? new Error(`LSP server "${this.options.serverName}" is not running`));
		}
		if (signal?.aborted) {
			return Promise.reject(new LspOperationError("cancelled", "aborted", `LSP request "${method}" was aborted`));
		}
		const id = this.nextRequestId++;
		return new Promise((resolve, reject) => {
			// Wrap both settle paths so the timer and abort listener are always
			// cleaned up, no matter who settles the request (response, exit,
			// timeout, or abort).
			const settle = <T>(fn: (value: T) => void): ((value: T) => void) => {
				return (value: T): void => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					fn(value);
				};
			};
			const onAbort = (): void => {
				this.pendingRequests.delete(id);
				settle(reject)(new LspOperationError("cancelled", "aborted", `LSP request "${method}" was aborted`));
			};
			const timer = setTimeout(() => {
				this.pendingRequests.delete(id);
				settle(reject)(
					new LspOperationError(
						"timeout",
						"request-deadline",
						`LSP request "${method}" timed out after ${timeoutMs}ms`,
					),
				);
			}, timeoutMs);
			timer.unref();
			signal?.addEventListener("abort", onAbort, { once: true });
			this.pendingRequests.set(id, { resolve: settle(resolve), reject: settle(reject), timer });
			try {
				this.sendMessage({ jsonrpc: "2.0", id, method, params });
			} catch (error) {
				this.pendingRequests.delete(id);
				settle(reject)(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	private notify(method: string, params: unknown): void {
		if (!this.alive) {
			return;
		}
		this.sendMessage({ jsonrpc: "2.0", method, params });
	}

	private sendMessage(message: JsonRpcMessage): void {
		const body = JSON.stringify(message);
		this.tracer?.log(this.options.serverName, "send", body);
		const length = Buffer.byteLength(body, "utf-8");
		this.child?.stdin?.write(`Content-Length: ${length}\r\n\r\n${body}`);
	}

	private onData(chunk: Buffer): void {
		this.readBuffer = Buffer.concat([this.readBuffer, chunk]);
		while (true) {
			const headerEnd = this.readBuffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) {
				return;
			}
			const header = this.readBuffer.subarray(0, headerEnd).toString("ascii");
			const lengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
			if (!lengthMatch) {
				// Malformed header; drop it and resync on the next message boundary.
				this.readBuffer = this.readBuffer.subarray(headerEnd + 4);
				continue;
			}
			const contentLength = Number.parseInt(lengthMatch[1], 10);
			const messageStart = headerEnd + 4;
			if (this.readBuffer.length < messageStart + contentLength) {
				return;
			}
			const body = this.readBuffer.subarray(messageStart, messageStart + contentLength).toString("utf-8");
			this.readBuffer = this.readBuffer.subarray(messageStart + contentLength);
			this.tracer?.log(this.options.serverName, "recv", body);
			try {
				this.onMessage(JSON.parse(body) as JsonRpcMessage);
			} catch {
				// Ignore unparseable messages.
			}
		}
	}

	private onMessage(message: JsonRpcMessage): void {
		if (message.id !== undefined && message.method !== undefined) {
			this.handleServerRequest(message.id, message.method, message.params);
			return;
		}
		if (message.id !== undefined) {
			const pending = this.pendingRequests.get(Number(message.id));
			if (pending) {
				this.pendingRequests.delete(Number(message.id));
				clearTimeout(pending.timer);
				if (message.error) {
					pending.reject(new LspResponseError(message.error.code, message.error.message));
				} else {
					pending.resolve(message.result);
				}
			}
			return;
		}
		if (message.method === "textDocument/publishDiagnostics") {
			const params = message.params as { uri?: string; version?: number; diagnostics?: LspDiagnostic[] } | undefined;
			if (typeof params?.uri === "string" && validDiagnostics(params.diagnostics)) {
				const key = normalizeUri(params.uri);
				this.everPublished = true;
				if (params.version !== undefined) {
					this.everPublishedVersioned = true;
				}
				// Ignore publishes computed against an older synced version: they
				// would satisfy the settle wait with stale diagnostics.
				const document = this.documents.get(key);
				if (params.version !== undefined && document !== undefined && params.version !== document.version) {
					return;
				}
				const diagnostics = Array.isArray(params.diagnostics) ? params.diagnostics : [];
				// Unversioned publishes can be computed against stale content. Drop
				// those whose positions point past the end of the synced content:
				// they describe an older snapshot and would otherwise satisfy the
				// settle wait (and the cross-file sweep) with stale diagnostics.
				// Tolerate line === lineCount: the spec tells clients to clamp
				// out-of-range positions, and linters legitimately emit end-of-file
				// diagnostics one past the last line (e.g. missing trailing newline).
				if (params.version === undefined && document !== undefined && diagnostics.length > 0) {
					const lineCount = document.content.split("\n").length;
					if (diagnostics.some((diagnostic) => (diagnostic.range?.start?.line ?? 0) > lineCount)) {
						this.tracer?.log(
							this.options.serverName,
							"info",
							`dropping stale unversioned publish for ${params.uri} (position past end of synced content)`,
						);
						return;
					}
				}
				this.publishSeq++;
				this.published.set(key, {
					diagnostics,
					epoch: this.diagnosticEpoch,
					seq: this.publishSeq,
					version: params.version,
				});
				for (const waiter of [...this.publishWaiters]) {
					if (waiter.uri === key) {
						waiter.resolve();
					}
				}
			}
		}
	}

	private handleServerRequest(id: number | string, method: string, params: unknown): void {
		if (method === "workspace/applyEdit" && this.options.onApplyEdit) {
			const edit = (params as { edit?: unknown } | undefined)?.edit;
			void this.options
				.onApplyEdit(edit)
				.catch(
					(error: unknown): LspApplyEditResult => ({
						applied: false,
						failureReason: error instanceof Error ? error.message : String(error),
					}),
				)
				.then((result) => {
					try {
						this.sendMessage({
							jsonrpc: "2.0",
							id,
							result: typeof result === "boolean" ? { applied: result } : result,
						});
					} catch {
						// Server may have exited.
					}
				});
			return;
		}
		// Respond with sensible empty defaults so servers that depend on client
		// round-trips (configuration, capability registration) do not stall.
		let result: unknown = null;
		if (method === "workspace/configuration") {
			const items = (params as { items?: Array<{ section?: unknown }> } | undefined)?.items;
			result = Array.isArray(items)
				? items.map((item) => lookupConfigSection(this.options.settings, item?.section))
				: [];
		} else if (method === "workspace/workspaceFolders") {
			result = [{ uri: this.rootUri, name: basename(this.options.rootDir) }];
		}
		try {
			this.sendMessage({ jsonrpc: "2.0", id, result });
		} catch {
			// Server may have exited.
		}
	}

	private handleExit(error: Error): void {
		this.alive = false;
		this.exitError = this.exitError ?? new LspOperationError("unavailable", "server-exit", error.message);
		for (const [, pending] of this.pendingRequests) {
			clearTimeout(pending.timer);
			pending.reject(this.exitError);
		}
		this.pendingRequests.clear();
		for (const waiter of [...this.publishWaiters]) {
			waiter.resolve();
		}
		this.publishWaiters = [];
	}
}
