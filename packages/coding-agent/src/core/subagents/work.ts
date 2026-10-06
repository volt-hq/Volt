/**
 * Subagents as conversation work (RFC §7): every child a conversation's
 * subagent manager starts is a `subagent` work item of that conversation,
 * recorded before the child's first prompt. Its id is the subagent id, its
 * `child` names the child conversation (and locates its log when it is
 * persisted), and a nested child's `parentWorkId` is its parent run's id in
 * the parent conversation's log.
 *
 * The kind delivers nothing (the tool that started a child returns its
 * result), is cancellable, survives a restart suspended, and resumes only
 * when a client or the model asks: a resume reopens the child's log, then
 * prompts the child to finish its task. A stop of the conversation (`abort`)
 * leaves subagents alone; a tool's own subagents end with its call. A paired
 * remote device observes subagents but may not cancel or resume their work,
 * as it could not abort or start them before work items; it still stops one
 * the ways it could, by stopping the tool call or job that waits on it or the
 * subagent's own conversation. Opening a subagent names its conversation for
 * a read-only view: the open conversation, or, once it closed, its log.
 */

import type { WorkRecord } from "@hansjm10/volt-agent-core";
import type { JsonValue } from "@hansjm10/volt-ai";
import type { WorkKind } from "@hansjm10/volt-protocol";
import type { HostedConversation } from "../host/hosted-conversation.ts";
import { WorkError, type WorkExecutor, type WorkKindDefinition } from "../work/registry.ts";

/** The work kind of a subagent. */
export const SUBAGENT_WORK_KIND = "subagent" satisfies WorkKind;

/**
 * Most subagents running at once in one conversation: a foreground call's and
 * eight background calls' concurrency, with room for clients' starts.
 */
export const SUBAGENT_MAX_ACTIVE = 48;

/** Longest task a subagent's work input keeps, in characters. */
const SUBAGENT_WORK_TASK_MAX_CHARS = 2_000;

/** What a subagent's work input holds: the agent and its task, bounded. */
export interface SubagentWorkInput {
	readonly agent: string;
	readonly task?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundTask(task: string): string {
	return task.length <= SUBAGENT_WORK_TASK_MAX_CHARS ? task : `${task.slice(0, SUBAGENT_WORK_TASK_MAX_CHARS - 1)}…`;
}

/** The work input of a subagent running `agent` on `task`. */
export function subagentWorkInput(agent: string, task: string): JsonValue {
	return { agent, task: boundTask(task) };
}

/** A subagent work item's input as the log keeps it. */
export function readSubagentWorkInput(input: JsonValue): SubagentWorkInput {
	if (!isRecord(input)) return { agent: "subagent" };
	const agent = typeof input.agent === "string" && input.agent.length > 0 ? input.agent : "subagent";
	return typeof input.task === "string" ? { agent, task: input.task } : { agent };
}

export interface SubagentWorkKindOptions {
	/** Reopen suspended work's child and return the executor that lets it finish its task. */
	resume(item: WorkRecord, signal: AbortSignal): Promise<WorkExecutor>;
	/** An open child conversation the manager started, by conversation id. */
	childConversation(id: string): HostedConversation | undefined;
}

/** The `subagent` kind of a conversation whose subagent manager is `options`. */
export function subagentWorkKind(options: SubagentWorkKindOptions): WorkKindDefinition {
	return {
		kind: SUBAGENT_WORK_KIND,
		delivery: "none",
		cancellable: true,
		// A tool's subagents end with its call; others run until cancelled or the conversation closes.
		cancelOnAbort: false,
		remote: { cancel: false, resume: false },
		maxActive: SUBAGENT_MAX_ACTIVE,
		title: (input) => {
			const { agent, task } = readSubagentWorkInput(input);
			return task === undefined ? agent : `${agent}: ${task}`;
		},
		redactInput: (input) => {
			const { agent, task } = readSubagentWorkInput(input);
			return task === undefined ? { agent } : subagentWorkInput(agent, task);
		},
		open: async (item) => {
			const id = item.child?.conversation;
			const child = id === undefined ? undefined : options.childConversation(id);
			if (child && !child.closed) return { conversation: child.id, moved: false };
			// A closed child is read from its log: a client views it read-only.
			if (id !== undefined && item.child?.ref !== undefined) return { conversation: id, moved: false };
			throw new WorkError("unavailable", `The conversation of subagent ${item.workId} was not kept`);
		},
		resume: (item, signal) => options.resume(item, signal),
	};
}
