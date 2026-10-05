/**
 * Host actions (RFC §7.2): what the host does for the user only once a
 * client approves it, such as installing a language server. Each is
 * `host_action` work that starts awaiting approval, with an `approval` host
 * request in the conversation's live state under the work's id. The request
 * reaches only the attached clients that accept approvals (on the remote
 * profile, those granted `host.manage.v1`), and the first valid answer wins.
 * Approving it checkpoints the work running and runs its executor; denying
 * or dismissing it, its timeout, or a cancel finishes it cancelled without
 * running. With no client that accepts approvals attached nothing is asked
 * or recorded. An approval never outlives its runtime: work still awaiting
 * one when the runtime ends is interrupted on the next open.
 */

import type { WorkRecord } from "@hansjm10/volt-agent-core";
import type { JsonValue } from "@hansjm10/volt-ai";
import type { HostRequest } from "@hansjm10/volt-protocol";
import {
	type HostRequestCancelReason,
	type HostRequestOutcome,
	hostRequestTimeout,
	type LiveState,
} from "../host/live-state.ts";
import {
	type WorkContext,
	WorkError,
	type WorkExecution,
	type WorkExecutor,
	type WorkKindDefinition,
	type WorkRegistry,
} from "../work/registry.ts";

/** The approval a host action asks: an `approval` host request without its kind. */
export type HostActionRequest = Omit<Extract<HostRequest, { kind: "approval" }>, "kind">;

/** How a host action ended. */
export type HostActionOutcome =
	/** No attached client accepts approvals, or no more actions fit: nothing was asked. */
	| { readonly status: "unavailable"; readonly message?: string }
	/** Denied, dismissed, timed out, or cancelled before it ran. */
	| { readonly status: "declined"; readonly message?: string }
	/** Approved and run: what its executor returned. */
	| { readonly status: "ran"; readonly execution: WorkExecution };

/** Runs host actions as a conversation's `host_action` work. */
export interface HostActions {
	/**
	 * Ask the attached clients to approve `request`, then run `execute` as
	 * the action. Resolves once the action's work finished; `signal` cancels it.
	 */
	run(
		request: HostActionRequest,
		execute: WorkExecutor,
		options?: { signal?: AbortSignal },
	): Promise<HostActionOutcome>;
}

/** Most host actions awaiting approval or running at once in a conversation. */
export const HOST_ACTIONS_MAX_ACTIVE = 4;

const CANCELLED = "Host action cancelled";
const DECLINED_MESSAGES: Record<Exclude<HostRequestCancelReason, "unavailable">, string> = {
	aborted: CANCELLED,
	timeout: "Host action timed out",
	closed: "The conversation closed",
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `host_action` work kind: approved before it runs, cancellable, and never resumed. */
export const HOST_ACTION_WORK_KIND: WorkKindDefinition = {
	kind: "host_action",
	// The action's result returns to what started it.
	delivery: "none",
	cancellable: true,
	// Aborting a run stops the turn, not an action the user approved.
	cancelOnAbort: false,
	// Cancelling an action answers for the host, as approving it does.
	requires: ["host.manage.v1"],
	approval: true,
	maxActive: HOST_ACTIONS_MAX_ACTIVE,
	title: (input) => (isRecord(input) && typeof input.title === "string" ? input.title : "Host action"),
};

/** What the log keeps of a host action: the approval's action, title, command, and metadata. */
function actionInput(request: HostActionRequest): JsonValue {
	return {
		action: request.action,
		title: request.title,
		...(request.commandPreview === undefined ? {} : { commandPreview: request.commandPreview }),
		...(request.metadata === undefined ? {} : { metadata: request.metadata }),
	};
}

export interface SessionHostActionsHost {
	/** The conversation's live state, where approvals wait. */
	readonly liveState: LiveState;
	/** The conversation's work registry: host actions are its `host_action` work. */
	work(): WorkRegistry;
}

export class SessionHostActions implements HostActions {
	private readonly host: SessionHostActionsHost;

	constructor(host: SessionHostActionsHost) {
		this.host = host;
	}

	async run(
		request: HostActionRequest,
		execute: WorkExecutor,
		options: { signal?: AbortSignal } = {},
	): Promise<HostActionOutcome> {
		const { liveState } = this.host;
		const work = this.host.work();
		if (options.signal?.aborted) return { status: "declined", message: CANCELLED };
		if (!liveState.accepts("approval")) return { status: "unavailable" };
		const ran = Promise.withResolvers<WorkExecution>();
		const executor = async (ctx: WorkContext): Promise<WorkExecution> => {
			try {
				const execution = await execute(ctx);
				ran.resolve(execution);
				return execution;
			} catch (error) {
				ran.resolve({
					outcome: ctx.signal.aborted ? "cancelled" : "failed",
					error: errorMessage(error),
				});
				throw error;
			}
		};
		let record: WorkRecord;
		try {
			record = await work.start("host_action", actionInput(request), executor);
		} catch (error) {
			// Too many actions pending, or the conversation closed: nothing was asked.
			if (error instanceof WorkError && (error.code === "limit" || error.code === "closed")) {
				return { status: "unavailable", message: error.message };
			}
			throw error;
		}
		const { workId } = record;
		const signals = [work.signal(workId), options.signal].filter((signal) => signal !== undefined);
		const { timeoutMs, ...approval } = request;
		let outcome: HostRequestOutcome;
		try {
			outcome = await liveState.request(
				{ kind: "approval", ...approval, ...hostRequestTimeout(timeoutMs) },
				{ id: workId, ...(signals.length === 0 ? {} : { signal: AbortSignal.any(signals) }) },
			);
		} catch (error) {
			await this.stop(work, workId);
			throw error;
		}
		if (outcome.status === "cancelled") {
			await this.stop(work, workId);
			return outcome.reason === "unavailable"
				? { status: "unavailable" }
				: { status: "declined", message: DECLINED_MESSAGES[outcome.reason] };
		}
		const response = outcome.response;
		if (!("decision" in response) || response.decision !== "approved") {
			await this.stop(work, workId);
			return {
				status: "declined",
				...("decision" in response && response.message !== undefined ? { message: response.message } : {}),
			};
		}
		try {
			await work.approve(workId);
		} catch (error) {
			// Cancelled meanwhile, or the approval could not be recorded: it never runs.
			await this.stop(work, workId);
			return { status: "declined", message: error instanceof WorkError ? CANCELLED : errorMessage(error) };
		}
		const execution = await ran.promise;
		await work.settled(workId);
		return { status: "ran", execution };
	}

	/** Finish an action that will not run; one already finishing or finished is left as it is. */
	private async stop(work: WorkRegistry, workId: string): Promise<void> {
		await work.cancel(workId).catch(() => undefined);
		await work.settled(workId);
	}
}
