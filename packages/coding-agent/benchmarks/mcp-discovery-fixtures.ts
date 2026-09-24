import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export interface DiscoveryQuery {
	id: string;
	query: string;
	server?: string;
	/** All relevant tools, identified as server/tool. Empty means the capability is absent. */
	relevant: string[];
}

export interface DiscoveryCatalog {
	servers: Array<{ id: string; tools: Tool[] }>;
	queries: DiscoveryQuery[];
}

const labeledTools: Array<{ server: string; name: string; title: string; description: string; parameter?: string }> = [
	{
		server: "xcode",
		name: "run_simulator_tests",
		title: "Simulator tests",
		description: "Run unit tests on an iOS simulator.",
		parameter: "simulatorId",
	},
	{
		server: "xcode",
		name: "getSimulatorLogs",
		title: "Simulator console",
		description: "Read console output from an iOS simulator.",
		parameter: "simulatorId",
	},
	{
		server: "xcode",
		name: "build_target",
		title: "Build target",
		description: "Compile a named target from an Xcode workspace.",
		parameter: "workspacePath",
	},
	{
		server: "xcode",
		name: "list_simulators",
		title: "Available simulators",
		description: "List available iOS devices and simulator identifiers.",
	},
	{
		server: "xcode",
		name: "read_test_results",
		title: "Test results",
		description: "Read the outcome of an existing test run.",
	},
	{
		server: "xcode",
		name: "archive_workspace",
		title: "Workspace archive",
		description: "Package compiled application artifacts for distribution.",
	},
	{
		server: "github",
		name: "list_pull_requests",
		title: "Pull requests",
		description: "List open or closed pull requests in a repository.",
		parameter: "repository",
	},
	{
		server: "github",
		name: "get_pull_request_diff",
		title: "Pull request patch",
		description: "Read the changed lines and file diffs for a pull request.",
	},
	{
		server: "github",
		name: "get_workflow_run_logs",
		title: "Workflow logs",
		description: "Read logs for a GitHub Actions workflow run.",
	},
	{
		server: "github",
		name: "search_issues",
		title: "Issue search",
		description: "Search issue titles and bodies in a repository.",
	},
	{
		server: "github",
		name: "list_labels",
		title: "Repository labels",
		description: "List issue labels defined in a repository.",
	},
	{
		server: "github",
		name: "list_pull_request_labels",
		title: "Pull request labels",
		description: "Read labels already attached to one pull request.",
	},
	{
		server: "github",
		name: "get_repository",
		title: "Repository details",
		description: "Read the repository name, owner and visibility.",
	},
	{
		server: "grafana",
		name: "query_metrics",
		title: "Metrics query",
		description: "Query a datasource for Prometheus time series metrics.",
		parameter: "promql",
	},
	{
		server: "grafana",
		name: "search_dashboards",
		title: "Dashboard search",
		description: "Search dashboards by title or tag.",
	},
	{
		server: "grafana",
		name: "find_trace",
		title: "Trace Explorer",
		description: "Retrieve a distributed request trace by its identifier.",
	},
	{
		server: "grafana",
		name: "list_labels",
		title: "Metric labels",
		description: "List available label names in a Prometheus datasource.",
	},
	{
		server: "grafana",
		name: "read_dashboard",
		title: "Dashboard details",
		description: "Read panels and layout of one dashboard.",
	},
	{
		server: "grafana",
		name: "search_alert_rules",
		title: "Alert rules",
		description: "Search alert definitions and notification routing.",
	},
	{
		server: "grafana",
		name: "search_japanese_dashboards",
		title: "ダッシュボード検索",
		description: "ダッシュボード を検索します。",
	},
];

/** Hand-labeled synthetic tasks, not a claim about real model accuracy. */
export const DISCOVERY_QUERIES: readonly DiscoveryQuery[] = [
	{ id: "natural-language", query: "run simulator tests", relevant: ["xcode/run_simulator_tests"] },
	{ id: "exact-identifier", query: "run_simulator_tests", relevant: ["xcode/run_simulator_tests"] },
	{ id: "camel-case", query: "get simulator logs", relevant: ["xcode/getSimulatorLogs"] },
	{ id: "identifier-separators", query: "simulator_logs", relevant: ["xcode/getSimulatorLogs"] },
	{ id: "multiple-fields", query: "build target workspace", relevant: ["xcode/build_target"] },
	{ id: "repository-task", query: "list pull requests repository", relevant: ["github/list_pull_requests"] },
	{ id: "ambiguous-prefix", query: "get pull request diff", relevant: ["github/get_pull_request_diff"] },
	{ id: "workflow", query: "workflow run logs", relevant: ["github/get_workflow_run_logs"] },
	{ id: "search-tool", query: "search issues", relevant: ["github/search_issues"] },
	{ id: "metrics", query: "query datasource metrics", relevant: ["grafana/query_metrics"] },
	{ id: "plural", query: "search dashboard", relevant: ["grafana/search_dashboards"] },
	{ id: "title", query: "Trace Explorer", relevant: ["grafana/find_trace"] },
	{ id: "unicode-description", query: "ダッシュボード", relevant: ["grafana/search_japanese_dashboards"] },
	{ id: "multiple-relevant", query: "list labels", relevant: ["github/list_labels", "grafana/list_labels"] },
	{ id: "server-scope", query: "list labels", server: "grafana", relevant: ["grafana/list_labels"] },
	{ id: "absent-capability", query: "quasar ephemeris", relevant: [] },
];

export function createDiscoveryCatalog(size: number): DiscoveryCatalog {
	if (!Number.isInteger(size) || size < labeledTools.length) {
		throw new Error(`Catalog size must be an integer of at least ${labeledTools.length}`);
	}
	const servers = ["xcode", "github", "grafana"].map((id) => ({ id, tools: [] as Tool[] }));
	const properties = {
		id: { type: "string", description: "Stable identifier of the requested item." },
		limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum number of records." },
		cursor: { type: "string", description: "Opaque continuation supplied by the previous response." },
		format: { type: "string", enum: ["summary", "detailed"], description: "Fields to include in the result." },
	};
	for (const target of labeledTools) {
		const server = servers.find((entry) => entry.id === target.server)!;
		server.tools.push({
			name: target.name,
			title: target.title,
			description: target.description,
			inputSchema: {
				type: "object",
				properties: {
					...properties,
					...(target.parameter ? { [target.parameter]: { type: "string", description: target.parameter } } : {}),
				},
				required: target.parameter ? [target.parameter] : ["id"],
				additionalProperties: false,
			},
			outputSchema: { type: "object", properties: { records: { type: "array", items: { type: "object" } } } },
			annotations: { readOnlyHint: !target.name.startsWith("run_") && !target.name.startsWith("build_") },
		});
	}
	const domains = ["artifact", "profile", "schedule", "certificate", "asset", "environment"];
	const actions = ["read", "list", "search", "get"];
	for (let index = labeledTools.length; index < size; index++) {
		const domain = domains[index % domains.length];
		const action = actions[index % actions.length];
		servers[index % servers.length].tools.push({
			name: `${action}_${domain}_${String(index).padStart(5, "0")}`,
			title: `${domain} catalog entry ${index}`,
			description: `${action} ${domain} records with identifiers, status and timestamps.`,
			inputSchema: { type: "object", properties, required: ["id"], additionalProperties: false },
			outputSchema: { type: "object", properties: { value: { type: "string" } } },
			annotations: { readOnlyHint: true },
		});
	}
	return { servers, queries: DISCOVERY_QUERIES.map((query) => ({ ...query, relevant: [...query.relevant] })) };
}
