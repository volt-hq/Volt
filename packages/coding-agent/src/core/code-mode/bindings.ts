import {
	isToolVisibleUnderGrant,
	type OperationGrantProfile,
	type ToolOperationResolver,
} from "../operation-authorization.ts";
import type { ToolName } from "../tools/index.ts";
import { MAX_BINDING_NAME_LENGTH } from "./limits.ts";
import type { CodeModeBinding } from "./prelude.ts";

/**
 * Whether scripts may call each built-in tool (section 5.12 of docs/code-mode-design.md). The type requires
 * every built-in tool to be listed, so a new built-in is not bindable until someone classifies it.
 */
const BUILTIN_TOOL_ELIGIBILITY = {
	read: "bindable",
	grep: "bindable",
	find: "bindable",
	ls: "bindable",
	web_search: "bindable",
	web_fetch: "bindable",
	inspect: "bindable",
	lsp: "bindable",
	edit: "bindable",
	write: "bindable",
	bash: "bindable",
	image_gen: "bindable",
	// Questions for the user belong in the conversation.
	request_user_input: "never",
	// Background jobs belong to model turns and their completion wake-ups.
	jobs: "never",
	// Without nested waits on the pool, scripts cannot deadlock it (section 5.3).
	subagent: "never",
	subagent_registry: "never",
	// MCP tools get their own bindings; the gateway's other actions manage servers.
	mcp: "never",
	// The code-mode tool itself: scripts do not start scripts.
	run_code: "never",
} as const satisfies Record<ToolName, "bindable" | "never">;

/** Built-in tools scripts may call. Any other built-in is not bindable. */
export const BINDABLE_BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set(
	Object.entries(BUILTIN_TOOL_ELIGIBILITY)
		.filter(([, eligibility]) => eligibility === "bindable")
		.map(([name]) => name),
);

/** Tools scripts never call, whatever registered a tool by that name. */
export const NEVER_BINDABLE_TOOL_NAMES: ReadonlySet<string> = new Set([
	...Object.entries(BUILTIN_TOOL_ELIGIBILITY)
		.filter(([, eligibility]) => eligibility === "never")
		.map(([name]) => name),
	// The planning tools control the session.
	"update_plan",
	"submit_plan",
	"update_plan_progress",
	"request_replan",
]);

/** An active tool, as the model could call it directly. */
export type CodeModeActiveTool =
	/** A trusted built-in tool, with its trusted operation resolver if it has one. */
	| { name: string; kind: "builtin"; resolver: ToolOperationResolver | undefined }
	/** An MCP tool promoted to a direct tool. */
	| { name: string; kind: "mcp_direct"; server: string; tool: string }
	/** An extension or SDK tool, or a built-in tool replaced by one. These have no trusted resolver. */
	| { name: string; kind: "other" };

/** An MCP tool with fresh metadata that passes its server's tool filters. */
export interface CodeModeMcpTool {
	server: string;
	tool: string;
	/** Whether the server's configuration trusts the tool as a read. */
	trustedRead: boolean;
}

/** What the model could call directly at the moment a script starts. */
export interface CodeModeBindingSources {
	/** The active tools, in activation order. */
	activeTools: readonly CodeModeActiveTool[];
	/** The grant profile of a restricted mode such as Plan mode, or undefined when the session is unrestricted. */
	grantProfile: OperationGrantProfile | undefined;
	mcpTools: readonly CodeModeMcpTool[];
}

export type CodeModeBindingTarget =
	| { kind: "tool"; toolName: string }
	/**
	 * An MCP tool, and the tool a model-issued call to it goes through: the built-in `mcp` gateway, or the MCP tool's
	 * own direct tool.
	 */
	| { kind: "mcp"; server: string; tool: string; toolName: string };

/** A binding and the call it makes. Its name, used in call messages, is the JSON text of its path. */
export interface CodeModeBindingSpec extends CodeModeBinding {
	target: CodeModeBindingTarget;
}

/**
 * The bindings of a script (section 5.12 of docs/code-mode-design.md): one for each call the model could make
 * directly in the session, excluding tools that are never bindable. MCP tools are bound through the built-in
 * `mcp` gateway or their own direct tool, once each, at `mcp.<server>.<tool>`; the gateway routes the calls of a
 * tool both make callable. In a restricted mode, a binding
 * exists only for a tool the grant profile can authorize, and for an MCP tool only if it is a trusted read.
 *
 * Paths are unique and never a namespace of another path, because tool names are unique, `mcp` is never bound
 * itself, and MCP paths have three segments. A binding whose path the runtime would reject (an empty or
 * `__proto__` segment, or a name longer than the binding-name limit) is omitted.
 */
export function computeCodeModeBindings(sources: CodeModeBindingSources): CodeModeBindingSpec[] {
	const { grantProfile } = sources;
	const authorized = (resolver: ToolOperationResolver | undefined) => isAuthorized(resolver, grantProfile);
	const bindings: CodeModeBindingSpec[] = [];
	const add = (path: string[], target: CodeModeBindingTarget): void => {
		if (path.some((segment) => segment === "" || segment === "__proto__")) return;
		const name = JSON.stringify(path);
		if (name.length > MAX_BINDING_NAME_LENGTH) return;
		bindings.push({ name, path, target });
	};

	const mcpTargets = new Map<string, { server: string; tool: string; toolName: string }>();
	let gatewayActive = false;
	for (const tool of sources.activeTools) {
		if (NEVER_BINDABLE_TOOL_NAMES.has(tool.name)) {
			// The gateway is never bound itself, but the built-in one makes MCP tools callable.
			if (tool.kind === "builtin" && tool.name === "mcp" && authorized(tool.resolver)) gatewayActive = true;
			continue;
		}
		switch (tool.kind) {
			case "builtin":
				if (BINDABLE_BUILTIN_TOOL_NAMES.has(tool.name) && authorized(tool.resolver)) {
					add([tool.name], { kind: "tool", toolName: tool.name });
				}
				break;
			case "other":
				// Without a trusted resolver, no grant profile can authorize the tool.
				if (grantProfile === undefined) add([tool.name], { kind: "tool", toolName: tool.name });
				break;
			case "mcp_direct":
				// Direct tools have no trusted resolver either.
				if (grantProfile === undefined) {
					mcpTargets.set(JSON.stringify([tool.server, tool.tool]), {
						server: tool.server,
						tool: tool.tool,
						toolName: tool.name,
					});
				}
				break;
		}
	}
	if (gatewayActive) {
		for (const tool of sources.mcpTools) {
			if (grantProfile !== undefined && !tool.trustedRead) continue;
			// Replaces the tool's direct route: the gateway routes the calls of a tool both make callable.
			mcpTargets.set(JSON.stringify([tool.server, tool.tool]), {
				server: tool.server,
				tool: tool.tool,
				toolName: "mcp",
			});
		}
	}
	const sortedTargets = [...mcpTargets.values()].sort(
		(left, right) => compare(left.server, right.server) || compare(left.tool, right.tool),
	);
	for (const target of sortedTargets) add(["mcp", target.server, target.tool], { kind: "mcp", ...target });
	return bindings;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** What a script's call to an MCP tool resolves with (section 5.9 of docs/code-mode-design.md). */
export const CODE_MODE_MCP_RESULT_SHAPE = "Promise<{ text: string; structured?: unknown; images: ImageRef[] }>";

/**
 * How a script calls the binding at `path` (section 5.14 of docs/code-mode-design.md): `tools.<segment>...(args)`, with
 * brackets for segments that are not JavaScript identifiers, as in `tools.mcp["my-server"]["get-file"](args)`.
 */
export function codeModeCallExpression(path: readonly string[]): string {
	const access = path.map((segment) => (IDENTIFIER.test(segment) ? `.${segment}` : `[${JSON.stringify(segment)}]`));
	return `tools${access.join("")}(args)`;
}

/**
 * Whether scripts can call MCP tools in a session with these sources, whichever tools are listed: the built-in `mcp`
 * gateway is active and the grant profile, if any, authorizes it, or a direct MCP tool is bound.
 */
export function codeModeCallsMcpTools(sources: Omit<CodeModeBindingSources, "mcpTools">): boolean {
	const { grantProfile } = sources;
	const gateway = sources.activeTools.some(
		(tool) => tool.kind === "builtin" && tool.name === "mcp" && isAuthorized(tool.resolver, grantProfile),
	);
	// Direct tools are bound whichever MCP tools are listed.
	return (
		gateway || computeCodeModeBindings({ ...sources, mcpTools: [] }).some((binding) => binding.target.kind === "mcp")
	);
}

function isAuthorized(
	resolver: ToolOperationResolver | undefined,
	grantProfile: OperationGrantProfile | undefined,
): boolean {
	return grantProfile === undefined || isToolVisibleUnderGrant(resolver, grantProfile);
}

function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
