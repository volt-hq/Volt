/**
 * MCP authorization flows as host requests: a flow an MCP server started is a
 * pending `mcp_auth` request in the conversation's live state until the flow
 * ends (authenticated, failed, cancelled, or logged out). A client that
 * answers the request cancels the flow.
 */

import type { LiveState } from "../host/live-state.ts";
import type { McpManager } from "../mcp/manager.ts";
import type { McpAuthRequestDetails, McpManagerEvent } from "../mcp/types.ts";

export class McpAuthRequests {
	private readonly liveState: LiveState;
	/** The pending request of each server's flow. */
	private readonly flows = new Map<string, AbortController>();

	constructor(liveState: LiveState) {
		this.liveState = liveState;
	}

	/** Follow `manager`'s authorization events. */
	observe(event: McpManagerEvent, manager: McpManager): void {
		if (event.type === "mcp_auth_request") this.start(event.serverId, event.auth, manager);
		else if (event.type === "mcp_auth_update" && event.status !== "pending") this.end(event.serverId);
	}

	/** End every flow's request, as when the MCP manager is replaced. */
	endAll(): void {
		for (const serverId of [...this.flows.keys()]) this.end(serverId);
	}

	private start(serverId: string, auth: McpAuthRequestDetails, manager: McpManager): void {
		this.end(serverId);
		const controller = new AbortController();
		this.flows.set(serverId, controller);
		const forget = (): void => {
			if (this.flows.get(serverId) === controller) this.flows.delete(serverId);
		};
		void this.liveState
			.request(
				{
					kind: "mcp_auth",
					server: serverId,
					flow: auth.flow,
					...(auth.authorizationUrl === undefined ? {} : { authorizationUrl: auth.authorizationUrl }),
					...(auth.redirectUrl === undefined ? {} : { redirectUrl: auth.redirectUrl }),
					...(auth.verificationUri === undefined ? {} : { verificationUri: auth.verificationUri }),
					...(auth.verificationUriComplete === undefined
						? {}
						: { verificationUriComplete: auth.verificationUriComplete }),
					...(auth.userCode === undefined ? {} : { userCode: auth.userCode }),
					...(auth.expiresAt === undefined ? {} : { expiresAt: auth.expiresAt }),
					...(auth.intervalMs === undefined ? {} : { intervalMs: auth.intervalMs }),
					...(auth.message === undefined ? {} : { message: auth.message }),
				},
				// The flow is under way whoever is attached; a client that attaches later finds it.
				{ signal: controller.signal, unattended: true },
			)
			.then(
				(outcome) => {
					forget();
					if (outcome.status === "answered") manager.cancelServerAuth(serverId);
				},
				// A flow whose details do not fit a host request stays a session event only.
				forget,
			);
	}

	private end(serverId: string): void {
		const controller = this.flows.get(serverId);
		this.flows.delete(serverId);
		controller?.abort();
	}
}
