import type { JsonValue } from "@hansjm10/volt-ai";
import { PRESENTATION_MAX_SERIALIZED_BYTES } from "@hansjm10/volt-protocol";
import type { CustomMessage } from "../../src/core/messages.ts";
import { SessionPresenters } from "../../src/core/session/presenters.ts";
import { presentCustomMessage } from "../../src/core/ui/presentation.ts";
import { PresentedMessageComponent } from "../../src/modes/interactive/components/presented-message.ts";

/** The presenters of a session double that registers no tools: the built-in tools' and host messages' presenters. */
export function builtinSessionPresenters(): SessionPresenters {
	return new SessionPresenters({ tool: () => undefined, message: () => undefined, ownsWork: () => false });
}

/** A custom message as the TUI draws it in a session without extensions. */
export function presentedMessage(message: CustomMessage<JsonValue>): PresentedMessageComponent {
	const presenters = builtinSessionPresenters();
	return new PresentedMessageComponent(message, () =>
		presentCustomMessage(
			presenters.message(message.customType),
			{
				customType: message.customType,
				content: message.content,
				...(message.details === undefined ? {} : { details: message.details }),
			},
			PRESENTATION_MAX_SERIALIZED_BYTES,
		),
	);
}
