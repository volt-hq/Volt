import { type IrohRemoteOutboundSanitizerOptions, sanitizeIrohRemoteOutbound } from "./outbound-filter.ts";

export const IROH_REMOTE_TRANSCRIPT_TEXT_MAX_SCALARS = 12_000;

export type IrohRemoteTranscriptTextLayout = "preserve" | "summary";

export interface IrohRemoteSanitizedTranscriptText {
	text: string;
	truncated: boolean;
}

export function sanitizeIrohRemoteTranscriptText(
	value: string,
	options: IrohRemoteOutboundSanitizerOptions,
	layout: IrohRemoteTranscriptTextLayout = "preserve",
	maxScalars: number = IROH_REMOTE_TRANSCRIPT_TEXT_MAX_SCALARS,
): IrohRemoteSanitizedTranscriptText {
	const normalized = normalizeIrohRemoteTranscriptText(value, layout);
	const sanitizedValue = sanitizeIrohRemoteOutbound({ value: normalized }, options) as { value?: unknown };
	const sanitized = sanitizedValue.value;
	const text = normalizeIrohRemoteTranscriptText(typeof sanitized === "string" ? sanitized : "", layout);
	const scalars = Array.from(text);
	if (scalars.length <= maxScalars) {
		return { text, truncated: false };
	}
	return {
		text: scalars.slice(0, maxScalars).join(""),
		truncated: true,
	};
}

function normalizeIrohRemoteTranscriptText(value: string, layout: IrohRemoteTranscriptTextLayout): string {
	const normalized = value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
	return layout === "summary"
		? normalized
				.replace(/[\n\t]/g, " ")
				.replace(/\s+/gu, " ")
				.trim()
		: normalized;
}
