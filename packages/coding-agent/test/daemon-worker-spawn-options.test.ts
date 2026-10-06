/**
 * A TUI's spawn options (Phase 7 slice 7): the CLI's arguments as the closed
 * `WorkerSpawnOptions`, checked by the daemon, put in canonical form, and
 * keyed by what a worker runs every conversation with.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkerSpawnOptions } from "../src/cli/agent-options.ts";
import { parseArgs } from "../src/cli/args.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";
import type { WorkerSpawnSpec } from "../src/daemon/control-protocol.ts";
import { resolveWorkerProjectTrust } from "../src/daemon/worker/conversation-factory.ts";
import { workerEnvironment } from "../src/daemon/worker-launcher.ts";
import {
	checkWorkerSpawnOptions,
	differingSpawnOnlyOptions,
	normalizeWorkerAgentConfig,
	workerCompatibilityKey,
} from "../src/daemon/worker-spawn-options.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A directory whose project holds resources that need trust (its `.volt/settings.json`). */
function projectNeedingTrust(root: string, name: string): string {
	const project = join(root, name);
	mkdirSync(join(project, ".volt"), { recursive: true });
	writeFileSync(join(project, ".volt", "settings.json"), "{}\n");
	return project;
}

const REF = { sessionDirectory: "/sessions", storeId: "store", sessionId: "s-1", sessionGeneration: "gen" };

function tuiSpec(
	overrides: Partial<Extract<WorkerSpawnSpec, { origin: "tui" }>> = {},
): Extract<WorkerSpawnSpec, { origin: "tui" }> {
	return {
		workerId: "w-1",
		origin: "tui",
		workspace: { name: "volt", path: "/work/volt", generation: 1 },
		session: REF,
		cwd: "/work/volt",
		root: "/work/volt",
		projectCwd: "/work/volt",
		config: { extensions: ["/ext/a.ts"], tools: ["read"] },
		sessionOptions: {},
		...overrides,
	};
}

describe("TUI spawn options", () => {
	it("maps the CLI's arguments onto the closed schema, with local paths made absolute", () => {
		const args = parseArgs([
			"-e",
			"./ext.ts",
			"-e",
			"npm:@scope/pkg",
			"--tools",
			"read,bash",
			"--model",
			"sonnet:high",
			"--plan",
			"--models",
			"sonnet*",
			"--no-session",
			"--lsp",
			"--my-flag",
			"value",
		]);
		const options = createWorkerSpawnOptions(args, {
			cwd: "/work/project",
			env: { PATH: "/bin", UNSET: undefined },
			trust: false,
		});
		expect(options).toEqual({
			env: { PATH: "/bin" },
			config: {
				trust: false,
				extensions: ["/work/project/ext.ts", "npm:@scope/pkg"],
				tools: ["read", "bash"],
				lsp: true,
				flags: { "my-flag": "value" },
			},
			cwd: "/work/project",
			persist: false,
			session: { model: "sonnet:high", plan: true },
			modelScopePatterns: ["sonnet*"],
		});
		expect(checkWorkerSpawnOptions(options, { kind: "new" })).toBeUndefined();
	});

	it("refuses relative paths and a fork without a session file", () => {
		const options = createWorkerSpawnOptions(parseArgs([]), { cwd: "/work/project", env: {} });
		expect(checkWorkerSpawnOptions({ ...options, cwd: "project" }, { kind: "new" })).toBeDefined();
		expect(
			checkWorkerSpawnOptions({ ...options, config: { extensions: ["./ext.ts"] } }, { kind: "new" }),
		).toBeDefined();
		expect(
			checkWorkerSpawnOptions({ ...options, config: { themes: ["npm:@scope/theme"] } }, { kind: "new" }),
		).toBeUndefined();
		expect(
			checkWorkerSpawnOptions(options, { kind: "session", sessionId: "s-1", sessionDir: "sessions" }),
		).toBeDefined();
		expect(
			checkWorkerSpawnOptions({ ...options, persist: false }, { kind: "fork", source: { sessionId: "s-1" } }),
		).toBeDefined();
	});

	it("keys a worker by its opener's kind, environment, and spawn-only options, never by one conversation's", () => {
		const key = workerCompatibilityKey(tuiSpec(), { PATH: "/bin", HOME: "/home/user" });
		// Another conversation, directory, or session-level option of the same TUI shares the key.
		expect(
			workerCompatibilityKey(
				tuiSpec({
					session: { sessionId: "s-2", inMemory: true },
					cwd: "/work/volt/packages",
					sessionOptions: { model: "sonnet", plan: true },
					modelScopePatterns: ["sonnet*"],
				}),
				{ HOME: "/home/user", PATH: "/bin" },
			),
		).toBe(key);
		// Options left at their defaults are the same options; the daemon's credentials are never inputs.
		expect(
			workerCompatibilityKey(
				tuiSpec({ config: { tools: ["read"], extensions: ["/ext/a.ts"], noExtensions: false, flags: {} } }),
				{
					PATH: "/bin",
					HOME: "/home/user",
					VOLT_IROH_RELAY_AUTH_TOKEN: "secret",
				},
			),
		).toBe(key);
		expect(workerCompatibilityKey(tuiSpec(), { PATH: "/usr/bin", HOME: "/home/user" })).not.toBe(key);
		expect(
			workerCompatibilityKey(tuiSpec({ config: { tools: ["read"], trust: true, extensions: ["/ext/a.ts"] } }), {
				PATH: "/bin",
				HOME: "/home/user",
			}),
		).not.toBe(key);
		const phone: WorkerSpawnSpec = {
			workerId: "w-2",
			origin: "phone",
			workspace: { name: "volt", path: "/work/volt", generation: 1 },
			session: REF,
			cwd: "/work/volt",
			root: "/work/volt",
			projectCwd: "/work/volt",
			toolPolicy: { tools: ["read"], allowUnlistedExtensionTools: false },
			projectTrusted: false,
		};
		expect(workerCompatibilityKey(phone, undefined)).not.toBe(key);
		expect(
			workerCompatibilityKey(
				{ ...phone, toolPolicy: { tools: ["read"], allowUnlistedExtensionTools: false } },
				undefined,
			),
		).toBe(workerCompatibilityKey(phone, undefined));
	});

	it("names the spawn-only options a live worker does not share", () => {
		expect(
			differingSpawnOnlyOptions({ tools: ["read"], extensions: ["/ext/a.ts"], noThemes: false }, tuiSpec()),
		).toEqual([]);
		expect(differingSpawnOnlyOptions({ tools: ["bash"], trust: true }, tuiSpec())).toEqual([
			"trust",
			"extensions",
			"tools",
		]);
		expect(normalizeWorkerAgentConfig({ lsp: false, flags: {}, profile: "work" })).toEqual({ profile: "work" });
	});

	it("runs a worker with its opener's environment less the daemon's credentials, in the daemon's agent directory", () => {
		expect(
			workerEnvironment("/agent", {
				PATH: "/bin",
				VOLT_CODING_AGENT_DIR: "/elsewhere",
				VOLT_IROH_RELAY_AUTH_TOKEN: "relay",
				VOLT_PUSH_RELAY_AUTH_TOKEN: "push",
			}),
		).toEqual({ PATH: "/bin", VOLT_CODING_AGENT_DIR: "/agent" });
	});

	it("applies a TUI's trust decision to the project it opened in only; elsewhere the saved decision", () => {
		const root = realpathSync.native(mkdtempSync(join(tmpdir(), "volt-worker-trust-")));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const agentDir = join(root, "agent");
		mkdirSync(agentDir);
		const opened = projectNeedingTrust(root, "opened");
		const elsewhere = projectNeedingTrust(root, "elsewhere");
		const saved = projectNeedingTrust(root, "saved");
		const plain = join(root, "plain");
		mkdirSync(plain);
		new ProjectTrustStore(agentDir).set(saved, true);
		const decided = { cwd: opened, trusted: true };
		expect(resolveWorkerProjectTrust(agentDir, opened, decided)).toBe(true);
		expect(resolveWorkerProjectTrust(agentDir, elsewhere, decided)).toBe(false);
		expect(resolveWorkerProjectTrust(agentDir, saved, decided)).toBe(true);
		// Nothing there needs trust; a later `.volt` does.
		expect(resolveWorkerProjectTrust(agentDir, plain, undefined)).toBe(true);
		projectNeedingTrust(root, "plain");
		expect(resolveWorkerProjectTrust(agentDir, plain, undefined)).toBe(false);
		// An explicit refusal holds even where nothing needs trust.
		expect(resolveWorkerProjectTrust(agentDir, plain, { cwd: plain, trusted: false })).toBe(false);
	});
});
