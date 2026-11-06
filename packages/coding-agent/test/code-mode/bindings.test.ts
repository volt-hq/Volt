import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	BINDABLE_BUILTIN_TOOL_NAMES,
	type CodeModeActiveTool,
	type CodeModeBindingSources,
	type CodeModeBindingSpec,
	type CodeModeBindingTarget,
	computeCodeModeBindings,
	NEVER_BINDABLE_TOOL_NAMES,
} from "../../src/core/code-mode/bindings.ts";
import {
	getTrustedToolOperationResolver,
	type IntegrationReadAuthority,
	isToolVisibleUnderGrant,
	RESEARCH_OPERATION_GRANT_PROFILE,
	type ToolOperationResolver,
} from "../../src/core/operation-authorization.ts";
import { allToolNames } from "../../src/core/tools/index.ts";
import { NATIVE_PLAN_TOOL_NAMES } from "../../src/core/tools/planning.ts";

// Section 5.12's eligibility table, written out independently of the implementation.
const DESIGN_BINDABLE = [
	"read",
	"grep",
	"find",
	"ls",
	"web_search",
	"web_fetch",
	"inspect",
	"lsp",
	"edit",
	"write",
	"bash",
	"image_gen",
];
const DESIGN_NEVER = [
	"request_user_input",
	"update_plan",
	"submit_plan",
	"update_plan_progress",
	"request_replan",
	"jobs",
	"subagent",
	"subagent_registry",
	"run_code",
	"mcp",
];

// Visibility under a grant depends only on the capability sets a resolver advertises, not on this authority.
const authority: IntegrationReadAuthority = {
	hasTrustedReads: () => true,
	hasTrustedToolReads: () => true,
	hasTrustedResourceReads: () => true,
	isTrustedToolRead: () => true,
};

function builtin(name: string): CodeModeActiveTool {
	return {
		name,
		kind: "builtin",
		resolver: getTrustedToolOperationResolver(name, { integrationReadAuthority: authority }),
	};
}

function other(name: string): CodeModeActiveTool {
	return { name, kind: "other" };
}

function direct(server: string, tool: string): CodeModeActiveTool {
	return { name: `mcp__${server}__${tool}`, kind: "mcp_direct", server, tool };
}

function sources(partial: Partial<CodeModeBindingSources>): CodeModeBindingSources {
	return { activeTools: [], grantProfile: undefined, mcpTools: [], ...partial };
}

function paths(bindings: CodeModeBindingSpec[]): string[][] {
	return bindings.map((binding) => binding.path);
}

/** Whether the model could make the call directly in a session with these sources (section 5.12). */
function directlyCallable(input: CodeModeBindingSources, target: CodeModeBindingTarget): boolean {
	const profile = input.grantProfile;
	const visible = (resolver: ToolOperationResolver | undefined) =>
		profile === undefined || isToolVisibleUnderGrant(resolver, profile);
	if (target.kind === "tool") {
		const tool = input.activeTools.find((candidate) => candidate.name === target.toolName);
		if (!tool || DESIGN_NEVER.includes(tool.name)) return false;
		if (tool.kind === "builtin") return DESIGN_BINDABLE.includes(tool.name) && visible(tool.resolver);
		return tool.kind === "other" && profile === undefined;
	}
	const gateway = input.activeTools.some(
		(tool) => tool.kind === "builtin" && tool.name === "mcp" && visible(tool.resolver),
	);
	const viaGateway =
		gateway &&
		input.mcpTools.some(
			(tool) =>
				tool.server === target.server && tool.tool === target.tool && (profile === undefined || tool.trustedRead),
		);
	const viaDirect =
		profile === undefined &&
		input.activeTools.some(
			(tool) => tool.kind === "mcp_direct" && tool.server === target.server && tool.tool === target.tool,
		);
	return viaGateway || viaDirect;
}

function pathOf(target: CodeModeBindingTarget): string[] {
	return target.kind === "tool" ? [target.toolName] : ["mcp", target.server, target.tool];
}

/** Whether the runtime accepts a binding at this path (`runCodeModeScript` validates bindings). */
function pathIsValid(path: string[]): boolean {
	return path.every((segment) => segment !== "" && segment !== "__proto__") && JSON.stringify(path).length <= 256;
}

const SERVERS = ["github", "my-server", "my_server"];
const MCP_TOOL_NAMES = ["create_issue", "get-file", "read.note", "__proto__", "", "t".repeat(250)];

const activeTool: fc.Arbitrary<CodeModeActiveTool> = fc.oneof(
	fc.constantFrom(...allToolNames, ...NATIVE_PLAN_TOOL_NAMES, "run_code", "future_builtin").map(builtin),
	fc
		.oneof(
			fc.constantFrom(...DESIGN_NEVER, "read", "bash", "__proto__", "", "x".repeat(300), "a.b", '["read"]'),
			fc.string({ maxLength: 12 }),
		)
		.map(other),
	fc
		.record({ server: fc.constantFrom(...SERVERS), tool: fc.constantFrom(...MCP_TOOL_NAMES) })
		.map(({ server, tool }) => direct(server, tool)),
);

const bindingSources: fc.Arbitrary<CodeModeBindingSources> = fc.record({
	activeTools: fc.uniqueArray(activeTool, { selector: (tool) => tool.name, maxLength: 14 }),
	grantProfile: fc.constantFrom(undefined, RESEARCH_OPERATION_GRANT_PROFILE),
	mcpTools: fc.array(
		fc.record({
			server: fc.constantFrom(...SERVERS),
			tool: fc.constantFrom(...MCP_TOOL_NAMES),
			trustedRead: fc.boolean(),
		}),
		{ maxLength: 8 },
	),
});

describe("code mode bindings", () => {
	it("classifies every built-in tool as bindable or never bindable, as the design lists them", () => {
		expect([...BINDABLE_BUILTIN_TOOL_NAMES].sort()).toStrictEqual([...DESIGN_BINDABLE].sort());
		expect([...NEVER_BINDABLE_TOOL_NAMES].sort()).toStrictEqual([...DESIGN_NEVER].sort());
		for (const name of [...allToolNames, ...NATIVE_PLAN_TOOL_NAMES]) {
			expect(BINDABLE_BUILTIN_TOOL_NAMES.has(name) !== NEVER_BINDABLE_TOOL_NAMES.has(name), name).toBe(true);
		}
	});

	it("binds exactly the calls the model could make directly, at paths the runtime accepts", () => {
		fc.assert(
			fc.property(bindingSources, (input) => {
				const bindings = computeCodeModeBindings(input);
				// Sound: every binding is a call the model could make directly, at its target's path.
				for (const binding of bindings) {
					expect(directlyCallable(input, binding.target), binding.name).toBe(true);
					expect(binding.path).toStrictEqual(pathOf(binding.target));
					expect(binding.name).toBe(JSON.stringify(binding.path));
					expect(pathIsValid(binding.path), binding.name).toBe(true);
				}
				// Unique and free of conflicts: no two bindings share a name, and no path is a namespace of another.
				const names = bindings.map((binding) => binding.name);
				expect(new Set(names).size).toBe(names.length);
				for (const outer of bindings) {
					for (const inner of bindings) {
						if (outer === inner) continue;
						const prefix = inner.path.slice(0, outer.path.length);
						expect(JSON.stringify(prefix) === outer.name, `${outer.name} contains ${inner.name}`).toBe(false);
					}
				}
				// Complete: every call the model could make directly, at a valid path, has a binding.
				const candidates: CodeModeBindingTarget[] = [
					...input.activeTools.flatMap((tool): CodeModeBindingTarget[] =>
						tool.kind === "mcp_direct"
							? [{ kind: "mcp", server: tool.server, tool: tool.tool }]
							: [{ kind: "tool", toolName: tool.name }],
					),
					...input.mcpTools.map(
						(tool): CodeModeBindingTarget => ({ kind: "mcp", server: tool.server, tool: tool.tool }),
					),
				];
				for (const target of candidates) {
					if (!directlyCallable(input, target) || !pathIsValid(pathOf(target))) continue;
					expect(names, JSON.stringify(target)).toContain(JSON.stringify(pathOf(target)));
				}
			}),
			{ numRuns: 1000 },
		);
	});

	it("binds built-in, extension, and MCP tools at their paths", () => {
		const bindings = computeCodeModeBindings(
			sources({
				activeTools: [builtin("read"), builtin("bash"), other("deploy"), builtin("mcp")],
				mcpTools: [
					{ server: "my-server", tool: "get-file", trustedRead: false },
					{ server: "github", tool: "create_issue", trustedRead: false },
				],
			}),
		);
		expect(bindings).toStrictEqual([
			{ name: '["read"]', path: ["read"], target: { kind: "tool", toolName: "read" } },
			{ name: '["bash"]', path: ["bash"], target: { kind: "tool", toolName: "bash" } },
			{ name: '["deploy"]', path: ["deploy"], target: { kind: "tool", toolName: "deploy" } },
			{
				name: '["mcp","github","create_issue"]',
				path: ["mcp", "github", "create_issue"],
				target: { kind: "mcp", server: "github", tool: "create_issue" },
			},
			{
				name: '["mcp","my-server","get-file"]',
				path: ["mcp", "my-server", "get-file"],
				target: { kind: "mcp", server: "my-server", tool: "get-file" },
			},
		]);
	});

	it("binds no never-bindable tool, whoever registered it", () => {
		for (const name of DESIGN_NEVER) {
			expect(computeCodeModeBindings(sources({ activeTools: [builtin(name)] })), name).toStrictEqual([]);
			expect(computeCodeModeBindings(sources({ activeTools: [other(name)] })), name).toStrictEqual([]);
		}
		// A built-in nobody has classified yet is not bindable either.
		expect(computeCodeModeBindings(sources({ activeTools: [builtin("future_builtin")] }))).toStrictEqual([]);
	});

	it("binds MCP tools only through an active gateway that is the built-in one, or their own direct tool", () => {
		const mcpTools = [{ server: "github", tool: "create_issue", trustedRead: false }];
		expect(computeCodeModeBindings(sources({ mcpTools }))).toStrictEqual([]);
		expect(computeCodeModeBindings(sources({ activeTools: [other("mcp")], mcpTools }))).toStrictEqual([]);
		const promoted = ["mcp", "github", "create_issue"];
		// A promoted tool gets one binding, whether the gateway, its direct tool, or both are active.
		for (const activeTools of [
			[builtin("mcp")],
			[direct("github", "create_issue")],
			[builtin("mcp"), direct("github", "create_issue")],
		]) {
			expect(paths(computeCodeModeBindings(sources({ activeTools, mcpTools })))).toStrictEqual([promoted]);
		}
	});

	it("limits bindings in Plan mode to what the research profile authorizes", () => {
		const bindings = computeCodeModeBindings(
			sources({
				grantProfile: RESEARCH_OPERATION_GRANT_PROFILE,
				activeTools: [
					...["read", "lsp", "inspect", "web_fetch", "bash", "edit", "write", "image_gen", "mcp"].map(builtin),
					other("deploy"),
					direct("github", "create_issue"),
				],
				mcpTools: [
					{ server: "github", tool: "search_issues", trustedRead: true },
					{ server: "github", tool: "create_issue", trustedRead: false },
				],
			}),
		);
		expect(paths(bindings)).toStrictEqual([
			["read"],
			["lsp"],
			["inspect"],
			["web_fetch"],
			["mcp", "github", "search_issues"],
		]);
	});

	it("omits bindings whose path the runtime would reject", () => {
		const bindings = computeCodeModeBindings(
			sources({
				activeTools: [other("__proto__"), other(""), other("x".repeat(300)), builtin("mcp")],
				mcpTools: [
					{ server: "github", tool: "__proto__", trustedRead: false },
					{ server: "github", tool: "t".repeat(250), trustedRead: false },
				],
			}),
		);
		expect(bindings).toStrictEqual([]);
	});
});
