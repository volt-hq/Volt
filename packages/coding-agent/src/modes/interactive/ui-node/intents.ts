/**
 * Intents from `UiNode` data in the TUI (RFC §8.3): pressing an action sends
 * its intent, and submitting a form sends the form's `submit` intent with the
 * field values merged over its `input`, keyed by field id. The TUI sends them
 * through its protocol client; a rejected or failed intent is reported, never
 * thrown into rendering or input handling.
 */

import type { UiNodeIntent } from "@hansjm10/volt-protocol";
import type { FormValues } from "@hansjm10/volt-tui";
import type { ProtocolClient } from "../../../client/protocol-client.ts";

/** Where actions and submitted forms send their intents. */
export interface UiIntentSink {
	send(intent: UiNodeIntent): void;
}

/** A form's `submit` intent with `values` merged over its input; fields without a value are left out. */
export function formSubmitIntent(submit: UiNodeIntent, values: FormValues): UiNodeIntent {
	const input: Record<string, unknown> = { ...submit.input };
	for (const [id, value] of Object.entries(values)) {
		if (value !== undefined) input[id] = value;
	}
	return { type: submit.type, input };
}

export interface ClientIntentSinkOptions {
	/** The TUI's protocol client. */
	readonly client: () => ProtocolClient;
	/** Report an intent the host rejected or that failed. */
	readonly onError: (message: string) => void;
}

/** Sends intents through the TUI's protocol client. */
export function createClientIntentSink(options: ClientIntentSinkOptions): UiIntentSink {
	const report = (error: unknown): void => options.onError(error instanceof Error ? error.message : String(error));
	return {
		send: (intent) => {
			try {
				options
					.client()
					.intent(intent.type, intent.input ?? {})
					.catch(report);
			} catch (error) {
				report(error);
			}
		},
	};
}
