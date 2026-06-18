import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { createLoopbackRpcTransportPair } from "../../core/rpc/index.ts";
import { runRpcMode } from "./rpc-mode.ts";
import { RpcTransportClient } from "./rpc-transport-client.ts";

export interface InProcessRpcClientOptions {
	/** Milliseconds to wait for a command response. Defaults to 30 seconds. */
	requestTimeoutMs?: number;
}

interface InProcessRpcClientConstructorOptions extends InProcessRpcClientOptions {
	runtimeHost: AgentSessionRuntime;
}

/**
 * RPC client backed by runRpcMode in the same Node.js process.
 *
 * stop() closes the client transport and waits for RPC mode shutdown, which also
 * disposes the supplied AgentSessionRuntime.
 */
export class InProcessRpcClient extends RpcTransportClient {
	private readonly modeClosed: Promise<void>;

	constructor(options: InProcessRpcClientConstructorOptions) {
		const pair = createLoopbackRpcTransportPair();
		super({ transport: pair.client, requestTimeoutMs: options.requestTimeoutMs });
		this.modeClosed = runRpcMode(options.runtimeHost, { transport: pair.server, exitProcess: false });
		void this.modeClosed.catch(() => {
			void pair.server.close();
		});
	}

	async stop(): Promise<void> {
		await super.stop();
		await this.modeClosed;
	}
}

export async function createInProcessRpcClient(
	runtimeHost: AgentSessionRuntime,
	options: InProcessRpcClientOptions = {},
): Promise<InProcessRpcClient> {
	const client = new InProcessRpcClient({ runtimeHost, ...options });
	await client.start();
	return client;
}
