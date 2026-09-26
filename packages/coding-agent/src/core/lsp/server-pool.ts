import { canonicalizePath, resolvePath } from "../../utils/paths.ts";
import type { ResolvedLspConfig, ResolvedLspServerConfig } from "./config.ts";
import { type LspInstallRunner, LspServerCore, type LspServerLease } from "./server-core.ts";

export interface LspServerPoolAcquireOptions {
	/** Project root; canonicalized for the pool key. */
	projectCwd: string;
	config: ResolvedLspConfig;
	/** Cores are shared only between leases that use the same runner. */
	installRunner?: LspInstallRunner;
}

/** JSON with object keys sorted at every level, so equal settings fingerprint equally. */
function stableJson(value: unknown): string {
	return JSON.stringify(value, (_key, item: unknown) =>
		item !== null && typeof item === "object" && !Array.isArray(item)
			? Object.fromEntries(
					Object.entries(item).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
				)
			: item,
	);
}

/**
 * Settings that change which server processes run and how. Reporting settings
 * (settle times, severity, maxDiagnostics, automatic diagnostics) stay per view.
 */
function serverIdentity(config: ResolvedLspConfig): string {
	const server = ({ autoDiagnostics: _autoDiagnostics, ...identity }: ResolvedLspServerConfig) => identity;
	return stableJson({
		enabled: config.enabled,
		idleShutdownMs: config.idleShutdownMs,
		traceFile: config.traceFile ?? null,
		servers: config.servers.map(server),
		disabledServers: (config.disabledServers ?? []).map(server),
	});
}

/**
 * Shares language servers between the sessions of one delegation tree: a
 * session, its subagents, and its replacements. Each lease is keyed by the
 * canonical project root and server-identity settings; a core is disposed
 * when its last lease is released.
 */
export class LspServerPool {
	private entries = new Map<string, { core: LspServerCore; leases: number }>();
	private runnerIds = new WeakMap<LspInstallRunner, number>();
	private nextRunnerId = 1;

	acquire(options: LspServerPoolAcquireOptions): LspServerLease {
		const projectCwd = canonicalizePath(resolvePath(options.projectCwd));
		const key = stableJson([projectCwd, this.runnerId(options.installRunner), serverIdentity(options.config)]);
		let entry = this.entries.get(key);
		if (!entry || entry.core.isDisposed) {
			entry = {
				core: new LspServerCore({ projectCwd, config: options.config, installRunner: options.installRunner }),
				leases: 0,
			};
			this.entries.set(key, entry);
		}
		entry.leases++;
		const current = entry;
		let released = false;
		return {
			core: current.core,
			release: () => {
				if (released) return;
				released = true;
				current.leases--;
				if (current.leases > 0) return;
				if (this.entries.get(key) === current) this.entries.delete(key);
				current.core.dispose();
			},
		};
	}

	private runnerId(runner: LspInstallRunner | undefined): number {
		if (!runner) return 0;
		let id = this.runnerIds.get(runner);
		if (id === undefined) {
			id = this.nextRunnerId++;
			this.runnerIds.set(runner, id);
		}
		return id;
	}
}
