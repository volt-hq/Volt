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
	return hostStateToVoltdState(hostState, { detachedRuntimeTtlMs, allowTools });
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

	constructor(options: VoltdStateStoreOptions) {
		this.statePath = options.statePath;
		this.agentDir = options.agentDir;
		this.debounceMs = options.debounceMs ?? DEFAULT_STATE_DEBOUNCE_MS;
	}

	async load(): Promise<LoadVoltdStateResult> {
		if (this.current) {
			return { state: this.current, migratedFromLegacyState: this.migrated };
		}
		const migratedState = migrateLegacyRemoteState(this.agentDir, this.statePath);
		if (migratedState) {
			this.current = migratedState;
			this.migrated = true;
			await this.writeNow();
			const legacyPath = getLegacyRemoteStatePath(this.agentDir);
			await rename(legacyPath, `${legacyPath}.migrated`);
			return { state: this.current, migratedFromLegacyState: true };
		}
		if (existsSync(this.statePath)) {
			this.current = parseVoltdState(JSON.parse(readFileSync(this.statePath, "utf8")));
		} else {
			this.current = createEmptyVoltdState();
			await this.writeNow();
		}
		return { state: this.current, migratedFromLegacyState: false };
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

	/** Flush pending changes and stop the debounce timer (graceful shutdown). */
	async close(): Promise<void> {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
		await this.pendingFlush;
		if (this.current) {
			await this.writeNow();
		}
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
