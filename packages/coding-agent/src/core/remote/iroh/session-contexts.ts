import { type RpcGitContext, type RpcSessionChangeContext, RpcSessionContextSchema } from "@hansjm10/volt-protocol";
import { Compile } from "typebox/compile";
import { SessionManager } from "../../session-manager.ts";

export interface IrohRemoteSessionContext {
	sessionId: string;
	startingGitContext: RpcGitContext | null;
	changeContext: RpcSessionChangeContext | null;
}

export interface IrohRemoteSessionContextsRpcBackend {
	getSessionContexts(workspaceName: string, sessionIds: readonly string[]): Promise<IrohRemoteSessionContext[]>;
}

export function createIrohRemoteSessionContextsRpcBackend(options: {
	workspaceName: string;
	sessionDirectory: string;
	getChangeContext(sessionId: string): RpcSessionChangeContext | undefined;
}): IrohRemoteSessionContextsRpcBackend {
	return {
		getSessionContexts: async (workspaceName, sessionIds) => {
			if (workspaceName !== options.workspaceName) {
				throw new Error("Session context workspace mismatch");
			}
			// The host of a conversation records its starting Git context in its log.
			const startingContexts = await SessionManager.readStartingGitContexts(options.sessionDirectory, [
				...sessionIds,
			]);
			return sessionIds.map((sessionId) => ({
				sessionId,
				startingGitContext: startingContexts.get(sessionId) ?? null,
				changeContext: options.getChangeContext(sessionId) ?? null,
			}));
		},
	};
}

const SESSION_CONTEXT_VALIDATOR = Compile(RpcSessionContextSchema);

/** Whether `contexts` answer `sessionIds`, one valid context per id, in order. */
export function isIrohRemoteSessionContextsAnswer(
	sessionIds: readonly string[],
	contexts: readonly IrohRemoteSessionContext[],
): boolean {
	return (
		contexts.length === sessionIds.length &&
		contexts.every(
			(context, index) => context.sessionId === sessionIds[index] && SESSION_CONTEXT_VALIDATOR.Check(context),
		)
	);
}
