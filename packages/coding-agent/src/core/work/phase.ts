/**
 * Bounds of a work phase: the progress and detail a checkpoint or a live
 * `work/<workId>` value carries. The host bounds what it writes and
 * publishes; a profile that redacts host paths bounds what it sends again,
 * since redaction can lengthen text.
 */

import { type UiNode, WORK_TEXT_MAX_CHARS, type WorkProgress } from "@hansjm10/volt-protocol";

interface WorkPhase {
	readonly progress?: WorkProgress;
	readonly detail?: UiNode;
}

function serializedBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

/** `text` within {@link WORK_TEXT_MAX_CHARS} UTF-16 code units, an ellipsis marking a cut. */
function boundText(text: string): string {
	if (text.length <= WORK_TEXT_MAX_CHARS) return text;
	let end = WORK_TEXT_MAX_CHARS - 1;
	const last = text.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) end--;
	return `${text.slice(0, end)}…`;
}

/**
 * `value` within `maxBytes` serialized: whole, then without its detail, then
 * without its progress's steps, then without its progress.
 */
export function boundedWorkPhase<T extends WorkPhase>(value: T, maxBytes: number): T {
	if (serializedBytes(value) <= maxBytes) return value;
	const { detail: _detail, ...detailless } = value;
	if (serializedBytes(detailless) <= maxBytes) return detailless as T;
	const { progress, ...progressless } = detailless;
	if (progress !== undefined) {
		const { steps: _steps, ...stepless } = progress;
		const withoutSteps = { ...progressless, progress: stepless };
		if (serializedBytes(withoutSteps) <= maxBytes) return withoutSteps as T;
	}
	return progressless as T;
}

/**
 * `value` (a checkpoint payload or a live work value) as a profile that
 * redacts sends it: `redact` redacts it; its progress text and step labels,
 * which the host may have cut to their bound, go through `cut`, which also
 * drops the start of a root a cut left; text that redaction lengthened is
 * bounded again, and the whole value to `maxBytes`.
 */
export function redactedWorkPhase<T extends WorkPhase>(
	value: T,
	redact: <V>(value: V) => V,
	cut: (text: string) => string,
	maxBytes: number,
): T {
	const { progress, ...rest } = value;
	const redacted = redact(rest);
	if (progress === undefined) return boundedWorkPhase(redacted as T, maxBytes);
	const { text, steps, ...numbers } = progress;
	const kept: WorkProgress = {
		...numbers,
		...(text === undefined ? {} : { text: boundText(cut(text)) }),
		...(steps === undefined
			? {}
			: {
					steps: steps.map((step) => ({
						key: redact(step.key),
						label: boundText(cut(step.label)),
						status: step.status,
					})),
				}),
	};
	return boundedWorkPhase({ ...redacted, progress: kept } as T, maxBytes);
}
