import { Compile } from "typebox/compile";
import { isUsableRpcConversationIdentifier } from "../../rpc/correlation.ts";
import { RPC_COMMAND_SCHEMAS } from "../../rpc/schema/commands.ts";
import {
	type PrReviewPreparationErrorCode,
	type PrReviewPrepareRequest,
	type PrReviewPrepareResponse,
	type PrReviewPullRequest,
	type PrReviewResolveResponse,
	type PrReviewSourceRequest,
	RpcPreparePrReviewResponseSchema,
	RpcResolvePrReviewResponseSchema,
} from "../../rpc/schema/pr-review.ts";
import { isIrohRemoteWorkspaceName } from "./handshake.ts";
import { isIrohRemoteWorkingDirectory } from "./protocol.ts";
import { createIrohRemoteRpcErrorResponse, type IrohRemoteRpcErrorResponse } from "./rpc-command-filter.ts";

export type {
	PrReviewPreparationErrorCode,
	PrReviewPrepareRequest,
	PrReviewPrepareResponse,
	PrReviewPullRequest,
	PrReviewResolveResponse,
	PrReviewSourceRequest,
} from "../../rpc/schema/pr-review.ts";

export interface IrohRemotePrReviewRpcBackend {
	resolvePrReview(workspaceName: string, request: PrReviewSourceRequest): Promise<PrReviewResolveResponse>;
	/** The host must synchronously fence the grant at each effect and publication boundary. */
	preparePrReview(workspaceName: string, request: PrReviewPrepareRequest): Promise<PrReviewPrepareResponse>;
}

export class PrReviewPreparationError extends Error {
	readonly code: PrReviewPreparationErrorCode;

	constructor(code: PrReviewPreparationErrorCode, message: string = code) {
		super(message);
		this.name = "PrReviewPreparationError";
		this.code = code;
	}
}

export type IrohRemotePrReviewRpcResult =
	| { handled: false }
	| {
			handled: true;
			response:
				| (IrohRemoteRpcErrorResponse & { errorCode?: PrReviewPreparationErrorCode })
				| {
						id?: string;
						type: "response";
						command: "resolve_pr_review";
						success: true;
						data: PrReviewResolveResponse;
				  }
				| {
						id?: string;
						type: "response";
						command: "prepare_pr_review";
						success: true;
						data: PrReviewPrepareResponse;
				  };
	  };

const RESOLVE_COMMAND = Compile(RPC_COMMAND_SCHEMAS.resolve_pr_review);
const PREPARE_COMMAND = Compile(RPC_COMMAND_SCHEMAS.prepare_pr_review);
const RESOLVE_RESPONSE = Compile(RpcResolvePrReviewResponseSchema);
const PREPARE_RESPONSE = Compile(RpcPreparePrReviewResponseSchema);

/** Utility dispatch only: callers enforce stream purpose, capability and grant freshness. */
export async function handleIrohRemotePrReviewRpcCommand(
	command: Record<string, unknown>,
	options: { authorizedWorkspaceName: string; backend: IrohRemotePrReviewRpcBackend },
): Promise<IrohRemotePrReviewRpcResult> {
	if (command.type !== "resolve_pr_review" && command.type !== "prepare_pr_review") return { handled: false };
	const commandType = command.type;
	const id = typeof command.id === "string" ? command.id : undefined;
	const fail = (error: string, errorCode?: PrReviewPreparationErrorCode): IrohRemotePrReviewRpcResult => ({
		handled: true,
		response: {
			...createIrohRemoteRpcErrorResponse(id, commandType, error),
			...(errorCode === undefined ? {} : { errorCode }),
		},
	});
	if (
		!(RESOLVE_COMMAND.Check(command) || PREPARE_COMMAND.Check(command)) ||
		(command.id !== undefined && !isUsableRpcConversationIdentifier(command.id)) ||
		!isIrohRemoteWorkspaceName(command.workspaceName) ||
		(command.workingDirectory !== undefined && !isIrohRemoteWorkingDirectory(command.workingDirectory))
	) {
		return fail("invalid_request");
	}
	if (command.workspaceName !== options.authorizedWorkspaceName) return fail("session_mismatch");
	const source: PrReviewSourceRequest = {
		...(command.workingDirectory === undefined ? {} : { workingDirectory: command.workingDirectory }),
		...(command.sourceWorktreeId === undefined ? {} : { sourceWorktreeId: command.sourceWorktreeId }),
		...(command.number === undefined ? {} : { number: command.number }),
	};
	try {
		if (command.type === "resolve_pr_review") {
			const resolved = await options.backend.resolvePrReview(command.workspaceName, source);
			const data: PrReviewResolveResponse = {
				workspaceName: resolved.workspaceName,
				pullRequest: projectPullRequest(resolved.pullRequest),
			};
			if (
				!RESOLVE_RESPONSE.Check(data) ||
				data.workspaceName !== command.workspaceName ||
				(command.number !== undefined && data.pullRequest.number !== Number(command.number))
			) {
				throw new PrReviewPreparationError("review_preparation_failed");
			}
			return {
				handled: true,
				response: {
					...(id === undefined ? {} : { id }),
					type: "response",
					command: command.type,
					success: true,
					data,
				},
			};
		}
		const prepared = await options.backend.preparePrReview(command.workspaceName, {
			...source,
			sessionId: command.sessionId,
			expectedPullRequest: {
				url: command.expectedPullRequest.url,
				headRefOid: command.expectedPullRequest.headRefOid,
			},
		});
		const data: PrReviewPrepareResponse = {
			workspaceName: prepared.workspaceName,
			sessionId: prepared.sessionId,
			worktreeId: prepared.worktreeId,
			...(prepared.workingDirectory === undefined ? {} : { workingDirectory: prepared.workingDirectory }),
			pullRequest: projectPullRequest(prepared.pullRequest),
			disposition: prepared.disposition,
		};
		if (
			!PREPARE_RESPONSE.Check(data) ||
			(data.workingDirectory !== undefined && !isIrohRemoteWorkingDirectory(data.workingDirectory)) ||
			data.workspaceName !== command.workspaceName ||
			data.sessionId !== command.sessionId ||
			data.pullRequest.url !== command.expectedPullRequest.url ||
			data.pullRequest.headRefOid !== command.expectedPullRequest.headRefOid ||
			(command.number !== undefined && data.pullRequest.number !== Number(command.number))
		) {
			throw new PrReviewPreparationError("review_preparation_failed");
		}
		return {
			handled: true,
			response: {
				...(id === undefined ? {} : { id }),
				type: "response",
				command: command.type,
				success: true,
				data,
			},
		};
	} catch (error) {
		const code = error instanceof PrReviewPreparationError ? error.code : "review_preparation_failed";
		// Backend diagnostics (including git stderr and host paths) never cross this boundary.
		return fail(code, code);
	}
}

function projectPullRequest(pullRequest: PrReviewPullRequest): PrReviewPullRequest {
	return {
		provider: pullRequest.provider,
		url: pullRequest.url,
		number: pullRequest.number,
		title: pullRequest.title,
		repository: pullRequest.repository,
		headRefName: pullRequest.headRefName,
		headRefOid: pullRequest.headRefOid,
	};
}
