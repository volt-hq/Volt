import type { AgentToolResult } from "@hansjm10/volt-agent-core";
import type { JsonObject } from "@hansjm10/volt-ai";
import { Text } from "@hansjm10/volt-tui";
import { type Static, type TObject, type TProperties, Type } from "typebox";
import type { BackgroundJobManager, BackgroundJobSnapshot, BackgroundToolName } from "../background-jobs.ts";
import { cloneCanonicalData } from "../canonical-data.ts";
import type { ToolDefinition, ToolRenderContext } from "../extensions/types.ts";
import { withBackgroundCleanup } from "./background-cleanup.ts";

const backgroundParameter = Type.Optional(
	Type.Boolean({
		description:
			"Run this work as a session-owned background job and return a job ID. Requires the jobs tool. Omit to wait for completion.",
	}),
);
type BackgroundParameters<T extends TProperties> = TObject<T & { background: typeof backgroundParameter }>;

export interface BackgroundJobDetails {
	backgroundJob: BackgroundJobSnapshot;
}

export interface BackgroundToolOptions {
	manager: BackgroundJobManager;
	/** Apply the original tool's result policy before retaining its final output. */
	finalize?: (
		toolName: BackgroundToolName,
		toolCallId: string,
		input: JsonObject,
		result: AgentToolResult<unknown>,
		signal: AbortSignal,
	) => Promise<AgentToolResult<unknown>>;
}

export function backgroundJobResult(snapshot: BackgroundJobSnapshot): AgentToolResult<BackgroundJobDetails> {
	return {
		content: [
			{
				type: "text",
				text: `Background job ${snapshot.id}: ${snapshot.status} (${snapshot.toolName}). Use jobs with action read, wait, or cancel and this id.\n${snapshot.outputTruncated ? "[Output truncated to the latest 50 KB or 2000 lines.]\n" : ""}${snapshot.output}`.trim(),
			},
		],
		details: { backgroundJob: snapshot },
		...(snapshot.status === "failed" || snapshot.status === "cancelled" ? { isError: true } : {}),
	};
}

/** Applied only to native Bash/subagent definitions, before extension overrides. */
export function withBackgroundJobs<T extends TProperties, TDetails, TState>(
	definition: ToolDefinition<TObject<T>, TDetails, TState>,
	options: BackgroundToolOptions,
): ToolDefinition<BackgroundParameters<T>, unknown, TState> {
	if (definition.name !== "bash" && definition.name !== "subagent") {
		throw new Error("Only native bash and subagent tools support background jobs.");
	}
	const toolName = definition.name;
	type OriginalArgs = Static<TObject<T>>;
	const parameters = {
		...definition.parameters,
		properties: { ...definition.parameters.properties, background: backgroundParameter },
	} as BackgroundParameters<T>;
	return {
		...definition,
		parameters,
		description: `${definition.description} Set background: true to return a job ID and continue independent work; use jobs to read, wait, or cancel. Subagent confirmation preflight still returns directly. Background jobs are cancelled on session abort or shutdown and cannot survive a runtime restart.`,
		promptGuidelines: [
			...(definition.promptGuidelines ?? []),
			`Use ${toolName} with background: true only for independent work. Use jobs to collect the result before relying on it or reporting success.`,
		],
		prepareArguments: definition.prepareArguments
			? (args) => {
					const prepared = definition.prepareArguments!(args);
					const background =
						args && typeof args === "object" && "background" in args ? args.background : undefined;
					return { ...prepared, ...(background === undefined ? {} : { background }) } as Static<
						BackgroundParameters<T>
					>;
				}
			: undefined,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const owned = cloneCanonicalData(params, "Background tool arguments") as JsonObject;
			const { background, ...input } = owned;
			if (background !== undefined && typeof background !== "boolean")
				throw new Error("background must be a boolean.");
			if (signal?.aborted) throw new Error("Operation aborted");
			if (background && toolName === "subagent" && (input.list || input.follow || input.resume)) {
				throw new Error("background is supported only for subagent single, parallel, and chain spawning.");
			}
			const needsPreflight =
				toolName === "subagent" && "confirm" in definition.parameters.properties && !input.confirm;
			if (!background || needsPreflight) {
				return (await definition.execute(
					toolCallId,
					input as OriginalArgs,
					signal,
					onUpdate ? (update) => onUpdate(update as AgentToolResult<unknown>) : undefined,
					ctx,
				)) as AgentToolResult<unknown>;
			}
			const label =
				typeof input.command === "string"
					? input.command
					: typeof input.task === "string"
						? input.task
						: "Subagent batch";
			const snapshot = options.manager.start({
				toolName,
				toolCallId,
				label,
				execute: async (jobSignal, update) => {
					let result: AgentToolResult<unknown>;
					try {
						result = (await withBackgroundCleanup(() =>
							definition.execute(
								toolCallId,
								input as OriginalArgs,
								jobSignal,
								(partial) => update(partial as AgentToolResult<unknown>),
								{ ...ctx, signal: jobSignal },
							),
						)) as AgentToolResult<unknown>;
					} catch (error) {
						result = {
							content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
							isError: true,
						};
					}
					result = cloneCanonicalData(result, "Background tool final result");
					// Subagent terminal status is authoritative even when the existing
					// foreground tool carries failure in details instead of isError.
					if (
						toolName === "subagent" &&
						result.details &&
						typeof result.details === "object" &&
						"status" in result.details &&
						result.details.status !== "completed"
					) {
						result = { ...result, isError: true };
					}
					return options.finalize ? options.finalize(toolName, toolCallId, input, result, jobSignal) : result;
				},
			});
			return backgroundJobResult(snapshot);
		},
		renderCall: definition.renderCall
			? (args, theme, context) =>
					definition.renderCall!(args as OriginalArgs, theme, context as ToolRenderContext<TState, OriginalArgs>)
			: undefined,
		renderResult(result, renderOptions, theme, context) {
			if (result.details && typeof result.details === "object" && "backgroundJob" in result.details) {
				return new Text(
					result.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n"),
					0,
					0,
				);
			}
			return definition.renderResult
				? definition.renderResult(
						result as AgentToolResult<TDetails>,
						renderOptions,
						theme,
						context as ToolRenderContext<TState, OriginalArgs>,
					)
				: new Text(
						result.content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("\n"),
						0,
						0,
					);
		},
	};
}
