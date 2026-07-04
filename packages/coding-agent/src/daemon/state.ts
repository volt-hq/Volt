import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	createEmptyIrohRemoteHostState,
	type IrohRemoteClient,
	type IrohRemoteHostState,
	type IrohRemotePairingSecretTombstone,
	type IrohRemotePendingPairingTicket,
	type IrohRemoteRevokedClient,
	type IrohRemoteWorkspace,
	parseIrohRemoteHostState,
} from "../core/remote/iroh/state.ts";
import { DEFAULT_INTEGRATED_DETACHED_RUNTIME_TTL_MS } from "../remote/integrated-runtime-retention.ts";

/**
 * Persistent daemon state. The pairing/client sections reuse the legacy host
 * state shapes verbatim (push targets and live-activity registrations stay
 * embedded in each client, as `src/core/remote/iroh/push.ts` expects), so the
 * Iroh secret key and paired clients survive migration byte-identically.
 */
export interface VoltdStateFileV1 {
	version: 1;
	/** Iroh secret key bytes; MUST survive migration so phones stay paired. */
	irohSecretKey?: number[];
	clients: IrohRemoteClient[];
	revokedClients: IrohRemoteRevokedClient[];
	workspaces: IrohRemoteWorkspace[];
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
	};
}

export function createEmptyVoltdState(): VoltdStateFileV1 {
	return {
		version: 1,
		irohSecretKey: undefined,
		clients: [],
		revokedClients: [],
		workspaces: [],
		pendingPairingTickets: [],
		pairingSecretTombstones: [],
		settings: {
			detachedRuntimeTtlMs: DEFAULT_INTEGRATED_DETACHED_RUNTIME_TTL_MS,
			allowTools: null,
		},
	};
}

export function voltdStateToHostState(state: VoltdStateFileV1): IrohRemoteHostState {
	return {
		hostSecretKey: state.irohSecretKey,
		clients: state.clients,
		revokedClients: state.revokedClients,
		workspaces: state.workspaces,
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
		revokedClients: hostState.revokedClients ?? [],
		workspaces: hostState.workspaces,
		pendingPairingTickets: hostState.pendingPairingTickets ?? [],
		pairingSecretTombstones: hostState.pairingSecretTombstones ?? [],
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
			: DEFAULT_INTEGRATED_DETACHED_RUNTIME_TTL_MS;
	const allowTools = Array.isArray(settingsRecord.allowTools)
		? settingsRecord.allowTools.filter((tool): tool is string => typeof tool === "string")
		: null;
	const themeName = typeof settingsRecord.themeName === "string" ? settingsRecord.themeName : undefined;
	const themeTokenPush = settingsRecord.themeTokenPush === true;
	return hostStateToVoltdState(hostState, {
		detachedRuntimeTtlMs,
		allowTools,
		...(themeName === undefined ? {} : { themeName }),
		...(themeTokenPush ? { themeTokenPush } : {}),
	});
}

export function getLegacyRemoteStatePath(agentDir: string): string {
	return join(agentDir, "remote", "iroh-host.json");
}

/**
 * One-time migration from remote/iroh-host.json: runs only when
 * daemon/state.json does not exist and the legacy file does. The secret key is
 * carried over verbatim (this is what preserves pairing) and the legacy file
 * is renamed to .migrated, never deleted.
 */
export function migrateLegacyRemoteState(agentDir: string, statePath: string): VoltdStateFileV1 | null {
	if (existsSync(statePath)) {
		return null;
	}
	const legacyPath = getLegacyRemoteStatePath(agentDir);
	if (!existsSync(legacyPath)) {
		return null;
	}
	const legacyState = parseIrohRemoteHostState(JSON.parse(readFileSync(legacyPath, "utf8")));
	return hostStateToVoltdState(legacyState, createEmptyVoltdState().settings);
}

export interface VoltdStateStoreOptions {
	agentDir: string;
	statePath: string;
	/** Debounce for coalescing writes; flushes synchronously on close(). */
	debounceMs?: number;
}

export interface LoadVoltdStateResult {
	state: VoltdStateFileV1;
	migratedFromLegacyState: boolean;
	/**
	 * Set when an unparseable state (or legacy) file was quarantined and the daemon
	 * started from empty state instead of failing to start. The value is the path
	 * the corrupt file was moved to. Callers should log this loudly: the persisted
	 * Iroh secret key and paired clients in the bad file were lost.
	 */
	recoveredFromCorruptStatePath?: string;
}

const DEFAULT_STATE_DEBOUNCE_MS = 250;

/** Debounced, atomic (tmp + rename, 0600) persistence for VoltdStateFileV1. */
export class VoltdStateStore {
	private readonly statePath: string;
	private readonly agentDir: string;
	private readonly debounceMs: number;
	private current: VoltdStateFileV1 | undefined;
	private flushTimer: NodeJS.Timeout | undefined;
	private pendingFlush: Promise<void> = Promise.resolve();
	private migrated = false;
	private recoveredFromCorruptStatePath: string | undefined;

	constructor(options: VoltdStateStoreOptions) {
		this.statePath = options.statePath;
		this.agentDir = options.agentDir;
		this.debounceMs = options.debounceMs ?? DEFAULT_STATE_DEBOUNCE_MS;
	}

	async load(): Promise<LoadVoltdStateResult> {
		if (this.current) {
			return { state: this.current, migratedFromLegacyState: this.migrated };
		}
		let migratedState: VoltdStateFileV1 | null = null;
		try {
			migratedState = migrateLegacyRemoteState(this.agentDir, this.statePath);
		} catch {
			// A corrupt legacy file must not brick first start; quarantine and skip it.
			this.recoveredFromCorruptStatePath = await this.quarantineCorruptStateFile(
				getLegacyRemoteStatePath(this.agentDir),
			);
		}
		if (migratedState) {
			this.current = migratedState;
			this.migrated = true;
			await this.writeNow();
			const legacyPath = getLegacyRemoteStatePath(this.agentDir);
			try {
				await rename(legacyPath, `${legacyPath}.migrated`);
			} catch (error) {
				// A daemon started concurrently (before the single-instance socket bind)
				// may have already migrated and renamed the legacy file. Its absence is
				// benign: the migrated content is identical and already persisted, so a
				// racing start must not crash here — it will fail cleanly at the socket
				// bind instead.
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					throw error;
				}
			}
			return { state: this.current, migratedFromLegacyState: true };
		}
		if (existsSync(this.statePath)) {
			try {
				this.current = parseVoltdState(JSON.parse(readFileSync(this.statePath, "utf8")));
			} catch {
				// An unparseable state file would otherwise make every start throw,
				// permanently bricking the daemon with no automated recovery. Quarantine
				// it and start from empty state so the daemon can bind. The persisted
				// Iroh secret key and pairings in the bad file are lost; that is surfaced
				// to the caller for a loud log.
				this.recoveredFromCorruptStatePath = await this.quarantineCorruptStateFile(this.statePath);
				this.current = createEmptyVoltdState();
				await this.writeNow();
			}
		} else {
			this.current = createEmptyVoltdState();
			await this.writeNow();
		}
		return {
			state: this.current,
			migratedFromLegacyState: false,
			...(this.recoveredFromCorruptStatePath === undefined
				? {}
				: { recoveredFromCorruptStatePath: this.recoveredFromCorruptStatePath }),
		};
	}

	/**
	 * Move an unparseable state file aside so a fresh start can proceed. Returns the
	 * quarantine path, or undefined when the file is absent or could not be moved
	 * (in which case the next writeNow() overwrites it in place with valid state).
	 */
	private async quarantineCorruptStateFile(path: string): Promise<string | undefined> {
		if (!existsSync(path)) {
			return undefined;
		}
		const quarantinePath = `${path}.corrupt-${Date.now()}`;
		try {
			await rename(path, quarantinePath);
			return quarantinePath;
		} catch {
			return undefined;
		}
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

	getHostState(): IrohRemoteHostState {
		return this.current ? voltdStateToHostState(this.current) : createEmptyIrohRemoteHostState();
	}

	updateSettings(settings: Partial<VoltdStateFileV1["settings"]>): void {
		this.current = { ...this.state, settings: { ...this.state.settings, ...settings } };
		this.scheduleFlush();
	}

	scheduleFlush(): void {
		if (this.flushTimer) {
			return;
		}
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined;
			this.pendingFlush = this.pendingFlush.then(() => this.writeNow()).catch(() => {});
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
		await this.pendingFlush;
		if (this.current) {
			await this.writeNow();
		}
	}

	/** Flush pending changes and stop the debounce timer (graceful shutdown). */
	async close(): Promise<void> {
		await this.flush();
	}

	private async writeNow(): Promise<void> {
		if (!this.current) {
			return;
		}
		await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
		const tempPath = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
		await writeFile(tempPath, `${JSON.stringify(this.current, null, 2)}\n`, { mode: 0o600 });
		await rename(tempPath, this.statePath);
	}
}
