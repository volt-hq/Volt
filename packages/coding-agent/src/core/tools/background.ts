import type { AgentToolResult } from "@hansjm10/volt-agent-core";
import type { JsonObject } from "@hansjm10/volt-ai";
import { type Static, type TObject, type TProperties, Type } from "typebox";
import { cloneCanonicalData } from "../canonical-data.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { ToolPresenter } from "../ui/presentation.ts";
import { withBackgroundCleanup } from "./background-cleanup.ts";
import { type JobStart, type JobSummary, type JobToolName, jobResult } from "./jobs.ts";
import { presentBackground } from "./presenters.ts";

const backgroundParameter = Type.Optional(
	Type.Boolean({
		description:
			"Run this work as a background job of the conversation and return a job ID. Requires the jobs tool. Omit to wait for completion.",
	}),
);
type BackgroundParameters<T extends TProperties> = TObject<T & { background: typeof backgroundParameter }>;

export interface BackgroundToolOptions {
	/** Start a job for the call; resolves once it is recorded. */
	start(job: JobStart): Promise<JobSummary>;
	/** Apply the original tool's result policy before the job keeps its final output. */
	finalize?: (
		toolName: JobToolName,
		toolCallId: string,
		input: JsonObject,
		result: AgentToolResult<unknown>,
		signal: AbortSignal,
	) => Promise<AgentToolResult<unknown>>;
}

function labelOf(input: Record<string, unknown>): string | undefined {
	return typeof input.command === "string" ? input.command : typeof input.task === "string" ? input.task : undefined;
}

/** Applied only to native Bash/subagent definitions, before extension overrides. */
export function withBackgroundJobs<T extends TProperties, TDetails>(
	definition: ToolDefinition<TObject<T>, TDetails>,
	options: BackgroundToolOptions,
): ToolDefinition<BackgroundParameters<T>, unknown> {
	if (definition.name !== "bash" && definition.name !== "subagent") {
		throw new Error("Only native bash and subagent tools support background jobs.");
	}
	const toolName = definition.name;
	type OriginalArgs = Static<TObject<T>>;
	const parameters = {
		...definition.parameters,
		properties: { ...definition.parameters.properties, background: backgroundParameter },
	} as BackgroundParameters<T>;
	// The wrapped definition's presenter is typed for its parameters; the wrapper presents instead.
	const { present: _present, ...base } = definition;
	return {
		...base,
		parameters,
		description: `${definition.description} Set background: true to return a job ID and continue independent work; use jobs to read, wait, or cancel. Subagent confirmation preflight still returns directly. Background jobs are cancelled on session abort; a job running when the runtime stops ends interrupted.`,
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
			const job = await options.start({
				tool: toolName,
				toolCallId,
				label: labelOf(input) ?? "Subagent batch",
				run: async (jobSignal, update) => {
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
			return jobResult(job);
		},
		...(definition.present === undefined ? {} : { present: presentBackground(definition.present as ToolPresenter) }),
	};
}
