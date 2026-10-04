/**
 * The invoking client: the client an asynchronous chain runs for. A mode runs
 * each request of a client inside that client's scope, so the extension
 * actions the request reaches (command context actions, abort, shutdown) go to
 * that client instead of the conversation's anchor.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const invokingClient = new AsyncLocalStorage<string>();

export const ClientScope = {
	/** Run `operation` for the client `clientId`; work it starts keeps the scope. */
	run<T>(clientId: string, operation: () => T): T {
		return invokingClient.run(clientId, operation);
	},

	/** Run `operation` outside any client scope: work it starts belongs to no client. */
	exit<T>(operation: () => T): T {
		return invokingClient.exit(operation);
	},

	/** The id of the client the current asynchronous chain runs for, if any. */
	current(): string | undefined {
		return invokingClient.getStore();
	},
};
