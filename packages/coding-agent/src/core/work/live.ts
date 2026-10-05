/**
 * The live `work/<workId>` values (RFC §6.1, §7.1) of the work a registry
 * runs. A value is set when an executor attaches, so a client tells running
 * work from suspended work, and cleared when the executor detaches: the
 * `work_*` entries hold everything that lasts. Progress and output changes
 * reach the live state at most once per {@link WORK_LIVE_COALESCE_MS} per
 * item. A value larger than {@link WORK_LIVE_VALUE_MAX_BYTES} drops its
 * detail, then its steps.
 */

import {
	type LiveValue,
	type UiNode,
	WORK_CHECKPOINT_MAX_SERIALIZED_BYTES,
	type WorkProgress,
} from "@hansjm10/volt-protocol";
import { type LiveState, liveKey } from "../host/live-state.ts";
import { boundedWorkPhase } from "./phase.ts";

/** How often one item's progress reaches the live state at most. */
export const WORK_LIVE_COALESCE_MS = 100;

/** Largest live work value, as serialized JSON in UTF-8 bytes: the checkpoint bound. */
export const WORK_LIVE_VALUE_MAX_BYTES = WORK_CHECKPOINT_MAX_SERIALIZED_BYTES;

interface LiveWork {
	progress?: WorkProgress;
	detail?: UiNode;
	outputBytes: number;
	timer?: ReturnType<typeof setTimeout>;
}

/** The value of `workId` within the bound: without detail, then without steps, then without progress. */
function boundedValue(workId: string, work: LiveWork): LiveValue {
	const { progress, detail } = work;
	return boundedWorkPhase(
		{
			kind: "work" as const,
			workId,
			...(work.outputBytes > 0 ? { output: { bytes: work.outputBytes } } : {}),
			...(progress === undefined ? {} : { progress }),
			...(detail === undefined ? {} : { detail }),
		},
		WORK_LIVE_VALUE_MAX_BYTES,
	);
}

/** Publishes the live values of a registry's running work. */
export class WorkLiveFeed {
	private readonly live: () => LiveState;
	private readonly items = new Map<string, LiveWork>();
	private closed = false;

	constructor(live: () => LiveState) {
		this.live = live;
	}

	/** An executor attached to `workId`: its value appears at once. */
	attach(workId: string): void {
		if (this.closed) return;
		this.items.set(workId, { outputBytes: 0 });
		this.publish(workId);
	}

	/** Fine-grained progress; `detail` replaces the item's detail when given. */
	progress(workId: string, progress: WorkProgress, detail?: UiNode): void {
		const work = this.items.get(workId);
		if (!work) return;
		work.progress = progress;
		if (detail !== undefined) work.detail = detail;
		this.schedule(workId, work);
	}

	/** The output the item produced so far, in UTF-8 bytes. */
	output(workId: string, bytes: number): void {
		const work = this.items.get(workId);
		if (!work || work.outputBytes === bytes) return;
		work.outputBytes = bytes;
		this.schedule(workId, work);
	}

	/** The executor detached: the value is cleared, and a pending update dropped. */
	detach(workId: string): void {
		const work = this.items.get(workId);
		if (!work) return;
		if (work.timer !== undefined) clearTimeout(work.timer);
		this.items.delete(workId);
		if (this.closed) return;
		try {
			this.live().clear(liveKey("work", workId));
		} catch {
			// The live state closes with the session; nothing is left to clear.
		}
	}

	/** Stop publishing; the live state clears its values when it closes. */
	close(): void {
		this.closed = true;
		for (const work of this.items.values()) {
			if (work.timer !== undefined) clearTimeout(work.timer);
		}
		this.items.clear();
	}

	private schedule(workId: string, work: LiveWork): void {
		if (work.timer !== undefined || this.closed) return;
		work.timer = setTimeout(() => {
			work.timer = undefined;
			if (this.items.get(workId) === work) this.publish(workId);
		}, WORK_LIVE_COALESCE_MS);
		work.timer.unref?.();
	}

	private publish(workId: string): void {
		const work = this.items.get(workId);
		if (!work || this.closed) return;
		try {
			this.live().set(liveKey("work", workId), boundedValue(workId, work));
		} catch {
			// Live progress is presentation: a value the lane refuses is replaced by the next one.
		}
	}
}
