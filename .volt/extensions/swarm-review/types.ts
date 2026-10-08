import type { Api, Model, ModelThinkingLevel } from "@hansjm10/volt-ai";
import type { ModelRegistry, ReviewEngineContext, SettingsManager } from "@hansjm10/volt-coding-agent";

export interface SwarmOptions {
	/** The review's path scope: where the host limits the change to. */
	scope: string[];
	/** Maximum total workers across all waves. */
	workers: number;
	waveSize: number;
	/** Concurrent workers within a wave. */
	concurrency: number;
	model?: string;
	thinking: ModelThinkingLevel;
	verifier?: string;
	verifierThinking: ModelThinkingLevel;
	/** Concurrent verifier sessions (each cluster uses two). */
	verifierConcurrency: number;
	exec: boolean;
	fresh: boolean;
	/** Seconds; undefined derives the grace from finished workers' durations. */
	stragglerGrace?: number;
	focus?: string;
}

export interface DiffShard {
	index: number;
	files: string[];
	/** The hunks of those files this shard holds, in order. Their diff text is delivered to a worker when it starts. */
	hunkIds: string[];
	/** Files with a hunk too large for any shard to hold whole: its diff text is not delivered, so reviewers page it. */
	partialFiles: string[];
}

export interface ReviewTarget {
	/** Original repository root. Dependency symlinks in the checkout resolve here. */
	repoRoot: string;
	/** Frozen, materialized checkout of the reviewed state; the working directory of every pass. */
	checkout: string;
	description: string;
	stat: string;
	scope: string[];
	shards: DiffShard[];
	/** The hunks of each reviewable changed file in scope, for cluster-scoped verifier prompts. */
	fileHunks: Map<string, string[]>;
	/** Each hunk's patch size in bytes, to budget what a prompt carries. */
	hunkBytes: Map<string, number>;
	/** Whether a single shard holds the whole change. */
	complete: boolean;
	/** Whether the diff changes submodule gitlinks, whose contents reviewers cannot inspect. */
	submodules: boolean;
	/** Git common directory; identifies the repository across worktrees. */
	commonDir: string;
	/** A file as it was before the change, from the host's snapshot; undefined when it did not exist or is not text. */
	readBase(path: string, signal: AbortSignal): Promise<string | undefined>;
	/** Materializes another private checkout of the reviewed state, with dependencies linked; the caller removes it. */
	createCheckout(): Promise<string>;
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export type PassStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface PassState {
	status: PassStatus;
	toolCalls: number;
	turns: number;
	error?: string;
	usage: UsageTotals;
	startedAt?: number;
	finishedAt?: number;
}

export interface Candidate {
	id: string;
	worker: number;
	wave: number;
	title: string;
	file: string;
	line: number;
	endLine?: number;
	priority: number;
	confidence: number;
	trigger: string;
	impact: string;
	evidence: string;
}

export interface WorkerState extends PassState {
	index: number;
	wave: number;
	shard: number;
	candidates: Candidate[];
	dropped: number;
}

export interface VerifiedFinding {
	title: string;
	file: string;
	line: number;
	endLine?: number;
	priority: number;
	explanation: string;
	fix?: string;
}

export interface Verdict {
	verdict: "confirmed" | "rejected" | "uncertain";
	reason: string;
	findings: VerifiedFinding[];
}

export type ClusterOutcome =
	| "pending"
	| "confirmed"
	| "rejected"
	| "uncertain"
	| "disputed"
	| "single"
	| "unverified"
	| "suppressed";

export interface Cluster {
	id: string;
	title: string;
	candidates: Candidate[];
	/** Wave that created the cluster. */
	wave: number;
	verifiers: PassState[];
	verdicts: Array<Verdict | undefined>;
	outcome: ClusterOutcome;
	/** Remembered dismissal that suppressed this cluster. */
	suppressedBy?: { title: string; reason: string };
}

export interface WaveSummary {
	wave: number;
	workers: number;
	candidates: number;
	newClusters: number;
	clusteringFallback: boolean;
	/** Every worker in the wave failed; the run stopped. */
	failed?: boolean;
}

export interface SwarmState {
	workers: WorkerState[];
	clusters: Cluster[];
	waves: WaveSummary[];
	phase: "workers" | "clustering" | "verifying" | "done";
	currentWave: number;
	/** One clustering pass per wave. */
	clusterPasses: PassState[];
	nextCandidate: number;
	/** Commands verifiers ran (--exec), one line each, and the ones that failed. */
	commands: string[];
	failedCommands: string[];
	cancelling: boolean;
	saturated: boolean;
}

export interface SwarmSetup {
	/** The host's review: passes whose reads the host counts, and the validation findings must pass. */
	engine: ReviewEngineContext;
	target: ReviewTarget;
	options: SwarmOptions;
	workerModel: Model<Api>;
	verifierModel: Model<Api>;
	settingsManager: SettingsManager;
	modelRegistry: ModelRegistry;
	contextFiles: Array<{ path: string; content: string }>;
	signal: AbortSignal;
	onProgress: () => void;
}
