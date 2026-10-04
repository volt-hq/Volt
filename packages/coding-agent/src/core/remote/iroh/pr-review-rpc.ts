import type {
	PrReviewPreparationErrorCode,
	PrReviewPrepareRequest,
	PrReviewPrepareResponse,
	PrReviewResolveResponse,
	PrReviewSourceRequest,
} from "@hansjm10/volt-protocol";

export type {
	PrReviewPreparationErrorCode,
	PrReviewPrepareRequest,
	PrReviewPrepareResponse,
	PrReviewPullRequest,
	PrReviewResolveResponse,
	PrReviewSourceRequest,
} from "@hansjm10/volt-protocol";

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
