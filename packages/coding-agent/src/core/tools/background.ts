import type { AgentToolResult } from "@hansjm10/volt-agent-core";
import type { JsonObject } from "@hansjm10/volt-ai";
import { type Static, type TObject, type TProperties, Type } from "typebox";
import { cloneCanonicalData } from "../canonical-data.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { ToolPresenter } from "../ui/presentation.ts";
import { withBackgroundCleanup, withMovableCleanup } from "./background-cleanup.ts";
import { withBashStallMove } from "./bash.ts";
import { type JobStart, type JobSummary, type JobToolName, jobResult } from "./jobs.ts";
import { presentBackground } from "./presenters.ts";

const backgroundParameter = Type.Optional(
	Type.Boolean({
		description:
			"Run this work as a background job of the conversation and return a job ID. Requires the jobs tool. Omit to wait for completion.",
	}),
);
const descriptionParameter = Type.Optional(
	Type.String({
		description:
			'Short user-facing label for a background job (3-8 words, e.g. "Run coding-agent unit tests"). Shown in job lists, the work status, and notices instead of the raw command or task. Only used with background: true.',
	}),
);
type BackgroundParameters<T extends TProperties> = TObject<
	T & { background: typeof backgroundParameter; description: typeof descriptionParameter }
>;

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

/** The job's label: the caller's description, else the command or task. */
function labelOf(description: string | undefined, input: Record<string, unknown>): string {
	if (description?.trim()) return description;
	return typeof input.command === "string"
		? input.command
		: typeof input.task === "string"
			? input.task
			: "Subagent batch";
}

/** A foreground Bash call's move acknowledgement, without output that has not passed its result policy. */
function movedResult(job: JobSummary, silentSeconds: number): AgentToolResult<unknown> {
	const status = `Command produced no output for ${silentSeconds} seconds and is still running as background job ${job.id}. Use jobs wait to collect its result, jobs read for its latest output, or jobs cancel if it is hung.`;
	return {
		content: [{ type: "text", text: status }],
		// As with explicit background starts, only the settled job result passes the tool's result policy.
		details: { job },
	};
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
	// A tool that declares its own description (bash) keeps it; it labels the job as well.
	const parameters = {
		...definition.parameters,
		properties: {
			...definition.parameters.properties,
			background: backgroundParameter,
			...("description" in definition.parameters.properties ? {} : { description: descriptionParameter }),
		},
	} as BackgroundParameters<T>;
	// The wrapped definition's presenter is typed for its parameters; the wrapper presents instead.
	const { present: _present, ...base } = definition;
	return {
		...base,
		parameters,
		description: `${definition.description}${toolName === "bash" ? " With jobs active, a foreground command that goes silent for its stallTimeout is not killed: it keeps running as a background job, and the result names the job to wait for." : ""} Set background: true (with a short description) to return a job ID and continue independent work; use jobs to read, wait, or cancel. Subagent confirmation preflight still returns directly. Background jobs are cancelled on session abort; a job running when the runtime stops ends interrupted.`,
		promptGuidelines: [
			...(definition.promptGuidelines ?? []),
			`Use ${toolName} with background: true only for independent work, and give it a short description the user sees instead of the raw ${toolName === "bash" ? "command" : "task"}. Use jobs to collect the result before relying on it or reporting success.`,
		],
		prepareArguments: definition.prepareArguments
			? (args) => {
					const prepared = definition.prepareArguments!(args);
					const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
					const { background, description } = record;
					return {
						...prepared,
						...(background === undefined ? {} : { background }),
						...(description === undefined ? {} : { description }),
					} as Static<BackgroundParameters<T>>;
				}
			: undefined,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const owned = cloneCanonicalData(params, "Background tool arguments") as JsonObject;
			const { background, description, ...input } = owned;
			if (background !== undefined && typeof background !== "boolean")
				throw new Error("background must be a boolean.");
			if (description !== undefined && typeof description !== "string")
				throw new Error("description must be a string.");
			if (signal?.aborted) throw new Error("Operation aborted");
			if (background && toolName === "subagent" && (input.list || input.follow || input.resume)) {
				throw new Error("background is supported only for subagent single, parallel, and chain spawning.");
			}
			const needsPreflight =
				toolName === "subagent" && "confirm" in definition.parameters.properties && !input.confirm;
			const execute = (
				runSignal: AbortSignal | undefined,
				update: ((partial: AgentToolResult<unknown>) => void) | undefined,
				runCtx: typeof ctx,
			) =>
				definition.execute(
					toolCallId,
					input as OriginalArgs,
					runSignal,
					update ? (partial) => update(partial as AgentToolResult<unknown>) : undefined,
					runCtx,
				) as Promise<AgentToolResult<unknown>>;
			// A job's final result: the tool's, or its error, through the original tool's result policy.
			const settleJob = async (
				run: () => Promise<AgentToolResult<unknown>>,
				jobSignal: AbortSignal,
			): Promise<AgentToolResult<unknown>> => {
				let result: AgentToolResult<unknown>;
				try {
					result = await run();
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
			};
			if (needsPreflight || (!background && toolName !== "bash")) return execute(signal, onUpdate, ctx);
			if (!background) {
				// A foreground command that goes silent for its stall deadline moves to a
				// job instead of dying. Until the job owns it, the call's signal stops it
				// and its progress reaches the call; then the job's signal and progress do.
				const controller = new AbortController();
				let jobOwns = false;
				const stopForeground = () => {
					if (!jobOwns) controller.abort(signal?.reason);
				};
				if (signal?.aborted) stopForeground();
				else signal?.addEventListener("abort", stopForeground, { once: true });
				let latest: AgentToolResult<unknown> | undefined;
				let jobUpdate: ((partial: AgentToolResult<unknown>) => void) | undefined;
				const update = (partial: AgentToolResult<unknown>) => {
					latest = partial;
					if (jobUpdate) jobUpdate(partial);
					else onUpdate?.(partial);
				};
				// While a move is being decided, the call does not return the command's own result.
				let moving = false;
				let answer!: (result: AgentToolResult<unknown> | Promise<AgentToolResult<unknown>>) => void;
				const answered = new Promise<AgentToolResult<unknown>>((resolve) => {
					answer = resolve;
				});
				const move = async (silentSeconds: number): Promise<boolean> => {
					if (signal?.aborted) return false;
					moving = true;
					try {
						const job = await options.start({
							tool: "bash",
							toolCallId,
							label: labelOf(description, input),
							run: (jobSignal, toJob) => {
								jobOwns = true;
								signal?.removeEventListener("abort", stopForeground);
								movable.moveToBackground();
								jobUpdate = toJob;
								if (latest) toJob(latest);
								const stopJob = () => controller.abort(jobSignal.reason);
								if (jobSignal.aborted) stopJob();
								else jobSignal.addEventListener("abort", stopJob, { once: true });
								return settleJob(
									() => movable.result.finally(() => jobSignal.removeEventListener("abort", stopJob)),
									jobSignal,
								);
							},
						});
						answer(movedResult(job, silentSeconds));
						return true;
					} catch {
						// No job can take it: the command is killed as hung, and the call returns that.
						moving = false;
						answer(movable.result);
						return false;
					}
				};
				const movable = withMovableCleanup(() =>
					withBashStallMove(move, () => execute(controller.signal, update, { ...ctx, signal: controller.signal })),
				);
				const settled = () => {
					if (!moving) answer(movable.result);
				};
				movable.result.then(settled, settled);
				try {
					return await answered;
				} finally {
					if (!jobOwns) signal?.removeEventListener("abort", stopForeground);
				}
			}
			const job = await options.start({
				tool: toolName,
				toolCallId,
				label: labelOf(description, input),
				run: (jobSignal, update) =>
					settleJob(
						() => withBackgroundCleanup(() => execute(jobSignal, update, { ...ctx, signal: jobSignal })),
						jobSignal,
					),
			});
			return jobResult(job);
		},
		...(definition.present === undefined ? {} : { present: presentBackground(definition.present as ToolPresenter) }),
	};
}
