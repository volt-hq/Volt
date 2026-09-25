import { Type } from "typebox";
import { Compile } from "typebox/compile";
import type { ResolvedPullRequestCheckout } from "./code-host/types.ts";

/** Host-owned placement. Never accept this object from a client or imported transcript. */
export interface PrReviewPlacement {
	workspaceName: string;
	workspaceGeneration: number;
	worktreeId: string;
	cwd: string;
	sourceCwd: string;
	sourceRootRelativePath?: string;
	commonDirectory: string;
	pullRequest: ResolvedPullRequestCheckout["pullRequest"];
	repositoryId: string;
	headRepositoryId: string;
	remote: string;
}

/** Worktree-local retry identity; bounded independently of ordinary session bindings. */
export interface PrReviewLaunch {
	sessionId: string;
	requestFingerprint: string;
	placement: PrReviewPlacement;
	disposition: "created" | "reused";
	sessionGeneration?: string;
	storeId?: string;
}

const text = Type.String({ minLength: 1, maxLength: 4096, pattern: "^[^\\u0000-\\u001f\\u007f]+$" });
export const PrReviewPlacementSchema = Type.Object(
	{
		workspaceName: text,
		workspaceGeneration: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
		worktreeId: Type.String({ pattern: "^[a-z0-9][a-z0-9._-]{0,63}$" }),
		cwd: text,
		sourceCwd: text,
		sourceRootRelativePath: Type.Optional(text),
		commonDirectory: text,
		pullRequest: Type.Object(
			{
				provider: Type.Literal("github"),
				url: Type.String({ minLength: 1, maxLength: 2000 }),
				number: Type.Integer({ minimum: 1, maximum: 2147483647 }),
				title: text,
				repository: text,
				headRefName: text,
				headRefOid: Type.String({ pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$" }),
			},
			{ additionalProperties: false },
		),
		repositoryId: text,
		headRepositoryId: text,
		remote: text,
	},
	{ additionalProperties: false },
);

const launchValidator = Compile(
	Type.Object(
		{
			sessionId: Type.String({ pattern: "^[a-z0-9_-]{1,128}$" }),
			requestFingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }),
			placement: PrReviewPlacementSchema,
			disposition: Type.Union([Type.Literal("created"), Type.Literal("reused")]),
			sessionGeneration: Type.Optional(text),
			storeId: Type.Optional(text),
		},
		{ additionalProperties: false },
	),
);

export function parsePrReviewLaunches(value: unknown): PrReviewLaunch[] {
	if (!Array.isArray(value) || value.length > 64 || !value.every((entry) => launchValidator.Check(entry))) {
		throw new Error("Invalid PR review worktree launch metadata");
	}
	const launches = value as PrReviewLaunch[];
	if (
		new Set(launches.map((entry) => entry.sessionId)).size !== launches.length ||
		launches.some((entry) => (entry.sessionGeneration === undefined) !== (entry.storeId === undefined))
	) {
		throw new Error("Conflicting PR review launch identities");
	}
	return structuredClone(launches);
}
