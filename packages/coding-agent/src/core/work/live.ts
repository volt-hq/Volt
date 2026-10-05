/**
 * The live `work/<workId>` values (RFC §6.1, §7.1) of the work a registry
 * runs. A value is set when an executor attaches, so a client tells running
 * work from suspended work, and cleared when the executor detaches: the
 * `work_*` entries hold everything that lasts. Progress, output, and detail
 * changes reach the live state at most once per {@link WORK_LIVE_COALESCE_MS}
 * per item. An item's detail is what its executor reports, or else what its
 * kind presents from the item; a value whose detail alone changed is sent as
 * a patch of it when that is smaller. A value larger than
 * {@link WORK_LIVE_VALUE_MAX_BYTES} drops its detail, then its steps.
 */

import {
	diffUiTree,
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

/** Presents an item's detail from its latest progress; reads the item's record and output itself. */
export type WorkDetailSource = (progress: WorkProgress | undefined) => UiNode | undefined;

interface LiveWork {
	progress?: WorkProgress;
	/** The detail the executor reported, which replaces the presented one. */
	detail?: UiNode;
	readonly present?: WorkDetailSource;
	outputBytes: number;
	timer?: ReturnType<typeof setTimeout>;
	/** The value last published. */
	published?: LiveValue;
}

function serializedBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

/** The value of `workId` within the bound: without detail, then without steps, then without progress. */
function boundedValue(workId: string, work: LiveWork): LiveValue {
	const { progress } = work;
	const detail = work.detail ?? work.present?.(progress);
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

/** `value` without its detail, serialized: what a patch of the detail leaves unchanged. */
function withoutDetail(value: LiveValue): string {
	if (value.kind !== "work") return JSON.stringify(value);
	const { detail: _detail, ...rest } = value;
	return JSON.stringify(rest);
}

/** Publishes the live values of a registry's running work. */
export class WorkLiveFeed {
	private readonly live: () => LiveState;
	private readonly items = new Map<string, LiveWork>();
	private closed = false;

	constructor(live: () => LiveState) {
		this.live = live;
	}

	/** An executor attached to `workId`: its value appears at once. `present` presents its detail. */
	attach(workId: string, present?: WorkDetailSource): void {
		if (this.closed) return;
		this.items.set(workId, { outputBytes: 0, ...(present === undefined ? {} : { present }) });
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

	/** The output the item produced so far, in UTF-8 bytes; an item whose kind presents its detail is presented again. */
	output(workId: string, bytes: number): void {
		const work = this.items.get(workId);
		if (!work || (work.outputBytes === bytes && work.present === undefined)) return;
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
		const key = liveKey("work", workId);
		const value = boundedValue(workId, work);
		const published = work.published;
		try {
			const live = this.live();
			if (
				published?.kind === "work" &&
				value.kind === "work" &&
				live.get(key) === published &&
				withoutDetail(published) === withoutDetail(value)
			) {
				const ops = diffUiTree(
					published.detail === undefined ? [] : [published.detail],
					value.detail === undefined ? [] : [value.detail],
				);
				if (ops.length === 0) return;
				if (serializedBytes(ops) < serializedBytes(value)) {
					live.patch(key, ops);
					work.published = live.get(key);
					return;
				}
			}
			live.set(key, value);
			work.published = live.get(key);
		} catch {
			// Live progress is presentation: a value the lane refuses is replaced by the next one.
		}
	}
}
