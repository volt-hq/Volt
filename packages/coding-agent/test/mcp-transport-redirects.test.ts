import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DefaultMcpClientFactory } from "../src/core/mcp/client-factory.ts";
import {
	createEmptyMcpMergedConfig,
	finalizeMcpConfig,
	mergeMcpConfigFile,
	sourceForMcpConfigPath,
} from "../src/core/mcp/config.ts";

interface CapturedRequest {
	path: string;
	headers: IncomingHttpHeaders;
	body: string;
}

type RedirectStage = "http-post" | "sse-get" | "sse-post";

async function listen(server: Server): Promise<string> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected loopback TCP listener");
	return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
	server.closeAllConnections();
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function fixture(stage: RedirectStage, status: number, crossOrigin: boolean) {
	const foreignRequests: CapturedRequest[] = [];
	const sourceRequests: CapturedRequest[] = [];
	const foreign = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk.toString();
		foreignRequests.push({ path: request.url ?? "", headers: request.headers, body });
		response.writeHead(400).end("Unexpected cross-origin request");
	});
	const foreignOrigin = await listen(foreign);
	let origin = "";
	let events: ServerResponse | undefined;
	const source = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk.toString();
		const path = request.url ?? "";
		sourceRequests.push({ path, headers: request.headers, body });
		const redirectPath = stage === "sse-get" ? "/sse" : stage === "sse-post" ? "/messages" : "/mcp";
		if (path === redirectPath) {
			response.writeHead(status, { location: `${crossOrigin ? foreignOrigin : origin}/final` }).end();
			return;
		}
		if (request.method === "GET" && stage !== "http-post") {
			events = response;
			response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			response.write("event: endpoint\ndata: /messages\n\n");
			return;
		}
		if (request.method !== "POST") {
			response.writeHead(405).end();
			return;
		}
		const message = JSON.parse(body) as { id?: number; params?: { protocolVersion?: string } };
		if (message.id === undefined) {
			response.writeHead(202).end();
			return;
		}
		const result = JSON.stringify({
			jsonrpc: "2.0",
			id: message.id,
			result: {
				protocolVersion: message.params?.protocolVersion,
				capabilities: {},
				serverInfo: { name: "loopback-control", version: "1.0.0" },
			},
		});
		if (stage === "http-post") {
			response.writeHead(200, { "content-type": "application/json" }).end(result);
		} else {
			response.writeHead(202).end();
			events?.write(`event: message\ndata: ${result}\n\n`);
		}
	});
	try {
		origin = await listen(source);
	} catch (error) {
		await close(foreign);
		throw error;
	}
	const merged = createEmptyMcpMergedConfig();
	mergeMcpConfigFile(
		merged,
		{
			servers: {
				remote: {
					transport: stage === "http-post" ? "streamable-http" : "sse",
					url: `${origin}/${stage === "http-post" ? "mcp" : "sse"}`,
					headers: { "X-Api-Key": "synthetic-custom-credential", Authorization: "Bearer synthetic-token" },
				},
			},
		},
		sourceForMcpConfigPath(join(process.cwd(), "mcp.json"), {
			scope: "user",
			label: "test",
			precedence: 1,
			shared: false,
		}),
	);
	return {
		server: finalizeMcpConfig(merged).servers.remote,
		foreignRequests,
		sourceRequests,
		close: async () => {
			await Promise.all([close(source), close(foreign)]);
		},
	};
}

// Exercise Volt's factory and the installed SDK with real loopback HTTP, not mocked fetch.
// Different ports are different origins; 307/308 preserve bodies if followed incorrectly.
describe.each<RedirectStage>(["http-post", "sse-get", "sse-post"])("MCP %s redirect boundary", (stage) => {
	for (const status of [307, 308]) {
		it(`rejects cross-origin ${status} without forwarding custom credentials or bodies`, async () => {
			const world = await fixture(stage, status, true);
			const factory = new DefaultMcpClientFactory({
				cwd: process.cwd(),
				clientName: "synthetic-private-body",
				env: {},
			});
			try {
				await expect(factory.connect(world.server, { timeout: 2000 })).rejects.toThrow(/redirect/i);
				expect(world.foreignRequests).toEqual([]);
				expect(world.sourceRequests[0].headers["x-api-key"]).toBe("synthetic-custom-credential");
				expect(world.sourceRequests[0].headers.authorization).toBe("Bearer synthetic-token");
				if (stage !== "sse-get") {
					expect(world.sourceRequests.some((request) => request.body.includes("synthetic-private-body"))).toBe(
						true,
					);
				}
			} finally {
				await world.close();
			}
		});

		it(`connects successfully through same-origin ${status} with credentials and body intact`, async () => {
			const world = await fixture(stage, status, false);
			const factory = new DefaultMcpClientFactory({
				cwd: process.cwd(),
				clientName: "synthetic-private-body",
				env: {},
			});
			try {
				const connection = await factory.connect(world.server, { timeout: 2000 });
				try {
					expect(connection.getServerVersion()).toEqual({ name: "loopback-control", version: "1.0.0" });
					const redirected = world.sourceRequests.find((request) => request.path === "/final");
					expect(redirected?.headers["x-api-key"]).toBe("synthetic-custom-credential");
					expect(redirected?.headers.authorization).toBe("Bearer synthetic-token");
					if (stage !== "sse-get") expect(redirected?.body).toContain("synthetic-private-body");
					expect(world.foreignRequests).toEqual([]);
				} finally {
					await connection.close();
				}
			} finally {
				await world.close();
			}
		});
	}
});
