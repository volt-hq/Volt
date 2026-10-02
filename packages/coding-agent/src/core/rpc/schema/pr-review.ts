import { type Static, Type } from "typebox";
import { RPC_CONVERSATION_IDENTIFIER_MAX_UTF8_BYTES, RPC_GIT_CONTEXT_OID_PATTERN } from "../wire-limits.ts";
import { stringEnum } from "./helpers.ts";
import { RpcConversationIdentifierSchema } from "./primitives.ts";

export const RPC_PR_REVIEW_ERROR_CODES = [
	"review_preparation_failed",
	"review_preparation_stale",
	"review_preparation_conflict",
	"worktree_limit_reached",
] as const;
export type PrReviewPreparationErrorCode = (typeof RPC_PR_REVIEW_ERROR_CODES)[number];

const correlationId = Type.String({
	...RpcConversationIdentifierSchema,
	maxLength: RPC_CONVERSATION_IDENTIFIER_MAX_UTF8_BYTES,
});
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
const sourceProperties = {
	workingDirectory: Type.Optional(workingDirectory),
	sourceWorktreeId: Type.Optional(worktreeId),
	number: Type.Optional(number),
};
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
export const RpcResolvePrReviewCommandSchema = Type.Object(
	{
		id: Type.Optional(correlationId),
		type: Type.Literal("resolve_pr_review"),
		workspaceName,
		...sourceProperties,
	},
	sourceOptions,
);
export const RpcPreparePrReviewCommandSchema = Type.Object(
	{
		id: Type.Optional(correlationId),
		type: Type.Literal("prepare_pr_review"),
		workspaceName,
		...RpcPrReviewPrepareRequestSchema.properties,
	},
	sourceOptions,
);

export const RpcPrReviewPullRequestSchema = Type.Object(
	{
		provider: Type.Literal("github"),
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
