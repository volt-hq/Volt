/**
 * The memory benchmark's `worker-idle` driver. A daemon runs in this process on
 * the run's isolated agent directory, with conversation workers as processes
 * of their own (`ProcessWorkerLauncher`, `volt daemon worker` from source). It
 * opens a stored, empty conversation in a worker, as a phone's open does, and
 * reports the spawn's latency (from the open to the worker's readiness) at the
 * `idle` checkpoint. The worker process inherits the benchmark's preload and
 * says hello to its snapshot server, so the snapshot is the worker's. The
 * worker's conversation uses a generated faux provider extension: no real
 * provider is involved.
 */

import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import {
	ExtensionPermissionStore,
	extensionFingerprint,
} from "../packages/coding-agent/src/core/extensions/permissions.ts";
import {
	parseIrohRemoteAllowTools,
	usesDefaultIrohRemoteAllowTools,
} from "../packages/coding-agent/src/core/remote/iroh/protocol.ts";
import { getDefaultSessionDir, SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { createDaemonClient } from "../packages/coding-agent/src/daemon/control-client.ts";
import { runVoltDaemon } from "../packages/coding-agent/src/daemon/main.ts";
import { probeDaemon } from "../packages/coding-agent/src/daemon/spawn.ts";
import { ProcessWorkerLauncher } from "../packages/coding-agent/src/daemon/worker-launcher.ts";

const EVENT_PREFIX = "VOLT_MEMORY_BENCHMARK_EVENT ";
const WORKSPACE_NAME = "benchmark";
const PROVIDER = "benchmark-faux";
const MODEL = "faux-1";
const EXTENSION_ID = "benchmark-provider";

function parseArgs(argv) {
	if (argv.length !== 2 || argv[0] !== "--root") throw new Error("the worker-idle driver requires --root <dir>");
	return { root: resolve(argv[1]) };
}

class CheckpointChannel {
	constructor() {
		this.sequence = 0;
		this.pending = new Map();
		this.readline = createInterface({ input: process.stdin, crlfDelay: Infinity });
		this.readline.on("line", (line) => {
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				return;
			}
			if (message?.type !== "continue" || typeof message.id !== "string") return;
			const resolvePending = this.pending.get(message.id);
			if (!resolvePending) return;
			this.pending.delete(message.id);
			resolvePending();
		});
	}

	async checkpoint(name, details = {}) {
		const id = `checkpoint-${++this.sequence}`;
		const continued = new Promise((resolveContinued) => this.pending.set(id, resolveContinued));
		process.stdout.write(`${EVENT_PREFIX}${JSON.stringify({ type: "checkpoint", id, name, details })}\n`);
		await continued;
	}

	done() {
		process.stdout.write(`${EVENT_PREFIX}${JSON.stringify({ type: "done" })}\n`);
		this.readline.close();
	}
}

/** A single-file extension that registers a faux provider, with its `providers` permission acknowledged. */
async function installProviderExtension(root, agentDir) {
	const directory = join(root, "fixtures");
	await mkdir(directory, { recursive: true });
	const extensionPath = join(await realpath(directory), "benchmark-provider.ts");
	await writeFile(
		extensionPath,
		`import { createFauxProvider } from "@hansjm10/volt-ai";

export const manifest = { id: ${JSON.stringify(EXTENSION_ID)}, displayName: "Benchmark provider", permissions: ["providers"] };

export default function (volt) {
	const faux = createFauxProvider({ provider: ${JSON.stringify(PROVIDER)}, models: [{ id: ${JSON.stringify(MODEL)}, contextWindow: 128000, maxTokens: 4096 }] });
	volt.registerProvider(${JSON.stringify(PROVIDER)}, {
		baseUrl: faux.models[0].baseUrl,
		apiKey: "benchmark-only-faux-key",
		api: faux.api,
		streamSimple: faux.streamSimple,
		models: faux.models.map((model) => ({
			id: model.id,
			name: model.name,
			api: model.api,
			reasoning: model.reasoning,
			input: model.input,
			cost: model.cost,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
		})),
	});
}
`,
		"utf8",
	);
	await writeFile(
		join(agentDir, "settings.json"),
		`${JSON.stringify({ defaultProvider: PROVIDER, defaultModel: MODEL, extensionPaths: [extensionPath] })}\n`,
	);
	new ExtensionPermissionStore(agentDir).acknowledge({
		id: EXTENSION_ID,
		fingerprint: extensionFingerprint({ id: EXTENSION_ID, path: extensionPath }),
		permissions: ["providers"],
		version: "local",
	});
}

async function main() {
	const { root } = parseArgs(process.argv.slice(2));
	const agentDir = process.env.VOLT_CODING_AGENT_DIR;
	assert(agentDir, "the benchmark sets VOLT_CODING_AGENT_DIR");
	const workspace = await realpath(join(root, "workspace"));
	await installProviderExtension(root, agentDir);
	const channel = new CheckpointChannel();

	let services;
	const daemon = runVoltDaemon({ agentDir, foreground: false, workerLauncher: new ProcessWorkerLauncher() }, [
		(runtime) => {
			services = runtime;
			return {};
		},
	]);
	let probe = await probeDaemon(agentDir);
	for (let attempt = 0; !probe.healthy && attempt < 600; attempt++) {
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
		probe = await probeDaemon(agentDir);
	}
	assert(probe.healthy && services, "the benchmark daemon did not start");
	const control = createDaemonClient({
		socketPath: probe.socketPath,
		client: "cli",
		version: "benchmark",
		...(probe.authToken === undefined ? {} : { authToken: probe.authToken }),
		reconnect: false,
	});
	try {
		await control.connect();
		const registered = await control.request({ type: "workspace_register", name: WORKSPACE_NAME, path: workspace });
		assert.equal(registered.type, "ok");
		const generation = services.state
			.getHostState()
			.workspaceGenerations?.find((record) => record.workspaceName === WORKSPACE_NAME)?.generation;
		assert(generation !== undefined, "the benchmark workspace has no generation");
		const manager = await SessionManager.create(workspace, getDefaultSessionDir(agentDir));
		const session = manager.getSessionRef();
		await manager.closePersistence();
		assert(session, "the benchmark session has no reference");

		// As a phone's open does, with the phones' default tool policy.
		const spawn = {
			origin: "phone",
			workspace: { name: WORKSPACE_NAME, path: workspace, generation },
			session,
			cwd: workspace,
			root: workspace,
			projectCwd: workspace,
			toolPolicy: {
				tools: parseIrohRemoteAllowTools(undefined),
				allowUnlistedExtensionTools: usesDefaultIrohRemoteAllowTools(undefined),
			},
			projectTrusted: false,
		};
		const startedAt = performance.now();
		await services.workers.open(
			{ workspaceName: WORKSPACE_NAME, workspaceGeneration: generation, sessionId: session.sessionId },
			{ compatibility: spawn, prepare: async () => spawn, attach: () => undefined },
		);
		const spawnLatencyMs = performance.now() - startedAt;
		const [worker] = services.workers.list();
		assert(worker && worker.state === "live", "the worker is not live");
		await channel.checkpoint("idle", {
			spawnLatencyMs,
			workerPid: worker.pid,
			sessionIds: worker.sessionIds.length,
		});
		const stopped = await control.request({ type: "shutdown" });
		assert.equal(stopped.type, "ok");
		assert.equal(await daemon, 0);
	} finally {
		await control.close();
	}
	channel.done();
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
	// The daemon would keep the process alive; its worker exits once it loses the daemon.
	process.exit(1);
});
