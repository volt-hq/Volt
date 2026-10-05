/**
 * Bounded review target metadata for clients: a pull request's display
 * metadata without its private body, and the changed-file inventory projected
 * within its item and byte budgets.
 */

import { Buffer } from "node:buffer";
import type { ReviewChangedFile, ReviewPullRequestIdentity, ReviewSnapshotIdentity } from "./review-snapshot.ts";

interface ReviewPullRequestReference {
	provider: string;
	number: number;
}

export interface ReviewPullRequestMetadata extends ReviewPullRequestReference {
	title: string;
	url: string;
	baseRefName: string;
	headRefName: string;
	headRefOid: string;
	author?: { login: string; avatarUrl?: string };
	reviewState?: NonNullable<ReviewPullRequestIdentity["reviewState"]>;
	mergeability?: NonNullable<ReviewPullRequestIdentity["mergeability"]>;
	checks?: NonNullable<ReviewPullRequestIdentity["checks"]>;
	observedAt?: number;
}

export interface ReviewChangedFileMetadata {
	path: string;
	previousPath?: string;
	status: ReviewChangedFile["status"];
	additions: number;
	deletions: number;
}

export interface ReviewFileMetadata {
	totalCount: number;
	projectedCount: number;
	omittedCount: number;
	additions: number;
	deletions: number;
	isComplete: boolean;
	items: ReviewChangedFileMetadata[];
}

export interface ReviewFileSummarySource {
	totalCount: number;
	additions: number;
	deletions: number;
	inventoryComplete: boolean;
}

export interface ReviewFileMetadataSource {
	path: string;
	previousPath?: string;
	status?: ReviewChangedFile["status"];
	additions?: number;
	deletions?: number;
}

const REVIEW_PULL_REQUEST_PROVIDER_MAX_UTF8_BYTES = 64;
const REVIEW_PULL_REQUEST_NUMBER_MAX = 2_147_483_647;
const REVIEW_PULL_REQUEST_TITLE_MAX_UTF8_BYTES = 512;
const REVIEW_PULL_REQUEST_URL_MAX_UTF8_BYTES = 2_000;
const REVIEW_PULL_REQUEST_REF_MAX_UTF8_BYTES = 1_024;
const REVIEW_PULL_REQUEST_AUTHOR_MAX_UTF8_BYTES = 256;
const REVIEW_FILE_PATH_MAX_UTF8_BYTES = 4_096;
const REVIEW_FILE_METADATA_MAX_ITEMS = 200;
const REVIEW_FILE_METADATA_MAX_UTF8_BYTES = 64 * 1024;
const REVIEW_FILE_STATUSES: ReadonlySet<ReviewChangedFile["status"]> = new Set([
	"added",
	"modified",
	"deleted",
	"renamed",
	"copied",
	"type-changed",
]);

function boundedUtf8(value: string, maximumBytes: number): string {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length <= maximumBytes) return value;
	const suffix = "…";
	let end = maximumBytes - Buffer.byteLength(suffix, "utf8");
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return `${bytes.subarray(0, end).toString("utf8")}${suffix}`;
}

function reviewPullRequestReference(
	pullRequest: Pick<ReviewPullRequestIdentity, "providerId" | "number"> | undefined,
): ReviewPullRequestReference | undefined {
	if (!pullRequest) return undefined;
	const provider = pullRequest.providerId;
	if (
		provider.length === 0 ||
		provider !== provider.trim() ||
		Buffer.byteLength(provider, "utf8") > REVIEW_PULL_REQUEST_PROVIDER_MAX_UTF8_BYTES ||
		/[\u0000-\u001f\u007f]/u.test(provider) ||
		!Number.isSafeInteger(pullRequest.number) ||
		pullRequest.number < 1 ||
		pullRequest.number > REVIEW_PULL_REQUEST_NUMBER_MAX
	) {
		return undefined;
	}
	return { provider, number: pullRequest.number };
}

function containsControls(value: string): boolean {
	return /[\u0000-\u001f\u007f]/u.test(value);
}

function boundedWebUrl(value: string, maximumBytes: number): string | undefined {
	if (Buffer.byteLength(value, "utf8") > maximumBytes) return undefined;
	try {
		const url = new URL(value);
		return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
	} catch {
		return undefined;
	}
}

function boundedAvatarUrl(value: string | undefined, pullRequestUrl: string): string | undefined {
	if (!value || Buffer.byteLength(value, "utf8") > REVIEW_PULL_REQUEST_URL_MAX_UTF8_BYTES) return undefined;
	try {
		const avatar = new URL(value);
		const pullRequest = new URL(pullRequestUrl);
		if (avatar.protocol !== "https:") return undefined;
		if (avatar.hostname !== pullRequest.hostname && avatar.hostname !== "avatars.githubusercontent.com")
			return undefined;
		return avatar.toString();
	} catch {
		return undefined;
	}
}

function validCheckSummary(checks: ReviewPullRequestIdentity["checks"]): boolean {
	if (!checks || !["passing", "pending", "failing", "none", "unknown"].includes(checks.state)) return false;
	const counts = [
		checks.totalCount,
		checks.passedCount,
		checks.pendingCount,
		checks.failedCount,
		checks.neutralCount,
		checks.unknownCount,
	];
	return (
		counts.every((count) => Number.isSafeInteger(count) && count >= 0) &&
		checks.totalCount === counts.slice(1).reduce((total, count) => total + count, 0)
	);
}

export function createReviewPullRequestMetadata(
	identity: Pick<ReviewSnapshotIdentity, "pullRequest"> | undefined,
): ReviewPullRequestMetadata | undefined {
	const pullRequest = identity?.pullRequest;
	const reference = reviewPullRequestReference(pullRequest);
	if (!pullRequest || !reference) return undefined;
	const url = boundedWebUrl(pullRequest.url, REVIEW_PULL_REQUEST_URL_MAX_UTF8_BYTES);
	if (
		!url ||
		!pullRequest.title.trim() ||
		containsControls(pullRequest.title) ||
		!pullRequest.baseRefName.trim() ||
		containsControls(pullRequest.baseRefName) ||
		!pullRequest.headRefName.trim() ||
		containsControls(pullRequest.headRefName) ||
		!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(pullRequest.headRefOid)
	) {
		return undefined;
	}
	const observedAt = pullRequest.observedAt;
	const avatarUrl = boundedAvatarUrl(pullRequest.author?.avatarUrl, url);
	const authorLogin = pullRequest.author?.login.trim();
	const reviewState = ["draft", "ready", "merged", "closed"].includes(pullRequest.reviewState ?? "")
		? pullRequest.reviewState
		: undefined;
	const mergeability = ["mergeable", "conflicting", "unknown"].includes(pullRequest.mergeability ?? "")
		? pullRequest.mergeability
		: undefined;
	return {
		...reference,
		title: boundedUtf8(pullRequest.title.trim(), REVIEW_PULL_REQUEST_TITLE_MAX_UTF8_BYTES),
		url,
		baseRefName: boundedUtf8(pullRequest.baseRefName, REVIEW_PULL_REQUEST_REF_MAX_UTF8_BYTES),
		headRefName: boundedUtf8(pullRequest.headRefName, REVIEW_PULL_REQUEST_REF_MAX_UTF8_BYTES),
		headRefOid: pullRequest.headRefOid,
		...(authorLogin && !containsControls(authorLogin) && !/\s/u.test(authorLogin)
			? {
					author: {
						login: boundedUtf8(authorLogin, REVIEW_PULL_REQUEST_AUTHOR_MAX_UTF8_BYTES),
						...(avatarUrl ? { avatarUrl } : {}),
					},
				}
			: {}),
		...(reviewState ? { reviewState } : {}),
		...(mergeability ? { mergeability } : {}),
		...(validCheckSummary(pullRequest.checks) ? { checks: { ...pullRequest.checks! } } : {}),
		...(observedAt !== undefined && Number.isSafeInteger(observedAt) && observedAt >= 0 ? { observedAt } : {}),
	};
}

export function createReviewFileMetadata(
	files: readonly ReviewFileMetadataSource[],
	summary?: ReviewFileSummarySource,
	includeItems = true,
): ReviewFileMetadata {
	let sourceComplete = summary?.inventoryComplete ?? true;
	const inferredAdditions = files.reduce((total, file) => total + (file.additions ?? 0), 0);
	const inferredDeletions = files.reduce((total, file) => total + (file.deletions ?? 0), 0);
	if (files.some((file) => file.additions === undefined || file.deletions === undefined)) sourceComplete = false;
	const validInferredAdditions = Number.isSafeInteger(inferredAdditions) && inferredAdditions >= 0;
	const validInferredDeletions = Number.isSafeInteger(inferredDeletions) && inferredDeletions >= 0;
	const validSummaryTotal =
		summary !== undefined && Number.isSafeInteger(summary.totalCount) && summary.totalCount >= files.length;
	const validSummaryAdditions =
		summary !== undefined && Number.isSafeInteger(summary.additions) && summary.additions >= 0;
	const validSummaryDeletions =
		summary !== undefined && Number.isSafeInteger(summary.deletions) && summary.deletions >= 0;
	if (
		summary &&
		(!validSummaryTotal ||
			!validSummaryAdditions ||
			!validSummaryDeletions ||
			(summary.inventoryComplete && summary.totalCount !== files.length))
	) {
		sourceComplete = false;
	}
	if (!validInferredAdditions || !validInferredDeletions) sourceComplete = false;
	const totalCount = validSummaryTotal ? summary.totalCount : files.length;
	const additions = validSummaryAdditions ? summary.additions : validInferredAdditions ? inferredAdditions : 0;
	const deletions = validSummaryDeletions ? summary.deletions : validInferredDeletions ? inferredDeletions : 0;
	const items: ReviewChangedFileMetadata[] = [];
	let retainedBytes = 2;
	if (includeItems) {
		for (const file of files) {
			if (items.length >= REVIEW_FILE_METADATA_MAX_ITEMS) break;
			if (
				!file.path ||
				containsControls(file.path) ||
				Buffer.byteLength(file.path, "utf8") > REVIEW_FILE_PATH_MAX_UTF8_BYTES ||
				(file.previousPath !== undefined &&
					(!file.previousPath ||
						containsControls(file.previousPath) ||
						Buffer.byteLength(file.previousPath, "utf8") > REVIEW_FILE_PATH_MAX_UTF8_BYTES)) ||
				!file.status ||
				!REVIEW_FILE_STATUSES.has(file.status) ||
				typeof file.additions !== "number" ||
				!Number.isSafeInteger(file.additions) ||
				file.additions < 0 ||
				typeof file.deletions !== "number" ||
				!Number.isSafeInteger(file.deletions) ||
				file.deletions < 0
			) {
				sourceComplete = false;
				break;
			}
			const item: ReviewChangedFileMetadata = {
				path: file.path,
				...(file.previousPath ? { previousPath: file.previousPath } : {}),
				status: file.status,
				additions: file.additions,
				deletions: file.deletions,
			};
			const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8") + (items.length === 0 ? 0 : 1);
			if (retainedBytes + itemBytes > REVIEW_FILE_METADATA_MAX_UTF8_BYTES) break;
			items.push(item);
			retainedBytes += itemBytes;
		}
	}
	const projectedCount = items.length;
	const omittedCount = Math.max(0, totalCount - projectedCount);
	return {
		totalCount,
		projectedCount,
		omittedCount,
		additions,
		deletions,
		isComplete: sourceComplete && omittedCount === 0,
		items,
	};
}
