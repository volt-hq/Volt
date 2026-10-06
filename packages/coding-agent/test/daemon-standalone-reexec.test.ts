/**
 * A standalone binary starts its daemon, its login service, and its
 * conversation workers by re-executing itself: by absolute path, with no Node
 * options and no entry script, whatever PATH or the package directory hold.
 * The standalone detection is simulated (`isStandaloneBinary`), and this
 * process's own executable stands in for the binary: a preload (through
 * NODE_OPTIONS) records how each child was started, then exits before
 * anything else runs.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type * as Config from "../src/config.ts";
import { handleDaemonCommand } from "../src/daemon/cli.ts";
import { resolveDaemonEnvironment } from "../src/daemon/login-environment.ts";
import { handleRemoteControlCommand } from "../src/daemon/remote-cli.ts";
import { getDaemonServiceInvocation, getServiceNodePath } from "../src/daemon/service-install.ts";
import { resolveDaemonCliInvocation, spawnDetachedDaemon, startInstalledDaemon } from "../src/daemon/spawn.ts";
import { ProcessWorkerLauncher } from "../src/daemon/worker-launcher.ts";

vi.mock("../src/config.ts", async (importOriginal) => ({
	...(await importOriginal<typeof Config>()),
	isStandaloneBinary: true,
}));

interface Launch {
	/** The name of the program's first argument: what a Node executable would run. */
	readonly program: string;
	readonly args: string[];
	readonly execArgv: string[];
	readonly hijacked?: string;
}

let root: string;
let recordPath: string;
let errors: MockInstance<typeof console.error>;
let exitCode: typeof process.exitCode;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "volt-standalone-reexec-"));
	recordPath = join(root, "launches.jsonl");
	const preload = join(root, "record-launch.cjs");
	writeFileSync(
		preload,
		`const { appendFileSync } = require("node:fs");
const { basename } = require("node:path");
appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ program: basename(process.argv[1] ?? ""), args: process.argv.slice(2), execArgv: process.execArgv }) + "\\n");
process.exit(0);
`,
	);
	vi.stubEnv("NODE_OPTIONS", `--require ${JSON.stringify(preload)}`);
	// Programs a PATH lookup would find first; nothing may run them.
	if (process.platform !== "win32") {
		const hijack = join(root, "path");
		mkdirSync(hijack);
		for (const name of ["volt", "node"]) {
			const program = join(hijack, name);
			writeFileSync(
				program,
				`#!/bin/sh\nprintf '%s\\n' '{"program":"","args":[],"execArgv":[],"hijacked":"${name}"}' >> ${JSON.stringify(recordPath)}\n`,
			);
			chmodSync(program, 0o755);
		}
		vi.stubEnv("PATH", `${hijack}${delimiter}${process.env.PATH ?? ""}`);
	}
	// An installation's entry points, which a standalone binary never runs.
	const packageDir = join(root, "package");
	for (const entry of [join("src", "cli.ts"), join("dist", "core", "npm", "cli.js"), join("dist", "cli.js")]) {
		mkdirSync(join(packageDir, entry, ".."), { recursive: true });
		writeFileSync(join(packageDir, entry), "");
	}
	vi.stubEnv("VOLT_PACKAGE_DIR", packageDir);
	exitCode = process.exitCode;
	errors = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	errors.mockRestore();
	process.exitCode = exitCode;
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

function launches(): Launch[] {
	return readFileSync(recordPath, "utf8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Launch);
}

describe("a standalone binary re-executes itself", () => {
	it("resolves its own executable, with no Node options or entry script", () => {
		expect(resolveDaemonCliInvocation()).toEqual({ command: process.execPath, nodeArgs: [], entryArgs: [] });
	});

	it("starts a conversation worker as `volt daemon worker`, its token on stdin only", async () => {
		const agentDir = join(root, "agent");
		const cwd = join(root, "workspace");
		mkdirSync(cwd, { recursive: true });
		const workerToken = "worker-token-never-in-argv";
		const worker = new ProcessWorkerLauncher().launch({
			workerId: "w-00000000-0000-4000-8000-000000000000",
			workerToken,
			socketPath: join(root, "voltd.sock"),
			agentDir,
			cwd,
		});

		await expect(worker.exited).resolves.toEqual({ reason: "stopped" });
		expect(launches()).toEqual([{ program: "daemon", args: ["worker"], execArgv: [] }]);
		expect(readFileSync(recordPath, "utf8")).not.toContain(workerToken);
	});

	it("starts the daemon as `volt daemon run --foreground`", async () => {
		const agentDir = join(root, "agent");
		await expect(spawnDetachedDaemon(agentDir)).resolves.toMatchObject({
			ok: false,
			error: "voltd exited before becoming healthy (exit code 0)",
		});
		expect(launches()).toEqual([{ program: "daemon", args: ["run", "--foreground"], execArgv: [] }]);
	});

	it("runs its own daemon commands, not another installation's", async () => {
		await expect(startInstalledDaemon(join(root, "agent"), join(root, "other install"), "terminal")).resolves.toBe(
			true,
		);
		expect(launches()).toEqual([{ program: "daemon", args: ["start"], execArgv: [] }]);
	});

	it.skipIf(process.platform === "win32")(
		"prints its login-shell environment as `volt daemon print-env`, never as Node's `-e`",
		async () => {
			const shell = join(root, "zsh");
			writeFileSync(
				shell,
				`#!/bin/sh\nprintf '%s' "$4" > ${JSON.stringify(join(root, "command"))}\nexec /bin/sh -c "$4"\n`,
			);
			chmodSync(shell, 0o755);
			// A service start hands the shell this environment, NODE_OPTIONS and the hijacking PATH included.
			const inherited = { ...process.env, HOME: root };

			await resolveDaemonEnvironment({ target: { ...inherited }, inherited, serviceStart: true, shell });

			expect(readFileSync(join(root, "command"), "utf8")).toBe('"$VOLT_ENV_NODE" daemon print-env');
			expect(launches()).toEqual([{ program: "daemon", args: ["print-env"], execArgv: [] }]);
		},
	);

	it("records itself in the login service definition", () => {
		expect(getDaemonServiceInvocation(join(root, "agent")).programArguments).toEqual([
			getServiceNodePath(process.execPath),
			"daemon",
			"run",
			"--foreground",
			"--service",
		]);
	});

	it("runs `volt daemon` and `volt remote` commands", async () => {
		const agentDir = join(root, "agent");
		await expect(handleDaemonCommand(["daemon", "status"], { agentDir })).resolves.toBe(true);
		expect(errors).toHaveBeenCalledWith("voltd is not running");
		vi.stubEnv("VOLT_CODING_AGENT_DIR", agentDir);
		await expect(handleRemoteControlCommand(["remote", "status"])).resolves.toBe(true);
		expect(errors).toHaveBeenCalledWith("voltd is not running. Start it with: volt daemon start");
		expect(errors.mock.calls.flat().join("\n")).not.toContain("standalone");
	});
});
