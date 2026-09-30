import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { resolveDaemonCliInvocation, startInstalledDaemon } from "../src/daemon/spawn.ts";

const originalPackageDir = process.env.VOLT_PACKAGE_DIR;
let fixtureRoot: string | undefined;

afterEach(() => {
	if (originalPackageDir === undefined) {
		delete process.env.VOLT_PACKAGE_DIR;
	} else {
		process.env.VOLT_PACKAGE_DIR = originalPackageDir;
	}
	if (fixtureRoot) {
		rmSync(fixtureRoot, { recursive: true, force: true });
		fixtureRoot = undefined;
	}
});

function createPackageDir(): string {
	fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "volt daemon entrypoint-")));
	const packageDir = join(fixtureRoot, "packages", "coding-agent");
	mkdirSync(packageDir, { recursive: true });
	process.env.VOLT_PACKAGE_DIR = packageDir;
	return packageDir;
}

function createFile(path: string, content = ""): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
}

describe("daemon CLI entrypoint resolution", () => {
	it("uses the bundled npm CLI when the source entrypoint is absent", () => {
		const root = createPackageDir();
		const bundledEntry = join(root, "dist", "core", "npm", "cli.js");
		createFile(bundledEntry);
		createFile(join(root, "dist", "cli.js"));

		expect(resolveDaemonCliInvocation()).toEqual({ nodeArgs: ["--optimize-for-size"], entry: bundledEntry });
	});

	it("falls back to the modular CLI for older package layouts", () => {
		const root = createPackageDir();
		const modularEntry = join(root, "dist", "cli.js");
		createFile(modularEntry);

		expect(resolveDaemonCliInvocation()).toEqual({ nodeArgs: ["--optimize-for-size"], entry: modularEntry });
	});

	it("starts the daemon from the given installation instead of the running one", async () => {
		const fixture = join(createPackageDir(), "..", "..");
		const updatedDir = join(fixture, "updated install");
		const recordPath = join(fixture, "record.jsonl");
		const agentDir = join(fixture, "agent");
		// Exiting non-zero for install-service skips the wait for a service-started daemon.
		createFile(
			join(updatedDir, "dist", "core", "npm", "cli.js"),
			`require("node:fs").appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ args: process.argv.slice(2), agentDir: process.env[${JSON.stringify(ENV_AGENT_DIR)}] }) + "\\n");
process.exit(process.argv.includes("install-service") ? 3 : 0);
`,
		);

		expect(await startInstalledDaemon(agentDir, updatedDir, "terminal")).toBe(true);
		expect(await startInstalledDaemon(agentDir, updatedDir, "service")).toBe(false);
		const records = readFileSync(recordPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as unknown);
		expect(records).toEqual([
			{ args: ["daemon", "start"], agentDir },
			{ args: ["daemon", "install-service"], agentDir },
		]);
	});

	it("keeps source execution ahead of generated package entrypoints", () => {
		const root = createPackageDir();
		const sourceEntry = join(root, "src", "cli.ts");
		const sourceRunner = join(root, "..", "..", "scripts", "run-coding-agent-source.mjs");
		createFile(sourceEntry);
		createFile(sourceRunner);
		createFile(join(root, "dist", "core", "npm", "cli.js"));

		expect(resolveDaemonCliInvocation()).toEqual({
			nodeArgs: ["--optimize-for-size"],
			entry: sourceRunner,
		});
	});

	it("uses the bundled CLI when source files are present without the repository runner", () => {
		const root = createPackageDir();
		const bundledEntry = join(root, "dist", "core", "npm", "cli.js");
		createFile(join(root, "src", "cli.ts"));
		createFile(bundledEntry);

		expect(resolveDaemonCliInvocation()).toEqual({ nodeArgs: ["--optimize-for-size"], entry: bundledEntry });
	});

	it("launches with source-only dependency exports from outside the checkout", () => {
		const root = createPackageDir();
		const repo = join(root, "..", "..");
		const sourceRunner = join(repo, "scripts", "run-coding-agent-source.mjs");
		createFile(sourceRunner);
		copyFileSync(
			fileURLToPath(new URL("../../../scripts/run-coding-agent-source.mjs", import.meta.url)),
			sourceRunner,
		);
		createFile(join(repo, "package.json"), JSON.stringify({ type: "module" }));
		createFile(
			join(repo, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { paths: { "@fixture/agent-core": ["./packages/agent/src/index.ts"] } } }),
		);
		createFile(
			join(repo, "packages", "agent", "src", "index.ts"),
			'export const sourceOnlyExport: string = "source dependency loaded";',
		);
		// Package resolution alone sees stale compiled output with no sourceOnlyExport.
		createFile(
			join(repo, "node_modules", "@fixture", "agent-core", "package.json"),
			JSON.stringify({ type: "module", exports: "./index.js" }),
		);
		createFile(join(repo, "node_modules", "@fixture", "agent-core", "index.js"), "export {};");
		symlinkSync(
			realpathSync(fileURLToPath(new URL("../../../node_modules/jiti", import.meta.url))),
			join(repo, "node_modules", "jiti"),
			process.platform === "win32" ? "junction" : "dir",
		);
		createFile(
			join(root, "src", "cli.ts"),
			'import { sourceOnlyExport } from "@fixture/agent-core";\nconsole.log(JSON.stringify({ loaded: sourceOnlyExport, args: process.argv.slice(2), entry: process.argv[1] }));',
		);
		const agentDir = join(repo, "agent state");
		mkdirSync(agentDir);
		const { nodeArgs, entry } = resolveDaemonCliInvocation();
		const result = spawnSync(process.execPath, [...nodeArgs, entry, "daemon", "run", "--foreground"], {
			cwd: agentDir,
			encoding: "utf8",
			timeout: 15_000,
		});

		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			loaded: "source dependency loaded",
			args: ["daemon", "run", "--foreground"],
			entry: join(root, "src", "cli.ts"),
		});
	});
});
