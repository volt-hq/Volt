/**
 * The TUI's work source over a session's own work, for tests that inspect a
 * harness session's work as the TUI does: through the work intents and the
 * `work_output` query of a conversation over the session.
 */

import type { AgentSession } from "../../src/core/agent-session.ts";
import type { ConversationHost } from "../../src/core/host/conversation-host.ts";
import type { HostClient } from "../../src/core/host/targets.ts";
import { LOCAL_INTENT_PROFILE } from "../../src/core/protocol/intents/index.ts";
import { TuiWorkSource } from "../../src/modes/interactive/work-source.ts";
import { createFakeConversation } from "./fake-conversation-host.ts";

export function createSessionWorkSource(session: AgentSession): TuiWorkSource {
	const { conversation } = createFakeConversation(session);
	const source = new TuiWorkSource({
		conversation: () => conversation,
		intentContext: () => ({
			target: { session, conversation, host: {} as ConversationHost, client: {} as HostClient },
			services: {},
			profile: LOCAL_INTENT_PROFILE,
		}),
	});
	source.bind(conversation);
	return source;
}
