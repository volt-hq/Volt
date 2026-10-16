/**
 * Voice intents (docs/daemon-voice-design.md, "Control and media planes"):
 * control only, on the ordinary conversation protocol. Media attaches on a
 * separate stream. A host without voice services has none of them
 * available; one with them reports why voice cannot start distinctly. A
 * paired device needs `voice.stream.v1` besides conversation control; the
 * voice owner hears assistant text as its own connection projects it.
 */

import type { VoiceStartOutput } from "@hansjm10/volt-protocol";
import { VoiceStartError } from "../../voice/voice-session.ts";
import { localProfile } from "../profiles.ts";
import { targetOf } from "./conversation.ts";
import {
	defineIntent,
	INTENT_ENABLED,
	type IntentAvailability,
	IntentRejectedError,
	type IntentView,
} from "./types.ts";

const voiceControl = ["conversation.control.v1", "voice.stream.v1"] as const;

function voiceAvailability(view: IntentView): IntentAvailability {
	const voice = view.services.voice;
	if (!voice) return { enabled: false, code: "unavailable", reason: "Voice is not available on this host" };
	if (!view.target) return INTENT_ENABLED;
	const availability = voice.availability(view.target.conversation);
	return availability.available
		? INTENT_ENABLED
		: { enabled: false, code: "unavailable", reason: `Voice is unavailable: ${availability.reason}` };
}

function rejectStart(error: unknown): never {
	if (error instanceof VoiceStartError) {
		throw new IntentRejectedError(
			error.code === "owner_conflict" ? "conflict" : error.code === "busy" ? "busy" : "unavailable",
			error.message,
		);
	}
	throw error;
}

export const voiceStartIntent = defineIntent({
	name: "voice_start",
	label: "Start voice",
	description: "Start voice on this conversation; spoken turns are sent as your messages",
	category: "session",
	scope: "conversation",
	fence: "branch",
	remote: "safe",
	requires: voiceControl,
	whileBusy: "run",
	available: voiceAvailability,
	async run(ctx): Promise<VoiceStartOutput> {
		const { conversation, client } = targetOf(ctx);
		const voice = ctx.services.voice;
		if (!voice) throw new IntentRejectedError("unavailable", "Voice is not available on this host");
		// What the owner may hear is what its connection projects; a remote caller without one starts nothing.
		const projection = ctx.subscriber ?? (ctx.profile.name === "local" ? localProfile : undefined);
		if (!projection) throw new IntentRejectedError("unavailable", "Voice needs a connection to project for");
		ctx.assertCurrent?.();
		try {
			return voice.start(conversation, client.id, ctx.intentId, projection);
		} catch (error) {
			rejectStart(error);
		}
	},
	accept: (result) => ({ result }),
});

export const voiceStopIntent = defineIntent({
	name: "voice_stop",
	label: "Stop voice",
	description: "Stop voice on this conversation without stopping the agent",
	category: "session",
	scope: "conversation",
	fence: "none",
	remote: "safe",
	requires: voiceControl,
	whileBusy: "run",
	available: (view) =>
		view.services.voice
			? INTENT_ENABLED
			: { enabled: false, code: "unavailable", reason: "Voice is not available on this host" },
	async run(ctx, input) {
		const { conversation, client } = targetOf(ctx);
		const voice = ctx.services.voice;
		if (!voice) throw new IntentRejectedError("unavailable", "Voice is not available on this host");
		try {
			if (!(await voice.stop(conversation, client.id, input.epoch))) {
				throw new IntentRejectedError("stale", "That voice epoch is not the live one");
			}
		} catch (error) {
			rejectStart(error);
		}
	},
});

export const voiceInterruptIntent = defineIntent({
	name: "voice_interrupt",
	label: "Interrupt voice",
	description: "Stop what voice is saying; the agent keeps working",
	category: "session",
	scope: "conversation",
	fence: "none",
	remote: "safe",
	requires: voiceControl,
	whileBusy: "run",
	available: (view) =>
		view.services.voice
			? INTENT_ENABLED
			: { enabled: false, code: "unavailable", reason: "Voice is not available on this host" },
	async run(ctx, input) {
		const { conversation, client } = targetOf(ctx);
		const voice = ctx.services.voice;
		if (!voice) throw new IntentRejectedError("unavailable", "Voice is not available on this host");
		try {
			if (!voice.interrupt(conversation, client.id, input.epoch)) {
				throw new IntentRejectedError("stale", "That voice epoch is not the live one");
			}
		} catch (error) {
			rejectStart(error);
		}
	},
});
