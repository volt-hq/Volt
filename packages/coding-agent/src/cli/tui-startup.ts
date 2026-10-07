/**
 * Where the interactive TUI starts (Phase 7 plan §9 row 8): the conversation
 * it opens in a daemon worker, resolved read-only from its arguments, and the
 * project trust it decides for that conversation's project before it opens
 * (Phase 6 D4). The TUI never opens a stored log for writing: a worker does.
 * A JSONL file it starts from (`--session`/`--fork` with a file path) is
 * imported into the store here, as a new session the worker then opens.
 */

import { existsSync } from "node:fs";
import chalk from "chalk";
import { type DecidedProjectTrust, projectTrustPath, resolveProjectTrusted } from "../core/project-trust.ts";
import { formatMissingSessionCwdPrompt } from "../core/session-cwd.ts";
import { findLocalSessionByExactId, type ResolvedSession, resolveSessionArgument } from "../core/session-lookup.ts";
import { findSessionInfoById, SessionManager, type SessionReference } from "../core/session-manager.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { initTheme, stopThemeWatcher } from "../core/theme/runtime.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "../core/trust-manager.ts";
import type { ConversationOpenTarget } from "../daemon/control-protocol.ts";
import { isPathUnderWorktreesRoot } from "../daemon/worktree-manager.ts";
import type { Args } from "./args.ts";
import { createProjectTrustContext } from "./project-trust.ts";
import { selectSession } from "./session-picker.ts";
import { showStartupSelector } from "./startup-ui.ts";

/** The conversation the TUI opens first. */
export interface TuiStartupTarget {
	readonly target: ConversationOpenTarget;
	/** The working directory it runs in, as far as the TUI knows: where its project trust and display settings are read. */
	readonly cwd: string;
}

/** What the TUI does instead of starting: exit, with a message for the user when there is one. */
export interface TuiStartupExit {
	readonly exit: number;
	readonly message?: string;
}

export interface TuiStartupContext {
	/** The TUI's working directory. */
	readonly cwd: string;
	/** `--session-dir`, the environment's, or the settings'. */
	readonly sessionDir: string | undefined;
	readonly agentDir: string;
	/** The startup settings, for the pickers' theme. */
	readonly settingsManager: SettingsManager;
	/** Ask a yes/no question on the terminal; resolves the answer. */
	readonly confirm: (message: string) => Promise<boolean>;
}

/** A stored session opened from another project: the user confirms a fork into this one. */
async function forkFromAnotherProject(
	resolved: Extract<ResolvedSession, { type: "global" }>,
	context: TuiStartupContext,
): Promise<TuiStartupTarget | TuiStartupExit> {
	console.log(chalk.yellow(`Session found in different project: ${resolved.cwd}`));
	if (!(await context.confirm("Fork this session into current directory?"))) {
		console.log(chalk.dim("Aborted."));
		return { exit: 0 };
	}
	return { target: forkTarget(resolved.ref, context.sessionDir), cwd: context.cwd };
}

function forkTarget(
	source: SessionReference,
	sessionDir: string | undefined,
	sessionId?: string,
): ConversationOpenTarget {
	return {
		kind: "fork",
		source: { sessionId: source.sessionId, sessionDir: source.sessionDirectory },
		...(sessionId === undefined ? {} : { sessionId }),
		...(sessionDir === undefined ? {} : { sessionDir }),
	};
}

/** Import a JSONL session file as a new stored session, closed again for the worker that opens it. */
async function importSessionFile(
	path: string,
	cwd: string | undefined,
	sessionDir: string | undefined,
	sessionId?: string,
): Promise<{ ref: SessionReference; cwd: string }> {
	const manager = await SessionManager.importFromJsonl(path, cwd, sessionDir, { id: sessionId });
	try {
		const ref = manager.getSessionRef();
		if (ref === undefined) throw new Error(`The imported session ${path} was not stored`);
		return { ref, cwd: manager.getCwd() };
	} finally {
		await manager.closePersistence();
	}
}

/**
 * A stored session the TUI resumes: in its own working directory, or, when
 * that is gone (and not a managed worktree checkout, which the daemon
 * restores), in the TUI's when the user continues there.
 */
async function storedTarget(
	ref: SessionReference,
	context: TuiStartupContext,
): Promise<TuiStartupTarget | TuiStartupExit> {
	const storedCwd = (await findSessionInfoById(ref.sessionDirectory, ref.sessionId))?.cwd ?? "";
	const target: ConversationOpenTarget = {
		kind: "session",
		sessionId: ref.sessionId,
		sessionDir: ref.sessionDirectory,
	};
	if (!storedCwd || existsSync(storedCwd) || isPathUnderWorktreesRoot(context.agentDir, storedCwd)) {
		return { target, cwd: storedCwd || context.cwd };
	}
	const selected = await showStartupSelector(
		context.settingsManager,
		formatMissingSessionCwdPrompt({ sessionCwd: storedCwd, fallbackCwd: context.cwd }),
		[
			{ label: "Continue", value: context.cwd },
			{ label: "Cancel", value: undefined },
		],
	);
	if (selected === undefined) return { exit: 0 };
	return { target: { ...target, cwdOverride: selected }, cwd: selected };
}

/**
 * The conversation the TUI started with `parsed` opens first: `--no-session`
 * a new one in memory, `--fork` a copy, `--session` a stored one (a JSONL
 * file imported first; one from another project forked into this one once
 * the user confirms), `--resume` the one the picker selects, `--continue`
 * the latest one, `--session-id` that one, else a new one.
 */
export async function resolveTuiStartupTarget(
	parsed: Args,
	context: TuiStartupContext,
): Promise<TuiStartupTarget | TuiStartupExit> {
	const { cwd, sessionDir } = context;
	const newTarget = (sessionId?: string): TuiStartupTarget => ({
		target: {
			kind: "new",
			...(sessionDir === undefined ? {} : { sessionDir }),
			...(sessionId === undefined ? {} : { sessionId }),
		},
		cwd,
	});
	if (parsed.noSession) return { target: { kind: "new" }, cwd };

	if (parsed.fork) {
		if (parsed.sessionId && (await findLocalSessionByExactId(parsed.sessionId, cwd, sessionDir))) {
			return { exit: 1, message: `Session already exists with id '${parsed.sessionId}'` };
		}
		const resolved = await resolveSessionArgument(parsed.fork, cwd, sessionDir);
		switch (resolved.type) {
			case "path": {
				const imported = await importSessionFile(resolved.path, cwd, sessionDir, parsed.sessionId);
				return storedTarget(imported.ref, context);
			}
			case "local":
			case "global":
				return { target: forkTarget(resolved.ref, sessionDir, parsed.sessionId), cwd };
			case "not_found":
				return { exit: 1, message: `No session found matching '${resolved.arg}'` };
		}
	}

	if (parsed.session) {
		const resolved = await resolveSessionArgument(parsed.session, cwd, sessionDir);
		switch (resolved.type) {
			case "path": {
				const imported = await importSessionFile(resolved.path, undefined, sessionDir);
				return storedTarget(imported.ref, context);
			}
			case "local":
				return storedTarget(resolved.ref, context);
			case "global":
				return forkFromAnotherProject(resolved, context);
			case "not_found":
				return { exit: 1, message: `No session found matching '${resolved.arg}'` };
		}
	}

	if (parsed.resume) {
		initTheme(context.settingsManager.getTheme(), true);
		let selected: SessionReference | null;
		try {
			selected = await selectSession(
				(onProgress, query) =>
					query ? SessionManager.search(cwd, query, sessionDir) : SessionManager.list(cwd, sessionDir, onProgress),
				(onProgress, query) =>
					query ? SessionManager.searchAll(query, sessionDir) : SessionManager.listAll(sessionDir, onProgress),
			);
		} finally {
			stopThemeWatcher();
		}
		if (!selected) {
			console.log(chalk.dim("No session selected"));
			return { exit: 0 };
		}
		return storedTarget(selected, context);
	}

	if (parsed.continue) {
		const latest = await SessionManager.findContinuation(cwd, sessionDir);
		return latest ? storedTarget(latest, context) : newTarget();
	}

	if (parsed.sessionId) {
		const existing = await findLocalSessionByExactId(parsed.sessionId, cwd, sessionDir);
		if (existing) return storedTarget(existing.ref, context);
		return newTarget(parsed.sessionId);
	}

	return newTarget();
}

/**
 * The project trust the TUI decides for the project of `cwd` before it opens
 * a conversation there (Phase 6 D4): `--approve`/`--no-approve`, else, when
 * the project holds what needs trust, its saved decision, the default the
 * settings name, or the user's answer to the trust prompt. Undefined when
 * there is nothing to decide: the worker trusts a project without such
 * resources until it gains them, and a managed worktree whose parent
 * checkout is unknown runs untrusted.
 */
export async function decideTuiProjectTrust(
	parsed: Pick<Args, "projectTrustOverride">,
	cwd: string,
	agentDir: string,
	settingsManager: SettingsManager,
): Promise<DecidedProjectTrust | undefined> {
	if (parsed.projectTrustOverride !== undefined) return { cwd, trusted: parsed.projectTrustOverride };
	const trustPath = projectTrustPath(agentDir, cwd);
	if (trustPath === undefined || !hasTrustRequiringProjectResources(cwd)) return undefined;
	const trusted = await resolveProjectTrusted({
		cwd: trustPath,
		trustStore: new ProjectTrustStore(agentDir),
		defaultProjectTrust: settingsManager.getDefaultProjectTrust(),
		projectTrustContext: createProjectTrustContext({
			cwd: trustPath,
			mode: "interactive",
			settingsManager,
			hasUI: true,
		}),
	});
	return { cwd, trusted };
}
