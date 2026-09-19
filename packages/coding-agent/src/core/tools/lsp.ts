/**
 * LSP navigation tool: definition, references, hover, symbols, and on-demand
 * diagnostics through the language servers configured in the lsp settings.
 *
 * The tool is registered as a built-in but only does useful work when an
 * LspNavigationProvider (the LspManager) is supplied, i.e. when LSP is not
 * disabled in settings.
 */

import type { AgentTool } from "@hansjm10/volt-agent-core";
import { StringEnum } from "@hansjm10/volt-ai";
import { Text } from "@hansjm10/volt-tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { isManagedLspObservation, recordManagedLspOutcome } from "../lsp/managed-observation.ts";
import {
	type LspOperationMetadata,
	type LspResult,
	lspErrorResult,
	lspOperationMetadata,
	lspResult,
	lspSucceeded,
} from "../lsp/outcome.ts";
import type { Theme } from "../theme/runtime.ts";
import { resolveToCwd } from "./path-utils.ts";
import { renderToolPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

export const LSP_ACTIONS = [
	"status",
	"definition",
	"references",
	"implementations",
	"type-definition",
	"callers",
	"callees",
	"hover",
	"symbols",
	"diagnostics",
	"rename",
	"fix",
] as const;
export type LspAction = (typeof LSP_ACTIONS)[number];

/**
 * Navigation interface implemented by the LspManager.
 *
 * Methods return a shared typed outcome with readable text. Explicit failures
 * set the tool's isError flag without losing diagnostic freshness or metadata.
 */
export interface LspNavigationProvider {
	status(absolutePath?: string): Promise<LspResult>;
	definition(absolutePath: string, symbol: string, line?: number, signal?: AbortSignal): Promise<LspResult>;
	references(absolutePath: string, symbol: string, line?: number, signal?: AbortSignal): Promise<LspResult>;
	implementations(absolutePath: string, symbol: string, line?: number, signal?: AbortSignal): Promise<LspResult>;
	typeDefinition(absolutePath: string, symbol: string, line?: number, signal?: AbortSignal): Promise<LspResult>;
	hover(absolutePath: string, symbol: string, line?: number, signal?: AbortSignal): Promise<LspResult>;
	documentSymbols(absolutePath: string, signal?: AbortSignal): Promise<LspResult>;
	workspaceSymbols(absolutePath: string, query: string, signal?: AbortSignal): Promise<LspResult>;
	callHierarchy(
		absolutePath: string,
		symbol: string,
		direction: "incoming" | "outgoing",
		line?: number,
		signal?: AbortSignal,
	): Promise<LspResult>;
	fileDiagnostics(absolutePath: string, signal?: AbortSignal): Promise<LspResult>;
	rename(
		absolutePath: string,
		symbol: string,
		newName: string,
		line?: number,
		signal?: AbortSignal,
	): Promise<LspResult>;
	codeFix(
		absolutePath: string,
		options: { symbol?: string; line?: number; title?: string; kind?: string },
		signal?: AbortSignal,
	): Promise<LspResult>;
}

const lspSchema = Type.Object({
	action: StringEnum(LSP_ACTIONS, {
		description:
			"status: health/capabilities without startup (path optional). definition: where a symbol is defined. references: all usages of a symbol. implementations: implementations of an interface/abstract symbol. type-definition: where a symbol's type is defined. callers: functions that call a symbol. callees: functions a symbol calls. hover: type/docs for a symbol. symbols: outline of a file, or project-wide symbol search when symbol is provided. diagnostics: current errors in a file. rename: rename a symbol across the project. fix: apply a quick fix (e.g. add a missing import) or a kind like source.organizeImports.",
	}),
	path: Type.Optional(
		Type.String({ description: "Path to the file to query (relative or absolute). Required except for status." }),
	),
	symbol: Type.Optional(
		Type.String({
			description:
				"Symbol name to look up. Required for definition, references, callers, callees, hover, and rename; recommended for fix. For symbols, turns the file outline into a project-wide symbol search using this as the query.",
		}),
	),
	line: Type.Optional(
		Type.Number({
			description:
				"1-based line number where the symbol occurrence is located. Recommended when the symbol appears multiple times in the file. For fix without a symbol, selects the line to fix.",
		}),
	),
	newName: Type.Optional(
		Type.String({
			description: "New symbol name. Required for rename.",
		}),
	),
	title: Type.Optional(
		Type.String({
			description: "Code action title to apply when fix reports multiple available actions.",
		}),
	),
	kind: Type.Optional(
		Type.String({
			description:
				'Code action kind filter for fix, e.g. "source.organizeImports" to organize imports or "source.fixAll" to apply all safe fixes (requested over the whole file when no symbol/line is given).',
		}),
	),
});

export type LspToolInput = Static<typeof lspSchema>;

export interface LspToolDetails {
	action: LspAction;
	lsp: LspOperationMetadata;
}

export interface LspToolOptions {
	/** Navigation provider (the LspManager). When absent, the tool reports that LSP is disabled. */
	provider?: LspNavigationProvider;
}

function formatLspCall(args: Partial<LspToolInput> | undefined, theme: Theme, cwd: string): string {
	const action = str(args?.action) ?? "";
	const path = str(args?.path);
	const line = typeof args?.line === "number" ? `:${args.line}` : "";
	const symbol = str(args?.symbol);
	let text = `${theme.fg("toolTitle", theme.bold("lsp"))} ${theme.fg("muted", action)}`;
	if (path) {
		text += ` ${renderToolPath(path, theme, cwd)}${theme.fg("muted", line)}`;
	}
	if (symbol) {
		text += ` ${theme.fg("toolOutput", symbol)}`;
	}
	const newName = str(args?.newName);
	if (newName) {
		text += ` ${theme.fg("muted", "->")} ${theme.fg("toolOutput", newName)}`;
	}
	const title = str(args?.title);
	if (title) {
		text += ` ${theme.fg("muted", `"${title}"`)}`;
	}
	return text;
}

export function createLspToolDefinition(
	cwd: string,
	options?: LspToolOptions,
): ToolDefinition<typeof lspSchema, LspToolDetails | undefined> {
	const provider = options?.provider;
	return {
		name: "lsp",
		label: "lsp",
		description:
			"Query language servers for code intelligence and refactoring. Actions: status (health/capabilities without startup, optional path), definition (where a symbol is defined), references (all usages of a symbol), implementations (implementations of an interface/abstract symbol), type-definition (where a symbol's type is defined), callers (functions calling a symbol), callees (functions a symbol calls), hover (type signature and docs), symbols (file outline, or project-wide symbol search when symbol is provided), diagnostics (current errors in a file), rename (rename a symbol across the project; requires symbol and newName), fix (apply a quick fix for diagnostics at a symbol or line; pass title to choose among multiple, or kind such as source.organizeImports). definition/references/implementations/type-definition/callers/callees/hover/rename require a symbol name; pass line when the symbol occurs more than once.",
		promptSnippet:
			"Code intelligence via language servers: definition, references, hover, symbols, diagnostics, rename, quick fixes",
		promptGuidelines: [
			"Use lsp status to inspect health and capabilities without starting servers. Prefer supported lsp references/definition over search for semantic navigation. If unavailable or unsupported, use search and build checks instead of repeating failed calls.",
			"Use supported lsp rename/fix for safe project refactoring in Build mode. Diagnostics marked unverified/stale/unknown are not proof of a clean build.",
		],
		parameters: lspSchema,
		async execute(_toolCallId, input: LspToolInput, signal?: AbortSignal, _onUpdate?, _ctx?) {
			const startedAt = performance.now();
			const finish = (result: LspResult) => {
				recordManagedLspOutcome(result.outcome);
				return {
					content: [{ type: "text" as const, text: result.text }],
					details: {
						action: input.action,
						lsp: lspOperationMetadata(result, "explicit", input.action, startedAt),
					},
					isError: !lspSucceeded(result),
				};
			};
			if (isManagedLspObservation() && (input.action === "rename" || input.action === "fix")) {
				return finish(lspResult("invalid-input", "Managed LSP discovery is read-only."));
			}
			if (!provider)
				return finish(
					lspResult(
						input.action === "status" ? "success" : "unavailable",
						"LSP is disabled. Run volt with --lsp or set lsp.enabled=true in settings.",
						{ reason: "disabled" },
					),
				);
			if (input.action !== "status" && !input.path)
				return finish(lspResult("invalid-input", `lsp ${input.action} requires path.`));
			const absolutePath = input.path ? resolveToCwd(input.path, cwd) : cwd;
			const needsSymbol =
				input.action === "definition" ||
				input.action === "references" ||
				input.action === "implementations" ||
				input.action === "type-definition" ||
				input.action === "callers" ||
				input.action === "callees" ||
				input.action === "hover" ||
				input.action === "rename";
			if (needsSymbol && !input.symbol) {
				return finish(lspResult("invalid-input", `lsp ${input.action} requires a symbol name.`));
			}
			if (input.action === "rename" && !input.newName) {
				return finish(lspResult("invalid-input", "lsp rename requires newName."));
			}

			let result: LspResult;
			try {
				switch (input.action) {
					case "status":
						result = await provider.status(input.path ? absolutePath : undefined);
						break;
					case "definition":
						result = await provider.definition(absolutePath, input.symbol!, input.line, signal);
						break;
					case "references":
						result = await provider.references(absolutePath, input.symbol!, input.line, signal);
						break;
					case "implementations":
						result = await provider.implementations(absolutePath, input.symbol!, input.line, signal);
						break;
					case "type-definition":
						result = await provider.typeDefinition(absolutePath, input.symbol!, input.line, signal);
						break;
					case "callers":
						result = await provider.callHierarchy(absolutePath, input.symbol!, "incoming", input.line, signal);
						break;
					case "callees":
						result = await provider.callHierarchy(absolutePath, input.symbol!, "outgoing", input.line, signal);
						break;
					case "hover":
						result = await provider.hover(absolutePath, input.symbol!, input.line, signal);
						break;
					case "symbols":
						result = input.symbol
							? await provider.workspaceSymbols(absolutePath, input.symbol, signal)
							: await provider.documentSymbols(absolutePath, signal);
						break;
					case "diagnostics":
						result = await provider.fileDiagnostics(absolutePath, signal);
						break;
					case "rename":
						result = await provider.rename(absolutePath, input.symbol!, input.newName!, input.line, signal);
						break;
					case "fix":
						result = await provider.codeFix(
							absolutePath,
							{ symbol: input.symbol, line: input.line, title: input.title, kind: input.kind },
							signal,
						);
						break;
					default:
						throw new Error(`Unknown lsp action: ${String(input.action)}`);
				}
			} catch (error) {
				result = lspErrorResult(error);
			}
			// Canonicalization, disk reads and synchronization remain awaited even
			// after cancellation; do not publish their late discovery as success.
			if (isManagedLspObservation() && signal?.aborted) {
				result = lspResult("cancelled", "LSP operation aborted", { reason: "aborted" });
			}
			return finish(result);
		},
		renderResult(result, options, theme, context) {
			const evidence = result.details?.lsp;
			const output = result.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			const lines = output.split("\n");
			const shown = options.expanded ? lines : lines.slice(0, 10);
			const uncertainty =
				evidence && evidence.freshness !== "fresh" && evidence.source !== "none"
					? `Diagnostics: ${evidence.freshness} (${evidence.source})\n`
					: "";
			const color = context.isError ? "error" : uncertainty ? "warning" : "toolOutput";
			const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			component.setText(
				theme.fg(
					color,
					uncertainty +
						shown.join("\n") +
						(shown.length < lines.length ? `\n... (${lines.length - shown.length} more lines)` : ""),
				),
			);
			return component;
		},
		renderCall(args, theme, context) {
			const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			component.setText(formatLspCall(args as Partial<LspToolInput> | undefined, theme, context.cwd));
			return component;
		},
	};
}

export function createLspTool(
	cwd: string,
	options?: LspToolOptions,
): AgentTool<typeof lspSchema, LspToolDetails | undefined> {
	return wrapToolDefinition(createLspToolDefinition(cwd, options));
}
