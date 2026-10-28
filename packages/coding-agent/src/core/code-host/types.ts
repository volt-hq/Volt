export type ReviewCodeHostContextLimitationCode =
	| "api-error"
	| "invalid-api-response"
	| "text-limit"
	| "linked-issue-limit"
	| "discussion-limit"
	| "aggregate-limit";

export interface ReviewCodeHostContextLimitation {
	code: ReviewCodeHostContextLimitationCode;
	source: string;
	count: number;
}

export type ReviewPullRequestReviewState = "draft" | "ready" | "merged" | "closed";
export type ReviewPullRequestMergeability = "mergeable" | "conflicting" | "unknown";
export type ReviewPullRequestCheckState = "passing" | "pending" | "failing" | "none" | "unknown";

export interface ReviewPullRequestAuthor {
	login: string;
	avatarUrl?: string;
}

export interface ReviewPullRequestCheckSummary {
	state: ReviewPullRequestCheckState;
	totalCount: number;
	passedCount: number;
	pendingCount: number;
	failedCount: number;
	neutralCount: number;
	unknownCount: number;
}

export interface ReviewPullRequestIdentity {
	providerId: string;
	number: number;
	title: string;
	body: string;
	url: string;
	baseRefName: string;
	headRefName: string;
	baseRefOid: string;
	headRefOid: string;
	author?: ReviewPullRequestAuthor;
	reviewState?: ReviewPullRequestReviewState;
	mergeability?: ReviewPullRequestMergeability;
	checks?: ReviewPullRequestCheckSummary;
	/** Host epoch milliseconds when mutable pull-request health was observed. */
	observedAt?: number;
}

export interface ReviewCodeHostActor {
	login: string;
	type: string;
}

export interface ReviewCodeHostLinkedIssue {
	id: string;
	repository: string;
	number: number;
	title: string;
	body: string;
	url: string;
	state: string;
	stateReason?: string;
	relationship: "closing" | "manual" | "unknown";
	author?: ReviewCodeHostActor;
	createdAt?: string;
	updatedAt?: string;
}

export interface ReviewCodeHostDiscussionEntry {
	id: string;
	kind: "pr-comment" | "review-summary" | "review-thread-comment" | "linked-issue-comment";
	body: string;
	url?: string;
	author?: ReviewCodeHostActor;
	authorAssociation?: string;
	createdAt?: string;
	updatedAt?: string;
	state?: string;
	commitOid?: string;
	issue?: { repository: string; number: number };
	thread?: {
		id: string;
		isResolved: boolean;
		isOutdated: boolean;
		path?: string;
		line?: number;
		startLine?: number;
		originalLine?: number;
		originalStartLine?: number;
		diffSide?: string;
	};
	diffHunk?: string;
	isMinimized?: boolean;
	minimizedReason?: string;
	replyToId?: string;
}

export interface ReviewCodeHostContextManifest {
	status: "complete" | "incomplete";
	capturedAt: string;
	linkedIssueCount: number;
	discussionEntryCount: number;
	renderedLinkedIssueCount: number;
	renderedDiscussionEntryCount: number;
	renderedBytes: number;
	limitations: ReviewCodeHostContextLimitation[];
	fingerprint: string;
}

export interface ReviewCodeHostContext {
	manifest: ReviewCodeHostContextManifest;
	linkedIssues: ReviewCodeHostLinkedIssue[];
	discussionEntries: ReviewCodeHostDiscussionEntry[];
	rendered: string;
}

export type ReviewCodeHostContextCaptureResult =
	| {
			ok: true;
			pullRequest: ReviewPullRequestIdentity;
			context: ReviewCodeHostContext;
			fetchPlan: PullRequestFetchPlan;
	  }
	| { ok: false; error: string; remoteError?: string };

/** A pull request's identity and fetch plan, captured without its linked issues and discussion. */
export type ReviewCodeHostIdentityCaptureResult =
	| {
			ok: true;
			pullRequest: ReviewPullRequestIdentity;
			fetchPlan: PullRequestFetchPlan;
			context?: undefined;
	  }
	| { ok: false; error: string; remoteError?: string };

export interface ReviewCodeHostContextCaptureOptions {
	cwd: string;
	number?: string;
	/** Selected PR identity to verify against workspace resolution, never a repository override. */
	expectedUrl?: string;
	maxPullRequestNumber: number;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
}

export interface CodeHostPullRequestSummary {
	number: number;
	title: string;
	url: string;
}

/** Host-only normalized repository identity. Never project canonicalId to clients. */
export interface CanonicalCodeHostRepository {
	providerId: string;
	host: string;
	/** Provider-defined `/`-separated repository path under `host`, normalized for comparison (GitHub: `owner/name`). */
	path: string;
	canonicalId: string;
}

/** Host-only checkout identity and validated base repository transport; never project transport to clients. */
export interface ResolvedPullRequestCheckout {
	pullRequest: {
		/** Registered code-host provider id. */
		provider: string;
		url: string;
		number: number;
		title: string;
		repository: string;
		headRefName: string;
		headRefOid: string;
	};
	repository: CanonicalCodeHostRepository;
	headRepository: CanonicalCodeHostRepository;
	remote: string;
	remoteUrl: string;
	/** Provider ref in the selected base repository that resolves to the PR head, including for fork PRs. */
	headRef: string;
}

export type ResolvePullRequestCheckoutOptions = Pick<
	ReviewCodeHostContextCaptureOptions,
	"cwd" | "number" | "expectedUrl" | "maxPullRequestNumber" | "signal"
>;

export type ResolvePullRequestCheckoutResult =
	| { ok: true; target: ResolvedPullRequestCheckout }
	| { ok: false; error: string; remoteError?: string };

export type CodeHostPullRequestStatus = "open" | "draft" | "merged" | "closed";

/** Bounded exact match retained by daemon Work association state. */
export interface CodeHostPullRequestAssociation {
	providerId: string;
	repository: CanonicalCodeHostRepository;
	headRepository: CanonicalCodeHostRepository;
	number: number;
	title: string;
	status: CodeHostPullRequestStatus;
	headBranch: string;
	matchedHeadOid: string;
}

export type CodeHostPullRequestDiscoveryUnavailableReason =
	| "unsupported_repository"
	| "repository_ambiguous"
	| "not_authenticated"
	| "rate_limited"
	| "network"
	| "timeout"
	| "output_limited"
	| "invalid_response"
	| "provider_error"
	| "cancelled";

export type CodeHostPullRequestDiscoveryOutcome =
	| { state: "resolved"; pullRequest: CodeHostPullRequestAssociation }
	| { state: "none" }
	| { state: "ambiguous" }
	| { state: "unavailable"; reason: CodeHostPullRequestDiscoveryUnavailableReason };

export interface CodeHostPullRequestDiscoveryRequest {
	cwd: string;
	branch: string;
	headOid: string;
	signal?: AbortSignal;
}

export interface CodeHostPullRequestDiscoveryProvider {
	readonly id: string;
	discoverPullRequest(request: CodeHostPullRequestDiscoveryRequest): Promise<CodeHostPullRequestDiscoveryOutcome>;
}

/** One already-associated pull request, identified by its base repository and number. */
export interface CodeHostPullRequestStatusTarget {
	/** The base repository's provider-defined path, as in `CanonicalCodeHostRepository.path`. */
	path: string;
	number: number;
}

export interface CodeHostPullRequestStatusRequest {
	/** Neutral working directory for the provider CLI; never a repository checkout. */
	cwd: string;
	host: string;
	pullRequests: readonly CodeHostPullRequestStatusTarget[];
	signal?: AbortSignal;
}

export type CodeHostPullRequestStatusOutcome =
	| { state: "resolved"; status: CodeHostPullRequestStatus; title: string }
	| { state: "unavailable"; reason: CodeHostPullRequestDiscoveryUnavailableReason };

export interface CodeHostPullRequestStatusProvider {
	readonly id: string;
	/** Returns exactly one outcome per requested pull request, in request order. */
	refreshPullRequestStatuses(request: CodeHostPullRequestStatusRequest): Promise<CodeHostPullRequestStatusOutcome[]>;
}

export interface PullRequestFetchRef {
	remoteRef: string;
	localRef: string;
}

/** Ephemeral host-only transport selected during capture, never persisted in review identity. */
export interface PullRequestFetchPlan {
	/** Selected remote name, used to preserve its scoped Git transport settings. */
	remote: string;
	/** Validated fetch URL with Git URL rewrites already applied. */
	remoteUrl: string;
	base: PullRequestFetchRef;
	head: PullRequestFetchRef;
	diffCommand: string;
}

export interface ReviewCodeHostInlineComment {
	/** The finding the comment posts, unique within its review. */
	findingId: string;
	path: string;
	side: "base" | "head";
	startLine: number;
	endLine: number;
	body: string;
}

/** How a code host's CLI is run for one operation. */
export interface CodeHostCommandOptions {
	/** The command that runs the code host's CLI in place of its default, such as `["volt-agent", "gh"]`. */
	command?: readonly string[];
}

export interface ReviewCodeHostPublishRequest extends CodeHostCommandOptions {
	cwd: string;
	/** The published review run: a provider that posts a review in parts recognizes the parts it already posted by it. */
	runId: string;
	pullRequest: ReviewPullRequestIdentity;
	body: string;
	comments: ReviewCodeHostInlineComment[];
}

export interface ReviewCodeHostPublishResult {
	reviewId?: number;
	url?: string;
}

/** Pure identity rules for persisted pull request data; must not load provider CLIs or transports. */
export interface CodeHostIdentity {
	readonly id: string;
	readonly displayName: string;
	/** Hosts trusted to serve pull request author avatars in addition to the pull request host. */
	readonly avatarHosts?: readonly string[];
	/** The pull request a web URL of this provider names, with the URL normalized; undefined for any other URL. */
	parsePullRequestUrl(url: string): { url: string; number: number } | undefined;
	/** Host-only consistency check for a persisted checkout identity this provider produced. */
	isCanonicalPullRequestCheckout(
		pullRequest: ResolvedPullRequestCheckout["pullRequest"],
		repositoryId: string,
		headRepositoryId: string,
	): boolean;
}

export interface CodeHostProvider extends CodeHostIdentity {
	/** Parse a credential-free remote URL this provider serves; null selects another provider. */
	canonicalizeRemoteUrl(url: string): CanonicalCodeHostRepository | null;
	probeCurrentPullRequest(cwd: string, signal?: AbortSignal): Promise<CodeHostPullRequestSummary | undefined>;
	resolvePullRequestCheckout(options: ResolvePullRequestCheckoutOptions): Promise<ResolvePullRequestCheckoutResult>;
	capturePullRequestContext(options: ReviewCodeHostContextCaptureOptions): Promise<ReviewCodeHostContextCaptureResult>;
	/**
	 * The pull request's identity and fetch plan only: no linked issues, comments, reviews, or threads are read,
	 * so a snapshot of it carries no code-host context. For a review engine that never reads that text.
	 */
	capturePullRequestIdentity(
		options: ReviewCodeHostContextCaptureOptions,
	): Promise<ReviewCodeHostIdentityCaptureResult>;
	verifyPullRequestHead(
		cwd: string,
		pullRequest: ReviewPullRequestIdentity,
		options?: CodeHostCommandOptions,
	): Promise<void>;
	publishPullRequestReview(request: ReviewCodeHostPublishRequest): Promise<ReviewCodeHostPublishResult>;
	/** Daemon change association; report unsupported_repository when no remote belongs to this provider. */
	discoverPullRequest?(request: CodeHostPullRequestDiscoveryRequest): Promise<CodeHostPullRequestDiscoveryOutcome>;
	/** Daemon change status refresh for pull requests this provider associated. */
	refreshPullRequestStatuses?(request: CodeHostPullRequestStatusRequest): Promise<CodeHostPullRequestStatusOutcome[]>;
}
