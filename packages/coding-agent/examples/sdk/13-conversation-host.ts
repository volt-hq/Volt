/**
 * Conversation host
 *
 * A conversation serves one log for its whole life. New-session, resume,
 * fork, clone, and import open another conversation in a ConversationHost,
 * and the client that asked moves there.
 *
 * The pattern: create the host with a factory that builds each
 * conversation's session, open a conversation, and attach a client. The host
 * binds a conversation's extensions (`session_start`) when the first client
 * with a surface attaches, and attaches the client's surface again on every
 * conversation the client moves to. The client points its own session-local
 * subscriptions at the new conversation in `onMoved`.
 */

import {
	type ConversationFactory,
	ConversationHost,
	createAgentSessionFromServices,
	createAgentSessionServices,
	getAgentDir,
	type HostClient,
	type HostedConversation,
	openNewSession,
	openStoredSession,
	SessionManager,
} from "@hansjm10/volt-coding-agent";

const factory: ConversationFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
	const services = await createAgentSessionServices({ cwd });
	return {
		...(await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
		})),
		services,
		diagnostics: services.diagnostics,
	};
};

const host = new ConversationHost({ factory, agentDir: getAgentDir(), extensionMode: "print" });
const opened = await host.open({
	kind: "adopt",
	sessionManager: await SessionManager.create(process.cwd()),
	cwd: process.cwd(),
});
if (opened.cancelled) throw new Error("Session open was cancelled");

let unsubscribe: (() => void) | undefined;

function follow(conversation: HostedConversation): void {
	unsubscribe?.();
	unsubscribe = conversation.session.subscribe((event) => {
		if (event.type === "queue_update") {
			console.log("Queued:", event.steering.length + event.followUp.length);
		}
	});
}

const client: HostClient = {
	id: "sdk-example",
	// Leaving a conversation closes it.
	anchor: true,
	surface: {},
	move: { kind: "in_place", onMoved: (to) => follow(to) },
};

await host.attach(client, opened.conversation);
follow(opened.conversation);
const originalSessionRef = opened.conversation.session.sessionRef;
console.log("Initial session:", originalSessionRef);

const created = await openNewSession(host, client);
console.log("After openNewSession():", created);

if (originalSessionRef) {
	const switched = await openStoredSession(host, client, originalSessionRef);
	console.log("After openStoredSession():", switched);
}

unsubscribe?.();
await host.dispose();
