import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { type AnthropicOptions, streamAnthropic } from "../src/providers/anthropic.ts";
import type { Context, Model } from "../src/types.ts";

const oauthToken = "sk-ant-oat01-test-subscription-token";
const sessionId = "93d29ab7-a89b-4c20-b78d-e7273b678473";
const userAgent = "claude-cli/2.1.280 (external, cli)";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface CapturedRequest {
	url: string | undefined;
	headers: IncomingMessage["headers"];
	body: Record<string, unknown>;
}

const context: Context = {
	systemPrompt: "You are Volt. Keep the user's tools and instructions.",
	messages: [{ role: "user", content: "ping", timestamp: 0 }],
	tools: [
		{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) },
		{ name: "custom_lookup", description: "Custom lookup", parameters: Type.Object({}) },
	],
};

async function captureRequests(
	options: AnthropicOptions = {},
	modelOverrides: Partial<Model<"anthropic-messages">> = {},
	count = 1,
): Promise<CapturedRequest[]> {
	const requests: CapturedRequest[] = [];
	const server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		}
		requests.push({
			url: request.url,
			headers: request.headers,
			body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
		});
		const events = [
			{
				type: "message_start",
				message: { id: "msg_test", usage: { input_tokens: 1, output_tokens: 0 } },
			},
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Pong" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
			{ type: "message_stop" },
		];
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address() as AddressInfo;
	const model: Model<"anthropic-messages"> = {
		id: "claude-sonnet-5",
		name: "Claude Sonnet 5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: `http://127.0.0.1:${address.port}`,
		reasoning: true,
		input: ["text"],
		promptCache: { modes: ["explicit"], retention: { short: { ttlSeconds: 300 } } },
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 1024,
		compat: { forceAdaptiveThinking: true },
		...modelOverrides,
	};

	try {
		for (let i = 0; i < count; i++) {
			const result = await streamAnthropic(model, context, {
				apiKey: oauthToken,
				cacheRetention: "none",
				...options,
			}).result();
			expect(result.stopReason).toBe("stop");
			expect(result.content).toEqual([{ type: "text", text: "Pong" }]);
		}
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
	expect(requests).toHaveLength(count);
	return requests;
}

describe("Anthropic subscription request conventions", () => {
	it("matches the captured Claude Code client identity without enabling unsupported features", async () => {
		const [request] = await captureRequests({ sessionId });

		expect(request.url).toBe("/v1/messages?beta=true");
		expect(request.headers).toMatchObject({
			authorization: `Bearer ${oauthToken}`,
			"user-agent": userAgent,
			"x-app": "cli",
			"x-claude-code-session-id": sessionId,
			"anthropic-version": "2023-06-01",
			"anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
		});
		expect(request.headers["x-api-key"]).toBeUndefined();
		expect(request.headers["x-client-request-id"]).toMatch(uuidPattern);
		expect(request.headers["x-cc-atis"]).toBeUndefined();
		expect(request.headers["anthropic-dispatch-id"]).toBeUndefined();
		expect(request.body.system).toEqual([
			{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
			{ type: "text", text: context.systemPrompt },
		]);
		expect(request.body.tools).toMatchObject([{ name: "Read" }, { name: "custom_lookup" }]);
		expect(request.body.stream).toBe(true);
	});

	it("keeps the session identity with caching disabled and generates a new ID for each request", async () => {
		const requests = await captureRequests({ sessionId, cacheRetention: "none" }, {}, 2);
		for (const request of requests) {
			expect(request.headers["x-claude-code-session-id"]).toBe(sessionId);
			expect(request.headers["x-client-request-id"]).toMatch(uuidPattern);
			expect(request.headers["x-session-affinity"]).toBeUndefined();
		}
		expect(requests[0].headers["x-client-request-id"]).not.toBe(requests[1].headers["x-client-request-id"]);
	});

	it("does not fabricate a session identity when the caller has none", async () => {
		const [request] = await captureRequests();
		expect(request.headers["x-claude-code-session-id"]).toBeUndefined();
		expect(request.headers["x-client-request-id"]).toMatch(uuidPattern);
	});

	it("preserves explicit header overrides", async () => {
		const [request] = await captureRequests(
			{
				sessionId,
				headers: {
					"user-agent": "custom-client",
					"x-claude-code-session-id": "custom-session",
					"x-client-request-id": "custom-request",
					"anthropic-beta": "custom-beta",
				},
			},
			{ headers: { "user-agent": "model-client", "x-client-request-id": "model-request" } },
		);
		expect(request.headers).toMatchObject({
			"user-agent": "custom-client",
			"x-claude-code-session-id": "custom-session",
			"x-client-request-id": "custom-request",
			"anthropic-beta": "custom-beta",
		});
	});

	it("leaves API-key authentication and payloads unchanged", async () => {
		const [request] = await captureRequests({ apiKey: "test-api-key", sessionId });
		expect(request.url).toBe("/v1/messages");
		expect(request.headers["x-api-key"]).toBe("test-api-key");
		expect(request.headers.authorization).toBeUndefined();
		expect(request.headers["user-agent"]).not.toContain("claude-cli");
		expect(request.headers["x-app"]).toBeUndefined();
		expect(request.headers["anthropic-beta"]).toBeUndefined();
		expect(request.headers["x-claude-code-session-id"]).toBeUndefined();
		expect(request.headers["x-client-request-id"]).toBeUndefined();
		expect(request.body.system).toEqual([{ type: "text", text: context.systemPrompt }]);
		expect(request.body.tools).toMatchObject([{ name: "read" }, { name: "custom_lookup" }]);
	});

	it("keeps Copilot separate even when its credential resembles an Anthropic OAuth token", async () => {
		const [request] = await captureRequests(
			{ sessionId },
			{ provider: "github-copilot", headers: { "User-Agent": "GitHubCopilotChat/test" } },
		);
		expect(request.url).toBe("/v1/messages");
		expect(request.headers["user-agent"]).toBe("GitHubCopilotChat/test");
		expect(request.headers["anthropic-beta"]).toBeUndefined();
		expect(request.headers["x-app"]).toBeUndefined();
		expect(request.headers["x-claude-code-session-id"]).toBeUndefined();
		expect(request.headers["x-client-request-id"]).toBeUndefined();
	});

	it.each(["none", "short"] as const)("preserves API-key cache affinity for %s retention", async (cacheRetention) => {
		const [request] = await captureRequests(
			{ apiKey: "test-api-key", sessionId, cacheRetention },
			{ compat: { forceAdaptiveThinking: true, sendSessionAffinityHeaders: true } },
		);
		expect(request.headers["x-session-affinity"]).toBe(cacheRetention === "none" ? undefined : sessionId);
		expect(request.headers["x-claude-code-session-id"]).toBeUndefined();
	});
});
