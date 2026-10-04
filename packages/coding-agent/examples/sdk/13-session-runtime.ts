/**
 * Session runtime
 *
 * Use AgentSessionRuntime when you need to replace the active AgentSession,
 * for example for new-session, resume, fork, or import flows.
 *
 * The important pattern is: after the runtime replaces the active session,
 * attach to `runtime.session` again: session-local subscriptions and the
 * extension client. The first client to attach to a session starts its
 * extensions (`session_start`).
 */

import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
	SessionManager,
} from "@hansjm10/volt-coding-agent";

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
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
const runtime = await createAgentSessionRuntime(createRuntime, {
	cwd: process.cwd(),
	agentDir: getAgentDir(),
	sessionManager: await SessionManager.create(process.cwd()),
});

let unsubscribe: (() => void) | undefined;

async function bindSession() {
	unsubscribe?.();
	const session = runtime.session;
	await session.attachExtensionClient({ id: "sdk-example", mode: "print" }).ready;
	unsubscribe = session.subscribe((event) => {
		if (event.type === "queue_update") {
			console.log("Queued:", event.steering.length + event.followUp.length);
		}
	});
	return session;
}

let session = await bindSession();
const originalSessionRef = session.sessionRef;
console.log("Initial session:", originalSessionRef);

await runtime.newSession();
session = await bindSession();
console.log("After newSession():", session.sessionRef);

if (originalSessionRef) {
	await runtime.switchSession(originalSessionRef);
	session = await bindSession();
	console.log("After switchSession():", session.sessionRef);
}

unsubscribe?.();
await runtime.dispose();
