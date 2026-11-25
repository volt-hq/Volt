import { type Static, Type } from "typebox";
import { stringEnum } from "./helpers.ts";
import { RpcEpochMillisecondsSchema } from "./primitives.ts";
import { RPC_GIT_CONTEXT_OID_PATTERN } from "./wire-limits.ts";

export const RPC_PR_REVIEW_ERROR_CODES = [
	"review_preparation_failed",
	"review_preparation_stale",
	"review_preparation_conflict",
	"worktree_limit_reached",
] as const;
export type PrReviewPreparationErrorCode = (typeof RPC_PR_REVIEW_ERROR_CODES)[number];

/**
 * Why a `pull_requests` query failed, as its `query_error` message:
 * - `pull_request_list_unsupported`: the source's remote is not one a code-host provider lists pull requests for.
 * - `pull_request_list_not_authenticated`: the host's code-host credentials are missing or rejected.
 * - `pull_request_list_failed`: any other failure.
 */
export const RPC_PULL_REQUEST_LIST_ERROR_CODES = [
	"pull_request_list_unsupported",
	"pull_request_list_not_authenticated",
	"pull_request_list_failed",
] as const;
export type PullRequestListErrorCode = (typeof RPC_PULL_REQUEST_LIST_ERROR_CODES)[number];

/** Most pull requests one `pull_requests` answer carries. */
export const PULL_REQUEST_LIST_MAX_ITEMS = 50;

// JavaScript's $ also matches before a final newline; the lookahead requires actual end of input.
const workspaceName = Type.String({
	minLength: 1,
	maxLength: 255,
	pattern: "^[^\\u0000-\\u001f\\u007f]+$(?![\\s\\S])",
});
const sessionId = Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-z0-9_-]{1,128}$(?![\\s\\S])" });
const worktreeId = Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z0-9][a-z0-9._-]{0,63}$(?![\\s\\S])" });
const workingDirectory = Type.String({
	minLength: 1,
	maxLength: 4096,
	pattern:
		"^(?![A-Za-z]:)(?!.*(?:^|/)(?:\\.{1,2}|\\.[gG][iI][tT])(?:/|$))[^/\\\\\\u0000-\\u001f\\u007f]+(?:/[^/\\\\\\u0000-\\u001f\\u007f]+)*$(?![\\s\\S])",
});
// Canonical positive decimal, bounded to the provider's signed 32-bit PR number domain.
const number = Type.String({
	minLength: 1,
	maxLength: 10,
	pattern:
		"^(?:[1-9][0-9]{0,8}|1[0-9]{9}|20[0-9]{8}|21[0-3][0-9]{7}|214[0-6][0-9]{6}|2147[0-3][0-9]{5}|21474[0-7][0-9]{4}|214748[0-2][0-9]{3}|2147483[0-5][0-9]{2}|21474836[0-3][0-9]|214748364[0-7])$(?![\\s\\S])",
});
const headRefOid = Type.String({ maxLength: 64, pattern: `${RPC_GIT_CONTEXT_OID_PATTERN}(?![\\s\\S])` });
const url = Type.String({ minLength: 1, maxLength: 2048, pattern: "^https://[^\\s]+$(?![\\s\\S])" });
// Registered code-host provider id, e.g. "github".
const provider = Type.String({ minLength: 1, maxLength: 64, pattern: "^[^\\s\\x00-\\x1f\\x7f]+$(?![\\s\\S])" });
/** Non-empty display text without control characters. */
const displayText = (maxLength: number) =>
	Type.String({ minLength: 1, maxLength, pattern: "^[^\\u0000-\\u001f\\u007f]+$(?![\\s\\S])" });
const repositorySource = {
	workingDirectory: Type.Optional(workingDirectory),
	sourceWorktreeId: Type.Optional(worktreeId),
};
const sourceProperties = { ...repositorySource, number: Type.Optional(number) };
const sourceOptions = {
	additionalProperties: false,
	not: { required: ["workingDirectory", "sourceWorktreeId"] },
};

export const RpcPrReviewSourceRequestSchema = Type.Object(sourceProperties, sourceOptions);
export const RpcPrReviewExpectedPullRequestSchema = Type.Object({ url, headRefOid }, { additionalProperties: false });
export const RpcPrReviewPrepareRequestSchema = Type.Object(
	{
		...sourceProperties,
		sessionId,
		expectedPullRequest: RpcPrReviewExpectedPullRequestSchema,
	},
	sourceOptions,
);
export const RpcPrReviewPullRequestSchema = Type.Object(
	{
		provider,
		url,
		number: Type.Integer({ minimum: 1, maximum: 2147483647 }),
		title: Type.String({ maxLength: 512 }),
		repository: Type.String({ minLength: 1, maxLength: 256 }),
		headRefName: Type.String({ minLength: 1, maxLength: 1024 }),
		headRefOid,
	},
	{ additionalProperties: false },
);
export const RpcResolvePrReviewResponseSchema = Type.Object(
	{ workspaceName, pullRequest: RpcPrReviewPullRequestSchema },
	{ additionalProperties: false },
);
export const RpcPullRequestListRequestSchema = Type.Object(repositorySource, sourceOptions);
export const RpcPullRequestListItemSchema = Type.Object(
	{
		number: Type.Integer({ minimum: 1, maximum: 2147483647 }),
		title: displayText(512),
		url,
		headRefName: displayText(1024),
		isDraft: Type.Boolean(),
		/** The author's login on the code host. */
		author: Type.Optional(displayText(256)),
		updatedAt: Type.Optional(RpcEpochMillisecondsSchema),
	},
	{ additionalProperties: false },
);
export const RpcListPullRequestsResponseSchema = Type.Object(
	{
		workspaceName,
		provider,
		/** The base repository, in the display format of `pr_review`'s `pullRequest.repository`. */
		repository: Type.String({ minLength: 1, maxLength: 256 }),
		/** Newest first, as the code host orders them. */
		pullRequests: Type.Array(RpcPullRequestListItemSchema, { maxItems: PULL_REQUEST_LIST_MAX_ITEMS }),
		/** More open pull requests exist than the list carries. */
		truncated: Type.Boolean(),
	},
	{ additionalProperties: false },
);
export const RpcPreparePrReviewResponseSchema = Type.Object(
	{
		workspaceName,
		sessionId,
		worktreeId,
		workingDirectory: Type.Optional(workingDirectory),
		pullRequest: RpcPrReviewPullRequestSchema,
		disposition: stringEnum(["created", "reused"]),
	},
	{ additionalProperties: false },
);

export type PrReviewSourceRequest = Static<typeof RpcPrReviewSourceRequestSchema>;
export type PrReviewPrepareRequest = Static<typeof RpcPrReviewPrepareRequestSchema>;
export type PrReviewPullRequest = Static<typeof RpcPrReviewPullRequestSchema>;
export type PrReviewResolveResponse = Static<typeof RpcResolvePrReviewResponseSchema>;
export type PrReviewPrepareResponse = Static<typeof RpcPreparePrReviewResponseSchema>;
export type PullRequestListRequest = Static<typeof RpcPullRequestListRequestSchema>;
export type PullRequestListItem = Static<typeof RpcPullRequestListItemSchema>;
export type PullRequestListResponse = Static<typeof RpcListPullRequestsResponseSchema>;
