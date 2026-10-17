import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import {
	createEmptyIrohRemoteHostState,
	type IrohRemoteClient,
	type IrohRemoteHostState,
	type IrohRemotePairingSecretTombstone,
	type IrohRemotePendingPairingTicket,
	type IrohRemoteRevokedClient,
	type IrohRemoteWorkspace,
	type IrohRemoteWorkspaceWorktree,
	parseIrohRemoteHostState,
} from "../core/remote/iroh/state.ts";
import { writeDurableAtomicFile } from "../utils/durable-atomic-write.ts";
import {
	type IrohManagedRelayAppEndpoint,
	type IrohManagedRelayCredential,
	type IrohManagedRelayCredentialClaim,
	parseIrohManagedRelayAppEndpoint,
	parseIrohManagedRelayCredential,
	parseIrohManagedRelayCredentialClaim,
} from "./relay-credential.ts";

/** How long a detached idle conversation stays open in its worker by default (the state's `detachedRuntimeTtlMs`). */
export const DEFAULT_DETACHED_RUNTIME_TTL_MS = 30 * 60 * 1000;

/**
 * Persistent daemon state. The pairing/client sections reuse the remote host
 * state shapes verbatim, including push targets.
 */
export interface VoltdStateFileV1 {
	version: 1;
	/** Iroh secret key bytes; the saved host identity paired phones dial. */
	irohSecretKey?: number[];
	clients: IrohRemoteClient[];
	revokedClients: IrohRemoteRevokedClient[];
	workspaceGenerationCounter: NonNullable<IrohRemoteHostState["workspaceGenerationCounter"]>;
	workspaceGenerations: NonNullable<IrohRemoteHostState["workspaceGenerations"]>;
	workspaces: IrohRemoteWorkspace[];
	worktrees: IrohRemoteWorkspaceWorktree[];
	pendingPairingTickets: IrohRemotePendingPairingTicket[];
	pairingSecretTombstones: IrohRemotePairingSecretTombstone[];
	settings: {
		/** Detached headless runtime retention TTL. */
		detachedRuntimeTtlMs: number;
		/** Tool allowlist applied ONLY to daemon-owned headless runtimes. */
		allowTools: string[] | null;
		/** Active daemon theme (theme_set); undefined falls back to the default theme. */
		themeName?: string;
		/** Push sanitized resolved theme tokens to capable phones (§9.5); OFF by default. */
		themeTokenPush?: boolean;
		/** Hold a keep-awake (prevent system sleep) assertion while the daemon runs; OFF by default. */
		keepAwakeEnabled?: boolean;
		/** Static bearer token for self-managed relays using access.shared_token. */
		relayAuthToken?: string;
		/** Refreshable node-bound credential for Volt-managed JWT relays. */
		relayCredential?: IrohManagedRelayCredential;
		/** Durable one-time broker claim retained across daemon restart until exchange. */
		relayCredentialClaim?: IrohManagedRelayCredentialClaim;
		/** Broker app endpoints approved for this grant, including durable host-revocation work. */
		relayCredentialAppEndpoints?: IrohManagedRelayAppEndpoint[];
		/** Durable, non-usable credential retained only to finish broker revocation. */
		relayCredentialRevocation?: IrohManagedRelayCredential;
		/** Worktree checkout retention and startup reconciliation policies. */
		worktreeCleanup?: WorktreeCleanupSettings;
		/**
		 * Pinned IPv4 UDP port of the Iroh endpoint. Reusing it on restart keeps
		 * the direct address in saved phone tickets dialable across restarts.
		 */
		irohBindPort?: number;
	};
}

export interface WorktreeCleanupSettings {
	/** Archive inactive disposable checkouts after the TTL (default enabled, one hour). */
	retention?: { enabled: boolean; ttlMs: number };
	/** Reconcile worktree records/checkouts during daemon startup (default true). */
	pruneOnStart?: boolean;
}

export interface ResolvedWorktreeCleanupPolicy {
	retention: { enabled: boolean; ttlMs: number } | undefined;
	pruneOnStart: boolean;
}

/** Apply defaults: one-hour retention and startup reconciliation. */
export function resolveWorktreeCleanupPolicy(
	settings: Pick<VoltdStateFileV1["settings"], "worktreeCleanup">,
): ResolvedWorktreeCleanupPolicy {
	const cleanup = settings.worktreeCleanup;
	const retention =
		cleanup?.retention?.enabled === false
			? undefined
			: {
					enabled: true,
					ttlMs: cleanup?.retention?.ttlMs && cleanup.retention.ttlMs > 0 ? cleanup.retention.ttlMs : 3_600_000,
				};
	return { retention, pruneOnStart: cleanup?.pruneOnStart !== false };
}

function parseRelayCredentialAppEndpoints(value: unknown): IrohManagedRelayAppEndpoint[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		throw new Error("relay credential app endpoints must be an array");
	}
	return value.map(parseIrohManagedRelayAppEndpoint);
}

function parseWorktreeCleanupSettings(value: unknown): WorktreeCleanupSettings | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const retentionRecord =
		typeof record.retention === "object" && record.retention !== null && !Array.isArray(record.retention)
			? (record.retention as Record<string, unknown>)
			: undefined;
	const retention =
		retentionRecord !== undefined &&
		typeof retentionRecord.enabled === "boolean" &&
		typeof retentionRecord.ttlMs === "number" &&
		Number.isInteger(retentionRecord.ttlMs) &&
		retentionRecord.ttlMs > 0
			? { enabled: retentionRecord.enabled, ttlMs: retentionRecord.ttlMs }
			: undefined;
	const pruneOnStart = typeof record.pruneOnStart === "boolean" ? record.pruneOnStart : undefined;
	if (retention === undefined && pruneOnStart === undefined) {
		return undefined;
	}
	return {
		...(retention === undefined ? {} : { retention }),
		...(pruneOnStart === undefined ? {} : { pruneOnStart }),
	};
}

export function createEmptyVoltdState(): VoltdStateFileV1 {
	return {
		version: 1,
		irohSecretKey: undefined,
		clients: [],
		revokedClients: [],
		workspaceGenerationCounter: 0,
		workspaceGenerations: [],
		workspaces: [],
		worktrees: [],
		pendingPairingTickets: [],
		pairingSecretTombstones: [],
		settings: {
			detachedRuntimeTtlMs: DEFAULT_DETACHED_RUNTIME_TTL_MS,
			allowTools: null,
		},
	};
}

export function voltdStateToHostState(state: VoltdStateFileV1): IrohRemoteHostState {
	return {
		hostSecretKey: state.irohSecretKey,
		clients: state.clients,
		revokedClients: state.revokedClients,
		workspaceGenerationCounter: state.workspaceGenerationCounter,
		workspaceGenerations: state.workspaceGenerations,
		workspaces: state.workspaces,
		worktrees: state.worktrees,
		pendingPairingTickets: state.pendingPairingTickets,
		pairingSecretTombstones: state.pairingSecretTombstones,
	};
}

export function hostStateToVoltdState(
	hostState: IrohRemoteHostState,
	settings: VoltdStateFileV1["settings"],
): VoltdStateFileV1 {
	return {
		version: 1,
		irohSecretKey: hostState.hostSecretKey,
		clients: hostState.clients,
		revokedClients: hostState.revokedClients,
		workspaceGenerationCounter: hostState.workspaceGenerationCounter,
		workspaceGenerations: hostState.workspaceGenerations,
		workspaces: hostState.workspaces,
		worktrees: hostState.worktrees,
		pendingPairingTickets: hostState.pendingPairingTickets,
		pairingSecretTombstones: hostState.pairingSecretTombstones,
		settings,
	};
}

export function parseVoltdState(value: unknown): VoltdStateFileV1 {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("voltd state must be an object");
	}
	const record = value as Record<string, unknown>;
	if (record.version !== 1) {
		throw new Error(`unsupported voltd state version: ${String(record.version)}`);
	}
	const hostState = parseIrohRemoteHostState({
		...record,
		hostSecretKey: record.irohSecretKey,
	});
	const settings = typeof record.settings === "object" && record.settings !== null ? record.settings : {};
	const settingsRecord = settings as Record<string, unknown>;
	const detachedRuntimeTtlMs =
		typeof settingsRecord.detachedRuntimeTtlMs === "number" &&
		Number.isInteger(settingsRecord.detachedRuntimeTtlMs) &&
		settingsRecord.detachedRuntimeTtlMs > 0
			? settingsRecord.detachedRuntimeTtlMs
			: DEFAULT_DETACHED_RUNTIME_TTL_MS;
	const allowTools = Array.isArray(settingsRecord.allowTools)
		? settingsRecord.allowTools.filter((tool): tool is string => typeof tool === "string")
		: null;
	const themeName = typeof settingsRecord.themeName === "string" ? settingsRecord.themeName : undefined;
	const themeTokenPush = settingsRecord.themeTokenPush === true;
	const keepAwakeEnabled = settingsRecord.keepAwakeEnabled === true;
	const relayAuthToken =
		typeof settingsRecord.relayAuthToken === "string" && settingsRecord.relayAuthToken.length > 0
			? settingsRecord.relayAuthToken
			: undefined;
	const relayCredential =
		settingsRecord.relayCredential === undefined
			? undefined
			: parseIrohManagedRelayCredential(settingsRecord.relayCredential);
	const relayCredentialClaim =
		settingsRecord.relayCredentialClaim === undefined
			? undefined
			: parseIrohManagedRelayCredentialClaim(settingsRecord.relayCredentialClaim);
	const relayCredentialAppEndpoints = parseRelayCredentialAppEndpoints(settingsRecord.relayCredentialAppEndpoints);
	const relayCredentialRevocation =
		settingsRecord.relayCredentialRevocation === undefined
			? undefined
			: parseIrohManagedRelayCredential(settingsRecord.relayCredentialRevocation);
	const worktreeCleanup = parseWorktreeCleanupSettings(settingsRecord.worktreeCleanup);
	const irohBindPort =
		typeof settingsRecord.irohBindPort === "number" &&
		Number.isInteger(settingsRecord.irohBindPort) &&
		settingsRecord.irohBindPort >= 1 &&
		settingsRecord.irohBindPort <= 65_535
			? settingsRecord.irohBindPort
			: undefined;
	return hostStateToVoltdState(hostState, {
		detachedRuntimeTtlMs,
		allowTools,
		...(themeName === undefined ? {} : { themeName }),
		...(themeTokenPush ? { themeTokenPush } : {}),
		...(keepAwakeEnabled ? { keepAwakeEnabled } : {}),
		...(relayAuthToken === undefined ? {} : { relayAuthToken }),
		...(relayCredential === undefined ? {} : { relayCredential }),
		...(relayCredentialClaim === undefined ? {} : { relayCredentialClaim }),
		...(relayCredentialAppEndpoints === undefined ? {} : { relayCredentialAppEndpoints }),
		...(relayCredentialRevocation === undefined ? {} : { relayCredentialRevocation }),
		...(worktreeCleanup === undefined ? {} : { worktreeCleanup }),
		...(irohBindPort === undefined ? {} : { irohBindPort }),
	});
}

export interface VoltdStateStoreOptions {
	statePath: string;
	/** Debounce for coalescing writes; flushes synchronously on close(). */
	debounceMs?: number;
	/** Durable writer seam for deterministic persistence-concurrency tests. */
	writeStateFile?: (path: string, content: string) => Promise<void>;
}

const DEFAULT_STATE_DEBOUNCE_MS = 250;

export interface InvalidVoltdStateFile {
	path: string;
	error: string;
}

function stateFileErrorMessage(path: string, error: unknown): string {
	const reason = error instanceof Error ? error.message : String(error);
	return `Daemon state file ${path} is invalid or incompatible: ${reason}`;
}

function invalidStateFileError(path: string, error: unknown): Error {
	return new Error(
		`${stateFileErrorMessage(path, error)}. Confirm regeneration from /remote or run ` +
			"`volt daemon regenerate-state`; existing phones will need to pair again.",
	);
}

/** Inspect persisted daemon state without modifying it. */
export function inspectVoltdStateFiles(agentDir: string): InvalidVoltdStateFile | undefined {
	const statePath = join(agentDir, "daemon", "state.json");
	if (!existsSync(statePath)) {
		return undefined;
	}
	try {
		parseVoltdState(JSON.parse(readFileSync(statePath, "utf8")));
		return undefined;
	} catch (error) {
		return { path: statePath, error: stateFileErrorMessage(statePath, error) };
	}
}

function readRecoverableVoltdState(path: string): VoltdStateFileV1 | undefined {
	try {
		return parseVoltdState(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return undefined;
	}
}

export interface RecoverableVoltdStateBackup {
	path: string;
	preservedIdentity: boolean;
}

/** Find the newest daemon-state backup that parses as current state. */
export function findRecoverableVoltdStateBackup(agentDir: string): RecoverableVoltdStateBackup | undefined {
	const daemonDir = join(agentDir, "daemon");
	if (!existsSync(daemonDir)) {
		return undefined;
	}
	const candidates = readdirSync(daemonDir)
		.filter((name) => /^state\.json\.invalid-\d+$/.test(name))
		.map((name) => {
			const path = join(daemonDir, name);
			return { path, modifiedAtMs: statSync(path).mtimeMs, state: readRecoverableVoltdState(path) };
		})
		.filter((candidate): candidate is typeof candidate & { state: VoltdStateFileV1 } => candidate.state !== undefined)
		.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);
	const candidate = candidates[0];
	return candidate
		? { path: candidate.path, preservedIdentity: candidate.state.irohSecretKey !== undefined }
		: undefined;
}

/** Replace current state from a validated backup, preserving the source and backing up the current file. */
export async function recoverVoltdStateFromBackup(
	agentDir: string,
	backupPath: string,
): Promise<{ previousStateBackupPath?: string; preservedIdentity: boolean }> {
	const candidate = findRecoverableVoltdStateBackup(agentDir);
	if (!candidate || candidate.path !== backupPath) {
		throw new Error("The selected daemon-state recovery backup is no longer available.");
	}
	const recovered = readRecoverableVoltdState(backupPath);
	if (!recovered) {
		throw new Error("The selected daemon-state backup is no longer recoverable.");
	}
	const statePath = join(agentDir, "daemon", "state.json");
	let previousStateBackupPath: string | undefined;
	if (existsSync(statePath)) {
		previousStateBackupPath = `${statePath}.invalid-${Date.now()}`;
		await rename(statePath, previousStateBackupPath);
	}
	await writeDurableAtomicFile(statePath, `${JSON.stringify(recovered, null, 2)}\n`);
	return {
		...(previousStateBackupPath === undefined ? {} : { previousStateBackupPath }),
		preservedIdentity: recovered.irohSecretKey !== undefined,
	};
}

/** Back up invalid state; the daemon starts with empty state and a new Iroh identity. */
export async function regenerateInvalidVoltdState(agentDir: string): Promise<{ backupPath: string }> {
	const invalid = inspectVoltdStateFiles(agentDir);
	if (!invalid) {
		throw new Error("Daemon state is valid; regeneration is not needed.");
	}
	const backupPath = `${invalid.path}.invalid-${Date.now()}`;
	await rename(invalid.path, backupPath);
	return { backupPath };
}

/** Debounced, atomic (tmp + rename, 0600) persistence for VoltdStateFileV1. */
export class VoltdStateStore {
	private readonly statePath: string;
	private readonly debounceMs: number;
	private readonly writeStateFile: (path: string, content: string) => Promise<void>;
	private current: VoltdStateFileV1 | undefined;
	private flushTimer: NodeJS.Timeout | undefined;
	private pendingFlush: Promise<void> = Promise.resolve();
	private stateRevision = 0;
	private persistedRevision = 0;

	constructor(options: VoltdStateStoreOptions) {
		this.statePath = options.statePath;
		this.debounceMs = options.debounceMs ?? DEFAULT_STATE_DEBOUNCE_MS;
		this.writeStateFile = options.writeStateFile ?? writeDurableAtomicFile;
	}

	async load(): Promise<VoltdStateFileV1> {
		if (this.current) {
			return this.current;
		}
		if (existsSync(this.statePath)) {
			try {
				this.current = parseVoltdState(JSON.parse(readFileSync(this.statePath, "utf8")));
			} catch (error) {
				throw invalidStateFileError(this.statePath, error);
			}
		} else {
			this.current = createEmptyVoltdState();
			this.markStateChanged();
			await this.enqueueWrite();
		}
		return this.current;
	}

	get state(): VoltdStateFileV1 {
		if (!this.current) {
			throw new Error("voltd state not loaded");
		}
		return this.current;
	}

	/** Replace the host-state portion (used as the state-manager write hook). */
	setHostState(hostState: IrohRemoteHostState): void {
		this.current = hostStateToVoltdState(hostState, this.state.settings);
		this.scheduleFlush();
	}

	/** Persist one authority snapshot and restore the previous in-memory authority on failure. */
	async persistHostState(hostState: IrohRemoteHostState): Promise<void> {
		const previousHostState = this.getHostState();
		this.setHostState(hostState);
		try {
			await this.flush();
		} catch (error) {
			this.current = hostStateToVoltdState(previousHostState, this.state.settings);
			this.markStateChanged();
			throw error;
		}
	}

	getHostState(): IrohRemoteHostState {
		return this.current ? voltdStateToHostState(this.current) : createEmptyIrohRemoteHostState();
	}

	updateSettings(settings: Partial<VoltdStateFileV1["settings"]>): void {
		this.current = { ...this.state, settings: { ...this.state.settings, ...settings } };
		this.scheduleFlush();
	}

	scheduleFlush(): void {
		this.markStateChanged();
		if (this.flushTimer) {
			return;
		}
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined;
			void this.enqueueWrite().catch(() => {});
		}, this.debounceMs);
		this.flushTimer.unref?.();
	}

	/**
	 * Force an immediate durable write, cancelling any pending debounce. Use after
	 * minting state that must survive a crash the moment it exists (e.g. the freshly
	 * generated Iroh identity, before the endpoint starts accepting pairings).
	 */
	async flush(): Promise<void> {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
		if (this.current) {
			// Force an explicit current-snapshot revision. Besides preserving flush's
			// historical semantics, this catches callers that deliberately mutate the
			// loaded state object before requesting durability.
			this.markStateChanged();
			await this.enqueueWrite();
		} else {
			await this.pendingFlush;
		}
	}

	/** Flush pending changes and stop the debounce timer (graceful shutdown). */
	async close(): Promise<void> {
		await this.flush();
	}

	private markStateChanged(): void {
		this.stateRevision++;
	}

	private enqueueWrite(): Promise<void> {
		const write = this.pendingFlush.then(() => this.writeNow());
		this.pendingFlush = write.catch(() => {});
		return write;
	}

	/** Must only be invoked through enqueueWrite so atomic renames cannot overtake one another. */
	private async writeNow(): Promise<void> {
		if (!this.current || this.persistedRevision >= this.stateRevision) {
			return;
		}
		const revision = this.stateRevision;
		const content = `${JSON.stringify(this.current, null, 2)}\n`;
		await this.writeStateFile(this.statePath, content);
		this.persistedRevision = Math.max(this.persistedRevision, revision);
	}
}
