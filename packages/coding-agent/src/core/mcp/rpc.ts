import type { McpManager } from "./manager.ts";
import type { McpServerSummary } from "./types.ts";

export interface McpRpcCapabilities {
	protocolVersion: 1;
	features: string[];
	remoteSafeByDefault: string[];
}

export interface McpRpcServerListResponse {
	servers: McpServerSummary[];
}

export function getMcpRpcCapabilities(): McpRpcCapabilities {
	return {
		protocolVersion: 1,
		features: ["mcp_management.v1", "mcp_oauth.v1", "mcp_device_auth.v1"],
		remoteSafeByDefault: [
			"list_mcp_servers",
			"get_mcp_server",
			"list_mcp_recent_calls",
			"disconnect_mcp_server",
			"start_mcp_server_auth",
			"poll_mcp_server_auth",
			"cancel_mcp_server_auth",
		],
	};
}

export function listMcpRpcServers(manager: McpManager | undefined): McpRpcServerListResponse {
	return { servers: manager?.listServers() ?? [] };
}
