import type {
	PrReviewPreparationErrorCode,
	PrReviewPrepareRequest,
	PrReviewPrepareResponse,
	PrReviewResolveResponse,
	PrReviewSourceRequest,
	PullRequestListErrorCode,
	PullRequestListRequest,
	PullRequestListResponse,
} from "@hansjm10/volt-protocol";

export type {
	PrReviewPreparationErrorCode,
	PrReviewPrepareRequest,
	PrReviewPrepareResponse,
	PrReviewPullRequest,
	PrReviewResolveResponse,
	PrReviewSourceRequest,
	PullRequestListErrorCode,
	PullRequestListItem,
	PullRequestListRequest,
	PullRequestListResponse,
} from "@hansjm10/volt-protocol";

export interface IrohRemotePrReviewRpcBackend {
	resolvePrReview(workspaceName: string, request: PrReviewSourceRequest): Promise<PrReviewResolveResponse>;
	/** The source repository's open pull requests, to choose one to review; failures throw {@link PullRequestListError}. */
	listPullRequests(workspaceName: string, request: PullRequestListRequest): Promise<PullRequestListResponse>;
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

/** A failed pull request listing, by the stable code a device sees. */
export class PullRequestListError extends Error {
	readonly code: PullRequestListErrorCode;

	constructor(code: PullRequestListErrorCode = "pull_request_list_failed") {
		super(code);
		this.name = "PullRequestListError";
		this.code = code;
	}
}
