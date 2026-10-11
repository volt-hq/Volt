import { execFile } from "node:child_process";
import { chmod, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import type { TestProject } from "vitest/node";

const TEST_AGENT_DIR_PREFIX = "volt-coding-agent-vitest-";

function requireTestAgentDir(project: TestProject): string {
	const configured = project.config.env.VOLT_CODING_AGENT_DIR;
	if (!configured) throw new Error("Coding-agent tests require an isolated VOLT_CODING_AGENT_DIR");
	if (project.config.env.VOLT_CODING_AGENT_SESSION_DIR !== "") {
		throw new Error("Coding-agent tests must neutralize VOLT_CODING_AGENT_SESSION_DIR");
	}

	const tempRoot = resolve(tmpdir());
	const agentDir = resolve(configured);
	const relativePath = relative(tempRoot, agentDir);
	if (
		!relativePath ||
		relativePath.startsWith("..") ||
		isAbsolute(relativePath) ||
		!basename(agentDir).startsWith(TEST_AGENT_DIR_PREFIX)
	) {
		throw new Error(`Refusing to manage unsafe Vitest agent directory: ${agentDir}`);
	}
	return agentDir;
}

function requireSessionStoreWorkerBundle(project: TestProject, agentDir: string): string {
	const configured = project.config.env.VOLT_TEST_SESSION_STORE_WORKER;
	// Named after the validated agent directory, so teardown removes only this run's bundle.
	const expected = `${agentDir}-session-store-worker.mjs`;
	if (!configured || resolve(configured) !== expected) {
		throw new Error(`Coding-agent tests require VOLT_TEST_SESSION_STORE_WORKER=${expected}`);
	}
	return expected;
}

/**
 * Bundles the session-store worker as the shipped CLI does (scripts/build-coding-agent-npm-cli.mjs).
 * Started from source, every store worker loads the unbundled graph, about half a second per start;
 * test/session-store-worker-redirect.mjs loads this bundle instead. Watch mode keeps the bundle it
 * started with; restart it after editing the store worker.
 */
async function bundleSessionStoreWorker(outfile: string): Promise<void> {
	await build({
		entryPoints: [fileURLToPath(new URL("../src/core/session-store/worker.ts", import.meta.url))],
		outfile,
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		// Workspace packages resolve to their sources, as they do for the source worker.
		conditions: ["volt-source"],
		logLevel: "warning",
		banner: {
			js: 'import { createRequire as __voltCreateRequire } from "node:module"; const require = __voltCreateRequire(import.meta.url);',
		},
	});
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
	const agentDir = requireTestAgentDir(project);
	const sessionStoreWorkerBundle = requireSessionStoreWorkerBundle(project, agentDir);
	await mkdir(agentDir, { mode: 0o700 });
	await chmod(agentDir, 0o700);

	const cleanup = async () => {
		await rm(sessionStoreWorkerBundle, { force: true });
		await rm(agentDir, {
			recursive: true,
			force: true,
			...(process.platform === "win32" ? { maxRetries: 10, retryDelay: 50 } : {}),
		});
	};

	try {
		await bundleSessionStoreWorker(sessionStoreWorkerBundle);
		// Compile the shared Jiti source cache before parallel workers contend for
		// CPU. CLI behavior tests keep their existing per-process deadlines.
		const warmupDir = resolve(agentDir, "source-cli-warmup");
		await mkdir(warmupDir, { mode: 0o700 });
		await promisify(execFile)(
			process.execPath,
			[fileURLToPath(new URL("./source-cli-runner.mjs", import.meta.url)), "--version"],
			{
				cwd: warmupDir,
				env: {
					...process.env,
					VOLT_CODING_AGENT_DIR: warmupDir,
					VOLT_CODING_AGENT_SESSION_DIR: "",
					VOLT_OFFLINE: "1",
				},
				timeout: 50_000,
				killSignal: "SIGKILL",
			},
		);
		await rm(warmupDir, { recursive: true, force: true });
	} catch (error) {
		await cleanup();
		throw error;
	}

	return cleanup;
}
