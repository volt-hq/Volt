/**
 * A TUI's spawn options as the daemon takes them (Phase 7 plan §1, "Spawn"):
 * checked, put in a canonical form, and keyed.
 *
 * A worker's compatibility key says which opens share a worker (D11
 * revised): an open the registry routes into a live worker of the same
 * workspace and generation must have the worker's key. It hashes what a
 * worker runs every conversation with, and nothing of one conversation (its
 * working directory, session, `--no-session`, session-level options) or one
 * client (its model scope). For a TUI-opened worker that is the opener's kind, its
 * environment as the worker runs with it (without the daemon-only
 * credentials), and its spawn-only options; for a phone-opened one, the
 * opener's kind, its tool policy, its project trust, and its profile.
 * Identical means identical: no variable of the environment is left out
 * (`PWD`, `SHLVL`, a terminal's session variables), so two terminals rarely
 * share a worker while one terminal's own opens do. The environment enters
 * only the hash: it is never logged, and never kept beyond the spawn.
 */

import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { WORKER_SPAWN_ONLY_OPTIONS } from "@hansjm10/volt-protocol/daemon-control";
import { isLocalPath } from "../utils/paths.ts";
import type {
	ConversationOpenTarget,
	WorkerAgentConfig,
	WorkerSpawnOnlyOption,
	WorkerSpawnOptions,
	WorkerSpawnSpec,
} from "./control-protocol.ts";

/**
 * The daemon's own relay credentials: a worker never uses them, and its tools
 * must not see them, whichever environment it runs with. They are the only
 * secrets the daemon reads from its environment; the rest of its state
 * (control token, relay and push credentials, pairing secrets) lives in files
 * no environment carries. A TUI-opened worker runs with its opener's
 * environment, not the daemon's, less these.
 */
export const DAEMON_ONLY_ENVIRONMENT = ["VOLT_IROH_RELAY_AUTH_TOKEN", "VOLT_PUSH_RELAY_AUTH_TOKEN"] as const;

/** `env` without the daemon-only credentials. */
export function withoutDaemonCredentials(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [name, value] of Object.entries(env)) {
		if (value !== undefined && !(DAEMON_ONLY_ENVIRONMENT as readonly string[]).includes(name)) result[name] = value;
	}
	return result;
}

/** `value` as JSON with every object's keys sorted: equal values encode equally. */
function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, item: unknown) => {
		if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(item).sort()) sorted[key] = (item as Record<string, unknown>)[key];
		return sorted;
	});
}

/**
 * `config` in canonical form: options left at their defaults (false, unset,
 * no flags) are absent. `trust: false` is a decision (`--no-approve`, or a
 * prompt answered no), not a default: unset means the saved decision.
 */
export function normalizeWorkerAgentConfig(config: WorkerAgentConfig): WorkerAgentConfig {
	const normalized: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(config)) {
		if (value === undefined || (value === false && name !== "trust")) continue;
		if (name === "flags" && typeof value === "object" && Object.keys(value).length === 0) continue;
		normalized[name] = value;
	}
	return normalized as WorkerAgentConfig;
}

/** Why `options` cannot open a conversation for `target`; undefined when they can. Never names an environment value. */
export function checkWorkerSpawnOptions(
	options: WorkerSpawnOptions,
	target: ConversationOpenTarget,
): string | undefined {
	if (!isAbsolute(options.cwd)) return "The working directory must be an absolute path";
	const { config } = options;
	for (const [name, paths] of [
		["extensions", config.extensions],
		["skills", config.skills],
		["promptTemplates", config.promptTemplates],
		["themes", config.themes],
	] as const) {
		for (const path of paths ?? []) {
			if (isLocalPath(path) && !isAbsolute(path)) return `Local ${name} paths must be absolute`;
		}
	}
	const directories =
		target.kind === "fork"
			? [target.sessionDir, target.source.sessionDir]
			: target.kind === "session"
				? [target.sessionDir, target.cwdOverride]
				: [target.sessionDir];
	if (directories.some((directory) => directory !== undefined && !isAbsolute(directory))) {
		return "Session and working directories must be absolute paths";
	}
	if (!options.persist && target.kind === "fork") return "A conversation without a session file cannot be a fork";
	return undefined;
}

/**
 * What a worker's compatibility key is computed from: a phone opener's tool
 * policy, project trust, and profile, or a TUI opener's spawn-only options
 * (with its environment). A spawn spec has them; an open knows them before
 * its conversation is prepared.
 */
export type WorkerCompatibility =
	| {
			readonly origin: "phone";
			readonly toolPolicy: { readonly tools: readonly string[]; readonly allowUnlistedExtensionTools: boolean };
			readonly projectTrusted: boolean;
			readonly profile?: string;
	  }
	| { readonly origin: "tui"; readonly config: WorkerAgentConfig };

/**
 * The compatibility key of a worker for `spec` (an open's compatibility, or
 * a spawn spec) in the environment `env` (a TUI's; a phone-opened worker
 * runs with the daemon's, which is the same for every such worker).
 */
export function workerCompatibilityKey(
	spec: WorkerCompatibility,
	env: Readonly<Record<string, string>> | undefined,
): string {
	const input =
		spec.origin === "phone"
			? {
					origin: "phone",
					toolPolicy: {
						tools: [...spec.toolPolicy.tools].sort(),
						allowUnlistedExtensionTools: spec.toolPolicy.allowUnlistedExtensionTools,
					},
					projectTrusted: spec.projectTrusted,
					profile: spec.profile ?? null,
				}
			: { origin: "tui", config: normalizeWorkerAgentConfig(spec.config), env: withoutDaemonCredentials(env ?? {}) };
	return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

/**
 * The spawn-only options of an open that differ from those of the live
 * worker `spec` describes, which keeps its own: all it set, for a
 * phone-opened worker.
 */
export function differingSpawnOnlyOptions(
	requested: WorkerAgentConfig,
	spec: WorkerSpawnSpec,
): WorkerSpawnOnlyOption[] {
	const asked: Record<string, unknown> = normalizeWorkerAgentConfig(requested);
	const live: Record<string, unknown> = spec.origin === "tui" ? normalizeWorkerAgentConfig(spec.config) : {};
	return WORKER_SPAWN_ONLY_OPTIONS.filter(
		(name) => canonicalJson(asked[name] ?? null) !== canonicalJson(live[name] ?? null),
	);
}
