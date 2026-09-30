import type { Api, Model, ModelThinkingLevel } from "@hansjm10/volt-ai";
import type { ExtensionCommandContext, SettingsManager } from "@hansjm10/volt-coding-agent";

export type TargetSpec =
	| { kind: "worktree"; base?: string }
	| { kind: "commit"; rev: string }
	| { kind: "pr"; number: number };

export interface SwarmOptions {
	target: TargetSpec;
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
	/** Files whose diff sections were cut to fit the shard budget. */
	partialFiles: string[];
	diff: string;
}

export interface ReviewTarget {
	/** Original repository root. Dependency symlinks in the checkout resolve here. */
	repoRoot: string;
	/** Frozen, materialized checkout of the reviewed state; the working directory of every pass. */
	checkout: string;
	/** Commit the diff is taken against; review policies and base file contents come from it. */
	baseRev: string;
	headTree: string;
	description: string;
	stat: string;
	scope: string[];
	shards: DiffShard[];
	/** Diff section per file (possibly truncated), for cluster-scoped verifier prompts. */
	fileDiffs: Map<string, string>;
	/** Whether a single shard holds the complete diff. */
	complete: boolean;
	/** Git common directory; identifies the repository across worktrees. */
	commonDir: string;
	dispose(): Promise<void>;
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
	cancelling: boolean;
	saturated: boolean;
}

export interface SwarmSetup {
	target: ReviewTarget;
	options: SwarmOptions;
	workerModel: Model<Api>;
	verifierModel: Model<Api>;
	settingsManager: SettingsManager;
	modelRegistry: ExtensionCommandContext["modelRegistry"];
	contextFiles: Array<{ path: string; content: string }>;
	signal: AbortSignal;
	onProgress: () => void;
}
