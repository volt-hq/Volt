import { describe, expect, test } from "vitest";
import { createReviewFileMetadata, createReviewPullRequestMetadata } from "../src/core/review-target-metadata.ts";

const pullRequest = {
	providerId: "github",
	number: 7,
	title: "Review target title",
	body: "PRIVATE_PULL_REQUEST_BODY",
	url: "https://example.test/pull/7",
	baseRefName: "main",
	headRefName: "feature/review",
	baseRefOid: "a".repeat(40),
	headRefOid: "b".repeat(40),
	author: { login: "review-author", avatarUrl: "https://example.test/review-author.png" },
	reviewState: "draft" as const,
	mergeability: "conflicting" as const,
	checks: {
		state: "failing" as const,
		totalCount: 2,
		passedCount: 1,
		pendingCount: 0,
		failedCount: 1,
		neutralCount: 0,
		unknownCount: 0,
	},
	observedAt: 1_782_470_399_000,
};

describe("review target metadata", () => {
	test("retains bounded pull request display and changed-file metadata without the private body", () => {
		const metadata = createReviewPullRequestMetadata({ pullRequest });
		expect(metadata).toMatchObject({
			provider: "github",
			number: 7,
			title: "Review target title",
			url: "https://example.test/pull/7",
			baseRefName: "main",
			headRefName: "feature/review",
			headRefOid: "b".repeat(40),
			author: { login: "review-author", avatarUrl: "https://example.test/review-author.png" },
			reviewState: "draft",
			mergeability: "conflicting",
			checks: { state: "failing", totalCount: 2 },
			observedAt: 1_782_470_399_000,
		});
		expect(JSON.stringify(metadata)).not.toContain("PRIVATE_PULL_REQUEST_BODY");
		expect(
			createReviewFileMetadata([{ path: "src/review.ts", status: "modified", additions: 4, deletions: 2 }]),
		).toEqual({
			totalCount: 1,
			projectedCount: 1,
			omittedCount: 0,
			additions: 4,
			deletions: 2,
			isComplete: true,
			items: [{ path: "src/review.ts", status: "modified", additions: 4, deletions: 2 }],
		});
	});

	test("rejects pull request display metadata it cannot bound", () => {
		expect(createReviewPullRequestMetadata(undefined)).toBeUndefined();
		expect(
			createReviewPullRequestMetadata({ pullRequest: { ...pullRequest, title: "Title\twith a control" } }),
		).toBeUndefined();
		expect(
			createReviewPullRequestMetadata({ pullRequest: { ...pullRequest, url: "file:///private/pull/7" } }),
		).toBeUndefined();
		expect(createReviewPullRequestMetadata({ pullRequest: { ...pullRequest, number: 0 } })).toBeUndefined();
	});

	test("reports bounded file projection completeness instead of treating omitted files as an empty change", () => {
		const files = Array.from({ length: 201 }, (_, index) => ({
			path: `src/file-${index}.ts`,
			status: "modified" as const,
			additions: 2,
			deletions: 1,
		}));
		expect(createReviewFileMetadata(files)).toMatchObject({
			totalCount: 201,
			projectedCount: 200,
			omittedCount: 1,
			additions: 402,
			deletions: 201,
			isComplete: false,
		});
		expect(
			createReviewFileMetadata([], {
				totalCount: 3,
				additions: 8,
				deletions: 5,
				inventoryComplete: false,
			}),
		).toEqual({
			totalCount: 3,
			projectedCount: 0,
			omittedCount: 3,
			additions: 8,
			deletions: 5,
			isComplete: false,
			items: [],
		});
	});
});
