import { describe, expect, it, vi } from "vitest";
import { LiveState } from "../src/core/host/live-state.ts";
import type { McpManager } from "../src/core/mcp/manager.ts";
import { McpAuthRequests } from "../src/core/session/mcp-auth-requests.ts";
import { createLiveRecorder } from "./utilities/live-recorder.ts";

function createManager() {
	const cancelServerAuth = vi.fn();
	return { manager: { cancelServerAuth } as unknown as McpManager, cancelServerAuth };
}

describe("MCP authorization flows as host requests", () => {
	it("waits in the live state until the flow ends, whoever is attached", async () => {
		const live = new LiveState();
		const requests = new McpAuthRequests(live);
		const { manager, cancelServerAuth } = createManager();
		requests.observe(
			{
				type: "mcp_auth_request",
				serverId: "github",
				auth: { flow: "device", verificationUri: "https://example.test/device", userCode: "ABCD-1234" },
			},
			manager,
		);
		expect(live.pendingRequests()).toEqual([
			{
				requestId: expect.any(String),
				request: {
					kind: "mcp_auth",
					server: "github",
					flow: "device",
					verificationUri: "https://example.test/device",
					userCode: "ABCD-1234",
				},
			},
		]);
		// A client that attaches later finds it; one that does not take MCP authorization does not.
		const phone = createLiveRecorder(["mcp_auth"]);
		const observer = createLiveRecorder();
		live.attach("phone", phone);
		live.attach("observer", observer);
		expect(phone.pending()).toHaveLength(1);
		expect(observer.items()).toEqual([]);

		requests.observe(
			{ type: "mcp_auth_update", serverId: "github", status: "pending", authState: "pending" },
			manager,
		);
		expect(live.pendingRequests()).toHaveLength(1);
		requests.observe(
			{ type: "mcp_auth_update", serverId: "github", status: "authenticated", authState: "authenticated" },
			manager,
		);
		await vi.waitFor(() => expect(live.pendingRequests()).toEqual([]));
		expect(phone.pending()).toEqual([]);
		expect(cancelServerAuth).not.toHaveBeenCalled();
	});

	it("cancels the flow when a client dismisses it, and replaces a server's earlier flow", async () => {
		const live = new LiveState();
		const requests = new McpAuthRequests(live);
		const { manager, cancelServerAuth } = createManager();
		live.attach("phone", createLiveRecorder(["mcp_auth"]));
		requests.observe(
			{
				type: "mcp_auth_request",
				serverId: "github",
				auth: { flow: "browser", authorizationUrl: "https://a.test" },
			},
			manager,
		);
		requests.observe(
			{
				type: "mcp_auth_request",
				serverId: "github",
				auth: { flow: "browser", authorizationUrl: "https://b.test" },
			},
			manager,
		);
		const [pending] = live.pendingRequests();
		expect(live.pendingRequests()).toHaveLength(1);
		expect(pending?.request).toMatchObject({ authorizationUrl: "https://b.test" });

		expect(live.answer(pending?.requestId ?? "", { value: "code" }, "phone")).toBe("invalid");
		expect(live.answer(pending?.requestId ?? "", { cancelled: true }, "phone")).toBe("accepted");
		await vi.waitFor(() => expect(cancelServerAuth).toHaveBeenCalledExactlyOnceWith("github"));

		requests.observe({ type: "mcp_auth_request", serverId: "linear", auth: { flow: "device" } }, manager);
		requests.endAll();
		await vi.waitFor(() => expect(live.pendingRequests()).toEqual([]));
		expect(cancelServerAuth).toHaveBeenCalledOnce();
	});
});
