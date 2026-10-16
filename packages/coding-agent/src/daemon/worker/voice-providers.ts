/**
 * The voice providers a conversation worker offers, by name: the providers
 * built into Volt. Test fixtures add theirs through `RunWorkerOptions`.
 */

import { CODEX_LIVE_PROVIDER_NAME, CodexLiveVoiceProvider } from "../../core/voice/codex-live/provider.ts";
import type { VoiceProvider } from "../../core/voice/provider.ts";

export function workerVoiceProviders(): ReadonlyMap<string, VoiceProvider> {
	return new Map<string, VoiceProvider>([[CODEX_LIVE_PROVIDER_NAME, new CodexLiveVoiceProvider()]]);
}
