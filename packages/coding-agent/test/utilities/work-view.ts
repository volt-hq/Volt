/**
 * The TUI's view of a harness session's work, for tests that inspect it as
 * the TUI does: the session hosted in a conversation host, a protocol client
 * over loopback with the TUI's store following it, and the work of its
 * client fold and live fold. Actions and reads go through the work intents
 * and queries.
 */

import { createLoopbackClient } from "../../src/client/protocol-client.ts";
import type { AgentSession } from "../../src/core/agent-session.ts";
import type { AgentSessionServices } from "../../src/core/agent-session-services.ts";
import { TuiStore } from "../../src/modes/interactive/client/tui-store.ts";
import { ConversationWork } from "../../src/modes/interactive/client/work-view.ts";
import { adoptTestSession } from "./host-client.ts";

export interface SessionWorkView {
	readonly work: ConversationWork;
	readonly store: TuiStore;
	/** Stop the client; the session stays open. */
	dispose(): Promise<void>;
}

/** The work of `session`, whose working directory and agent directory are `dir`, as the TUI's store holds it. */
export async function createSessionWorkView(session: AgentSession, dir: string): Promise<SessionWorkView> {
	const { host, conversation } = adoptTestSession(
		session,
		{ cwd: dir, agentDir: dir } as unknown as AgentSessionServices,
		async () => {
			throw new Error("The work view opens no conversation");
		},
	);
	const client = await createLoopbackClient(host, conversation, { anchor: false });
	const store = new TuiStore();
	store.attach(client);
	const work = new ConversationWork({ client: () => client, holder: store });
	return {
		work,
		store,
		async dispose() {
			work.dispose();
			await client.stop();
		},
	};
}
