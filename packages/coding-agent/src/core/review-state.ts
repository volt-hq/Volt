import { Buffer } from "node:buffer";
import { EXTENSION_WORK_KIND_PATTERN, type ReviewUsageAccounting } from "@hansjm10/volt-protocol";
import { minimatch } from "minimatch";
import type { ReviewRunControls } from "./review.ts";
import { ReviewSourceUnavailableError, resolveCanonicalReviewSource } from "./review-links.ts";
import { createReviewAccountingMessage } from "./review-presentation.ts";
import {
	type ParsedReview,
	REVIEW_FOLLOW_UPS_MAX,
	type ReviewFinding,
	type ReviewFindingOutcomeReason,
	type ReviewFindingStatus,
	type ReviewPriorFindingDecision,
	settleReviewVerdict,
} from "./review-report.ts";
import type {
	ReviewBranchBase,
	ReviewChangedFile,
	ReviewSnapshot,
	ReviewSnapshotIdentity,
	ReviewSnapshotTreeEntry,
} from "./review-snapshot.ts";
import { parseReviewUsage } from "./review-usage.ts";
import { type CustomEntry, type SessionEntry, SessionManager } from "./session-manager.ts";
import type { SessionWriter } from "./session-writer.ts";

export const REVIEW_RUN_CUSTOM_ENTRY_TYPE = "volt.review.run";
export const REVIEW_ACKNOWLEDGMENT_CUSTOM_ENTRY_TYPE = "volt.review.acknowledgment";
export const REVIEW_FINDING_TRANSITION_CUSTOM_ENTRY_TYPE = "volt.review.finding-transition";
export const REVIEW_PUBLICATION_CUSTOM_ENTRY_TYPE = "volt.review.publication";
export const REVIEW_STATE_SCHEMA_VERSION = 1;
export const MAX_REVIEW_STATE_RECORD_BYTES = 512 * 1024;
export const MAX_HYDRATED_REVIEW_RUNS = 32;
export const MAX_REVIEW_INVENTORY_FILES = 5_000;
const MAX_REVIEW_INVENTORY_BYTES = 64 * 1024;
const MAX_PERSISTED_COVERAGE_ITEMS = 500;
const MAX_COMPACT_COVERAGE_ITEMS = 10;
const MAX_REVIEW_FOCUS_BYTES = 4_000;
const MAX_REVIEW_SCOPE_PATTERNS = 50;
const MAX_REVIEW_SCOPE_PATTERN_BYTES = 500;

export type ReviewRunStatus = "completed" | "incomplete" | "failed" | "cancelled";

/** The engine of the built-in review pipeline. A run of it records no engine. */
export const STANDARD_REVIEW_ENGINE = "standard";

/** What clients call the built-in pipeline. */
export const STANDARD_REVIEW_ENGINE_LABEL = "Standard";

/** An extension's engine is named like its work kinds: `ext:<extension id>/<engine name>`. */
const EXTENSION_REVIEW_ENGINE_PATTERN = new RegExp(EXTENSION_WORK_KIND_PATTERN);

/** Whether `value` names an extension's review engine. */
export function isExtensionReviewEngine(value: unknown): value is string {
	return typeof value === "string" && EXTENSION_REVIEW_ENGINE_PATTERN.test(value);
}

/** The engine that produced `run`: `standard`, or an extension's engine. */
export function reviewRunEngine(run: Pick<ReviewRunRecord, "engine">): string {
	return run.engine ?? STANDARD_REVIEW_ENGINE;
}

/** What clients call the engine that produced `run`: its label when the run started, or the built-in pipeline's. */
export function reviewRunEngineLabel(run: Pick<ReviewRunRecord, "engineLabel">): string {
	return run.engineLabel ?? STANDARD_REVIEW_ENGINE_LABEL;
}

/** Whether `value` is an engine's label: text that is not blank. */
function isReviewEngineLabel(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

export interface ReviewRunFileIdentity {
	path: string;
	previousPath?: string;
	status?: ReviewChangedFile["status"];
	baseOid?: string;
	baseMode?: string;
	baseType?: ReviewSnapshotTreeEntry["type"];
	headOid?: string;
	headMode?: string;
	headType?: ReviewSnapshotTreeEntry["type"];
	hunkIds: string[];
	reviewable: boolean;
	additions?: number;
	deletions?: number;
}

export interface ReviewRunFileSummary {
	totalCount: number;
	additions: number;
	deletions: number;
	inventoryComplete: boolean;
}

export interface ReviewRunContextMetadata {
	captureStatus: "complete" | "incomplete";
	linkedIssueCount: number;
	discussionEntryCount: number;
	renderedLinkedIssueCount: number;
	renderedDiscussionEntryCount: number;
	renderedBytes: number;
	limitationCodes: string[];
	fingerprint: string;
}

export interface ReviewRunRecord {
	schemaVersion: 1;
	runId: string;
	workflowAction: string;
	/**
	 * The extension engine that produced the run, as the host named it when it started the run; absent for the
	 * built-in pipeline ({@link STANDARD_REVIEW_ENGINE}). Extensions cannot write run records, so a run's engine is
	 * never its own claim.
	 */
	engine?: string;
	/**
	 * The label the engine had when the host started the run, kept so clients name the engine after its extension
	 * changed or left. Present exactly when {@link engine} is.
	 */
	engineLabel?: string;
	status: ReviewRunStatus;
	startedAt: number;
	endedAt: number;
	usage?: ReviewUsageAccounting;
	target: {
		description: string;
		diffCommand: string;
		identity: ReviewSnapshotIdentity;
		branchBase?: ReviewBranchBase;
		context?: ReviewRunContextMetadata;
		fileSummary?: ReviewRunFileSummary;
		files: ReviewRunFileIdentity[];
	};
	options: ReviewRunControls;
	result?: ParsedReview;
	errorMessage?: string;
	parentRunId?: string;
	incrementalFallbackReason?: string;
}

export interface HydratedReviewRunRecord extends ReviewRunRecord {
	acknowledgedAt?: number;
}

export interface ReviewAcknowledgmentRecord {
	schemaVersion: 1;
	runId: string;
	acknowledgedAt: number;
}

export interface ReviewFindingTransitionRecord {
	schemaVersion: 1;
	runId: string;
	findingId: string;
	status: ReviewFindingStatus;
	reason?: ReviewFindingOutcomeReason;
	note?: string;
	createdAt: number;
}

export interface ReviewPublicationRecord {
	schemaVersion: 1;
	runId: string;
	reviewId?: number;
	url?: string;
	inlineFindingIds: string[];
	summaryOnlyFindingIds: string[];
	createdAt: number;
}

export interface ReviewRunPage {
	runs: HydratedReviewRunRecord[];
	nextCursor?: string;
}

export interface ReviewStateHandoffSnapshot {
	runs: ReviewRunRecord[];
	acknowledgments: ReviewAcknowledgmentRecord[];
	transitions: ReviewFindingTransitionRecord[];
}

export interface ReviewIncrementalPlan {
	mode: "incremental" | "full";
	previousRun?: ReviewRunRecord;
	changedPaths: string[];
	priorOpenFindings: ReviewFinding[];
	suppressedDismissedFingerprints: string[];
	fallbackReason?: string;
}

function serializedBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function assertRecordSize(value: unknown): void {
	const size = serializedBytes(value);
	if (size > MAX_REVIEW_STATE_RECORD_BYTES) {
		throw new Error(`Review state record is ${size} bytes; the maximum is ${MAX_REVIEW_STATE_RECORD_BYTES}.`);
	}
}

function truncateUtf8(value: string, maximumBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
	const suffix = "…";
	let truncated = Buffer.from(value, "utf8")
		.subarray(0, maximumBytes - Buffer.byteLength(suffix, "utf8"))
		.toString("utf8");
	while (Buffer.byteLength(truncated + suffix, "utf8") > maximumBytes) truncated = truncated.slice(0, -1);
	return truncated + suffix;
}

function boundedStrings(values: readonly string[], maximumBytes: number, maximumItems: number): string[] {
	return values.slice(0, maximumItems).map((value) => truncateUtf8(value, maximumBytes));
}

function boundSnapshotIdentity(identity: ReviewSnapshotIdentity): ReviewSnapshotIdentity {
	return {
		...structuredClone(identity),
		...(identity.pullRequest
			? {
					pullRequest: {
						...identity.pullRequest,
						title: truncateUtf8(identity.pullRequest.title, 1_000),
						body: truncateUtf8(identity.pullRequest.body, 4_000),
						url: truncateUtf8(identity.pullRequest.url, 2_000),
						baseRefName: truncateUtf8(identity.pullRequest.baseRefName, 500),
						headRefName: truncateUtf8(identity.pullRequest.headRefName, 500),
						...(identity.pullRequest.author
							? {
									author: {
										login: truncateUtf8(identity.pullRequest.author.login, 256),
										...(identity.pullRequest.author.avatarUrl &&
										Buffer.byteLength(identity.pullRequest.author.avatarUrl, "utf8") <= 2_000
											? { avatarUrl: identity.pullRequest.author.avatarUrl }
											: {}),
									},
								}
							: {}),
						...(identity.pullRequest.checks ? { checks: { ...identity.pullRequest.checks } } : {}),
					},
				}
			: {}),
	};
}

export function assertReviewControlsPersistLosslessly(controls: ReviewRunControls): void {
	if (controls.focus && Buffer.byteLength(controls.focus, "utf8") > MAX_REVIEW_FOCUS_BYTES) {
		throw new Error(`Review focus must be at most ${MAX_REVIEW_FOCUS_BYTES} UTF-8 bytes.`);
	}
	if (controls.scope.length > MAX_REVIEW_SCOPE_PATTERNS) {
		throw new Error(`Review scope must contain at most ${MAX_REVIEW_SCOPE_PATTERNS} patterns.`);
	}
	if (controls.scope.some((pattern) => Buffer.byteLength(pattern, "utf8") > MAX_REVIEW_SCOPE_PATTERN_BYTES)) {
		throw new Error(`Each review scope pattern must be at most ${MAX_REVIEW_SCOPE_PATTERN_BYTES} UTF-8 bytes.`);
	}
}

function cloneControls(controls: ReviewRunControls): ReviewRunControls {
	return {
		...(controls.focus === undefined ? {} : { focus: controls.focus }),
		scope: [...controls.scope],
		effort: controls.effort,
		includeOptional: controls.includeOptional,
		scopeMode: controls.scopeMode,
	};
}

/** Bounds an already-declassified public result; private analysis reports must never reach persistence. */
function boundPublicReviewResult(result: ParsedReview, includeEvidence: boolean): ParsedReview {
	const maximumCoverageItems = includeEvidence ? MAX_PERSISTED_COVERAGE_ITEMS : MAX_COMPACT_COVERAGE_ITEMS;
	const coverageWasCompacted = [
		result.coverage.filesInspected.length,
		result.coverage.hunksInspected.length,
		result.coverage.commandsRun.length,
		result.coverage.failedVerificationAttempts.length,
		result.coverage.exclusions.length,
		result.coverage.uncheckedAreas.length,
		result.coverage.residualRisk.length,
		result.coverage.modelReportedLimitations.length,
	].some((length) => length > maximumCoverageItems);
	return {
		...structuredClone(result),
		summary: truncateUtf8(result.summary, 4_000),
		findings: result.findings.map((finding) => ({
			...structuredClone(finding),
			title: truncateUtf8(finding.title, includeEvidence ? 300 : 200),
			body: truncateUtf8(finding.body, includeEvidence ? 2_000 : 1_000),
			trigger: truncateUtf8(finding.trigger, includeEvidence ? 500 : 300),
			impact: truncateUtf8(finding.impact, includeEvidence ? 500 : 300),
			category: truncateUtf8(finding.category, 80),
			rootCauseKey: truncateUtf8(finding.rootCauseKey, includeEvidence ? 160 : 100),
			evidenceLocations: includeEvidence
				? finding.evidenceLocations.slice(0, 4).map((location) => ({ ...location }))
				: [],
			verification: {
				...finding.verification,
				method: truncateUtf8(finding.verification.method, includeEvidence ? 500 : 300),
				rationale: truncateUtf8(finding.verification.rationale, includeEvidence ? 1_000 : 500),
			},
		})),
		coverage: {
			changedFileInventoryComplete: result.coverage.changedFileInventoryComplete,
			...(result.coverage.context
				? {
						context: {
							...result.coverage.context,
							limitationCodes: boundedStrings(result.coverage.context.limitationCodes, 100, 20),
							fingerprint: truncateUtf8(result.coverage.context.fingerprint, 128),
						},
					}
				: {}),
			filesInspected: boundedStrings(result.coverage.filesInspected, 1_000, maximumCoverageItems),
			hunksInspected: boundedStrings(result.coverage.hunksInspected, 500, maximumCoverageItems),
			commandsRun: boundedStrings(result.coverage.commandsRun, 1_000, maximumCoverageItems),
			failedVerificationAttempts: boundedStrings(
				result.coverage.failedVerificationAttempts,
				1_000,
				maximumCoverageItems,
			),
			exclusions: result.coverage.exclusions.slice(0, maximumCoverageItems).map((entry) => ({
				path: truncateUtf8(entry.path, 1_000),
				reason: truncateUtf8(entry.reason, 1_000),
			})),
			uncheckedAreas: boundedStrings(result.coverage.uncheckedAreas, 1_000, maximumCoverageItems),
			residualRisk: [
				...boundedStrings(result.coverage.residualRisk, 1_000, maximumCoverageItems),
				...(coverageWasCompacted ? ["Durable coverage details were compacted to the host persistence bound."] : []),
			],
			modelReportedLimitations: boundedStrings(
				result.coverage.modelReportedLimitations,
				1_000,
				maximumCoverageItems,
			),
		},
		overallExplanation: truncateUtf8(result.overallExplanation, 4_000),
		...(result.verificationChallenge
			? { verificationChallenge: truncateUtf8(result.verificationChallenge, 4_000) }
			: {}),
		...(result.followUps
			? {
					followUps: result.followUps.slice(0, REVIEW_FOLLOW_UPS_MAX).map((followUp) => ({
						...structuredClone(followUp),
						title: truncateUtf8(followUp.title, includeEvidence ? 300 : 200),
						body: truncateUtf8(followUp.body, includeEvidence ? 2_000 : 1_000),
						category: truncateUtf8(followUp.category, 80),
						verification: {
							...followUp.verification,
							method: truncateUtf8(followUp.verification.method, includeEvidence ? 500 : 300),
							rationale: truncateUtf8(followUp.verification.rationale, includeEvidence ? 1_000 : 500),
						},
					})),
				}
			: {}),
	};
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether `value` is a timestamp clients accept: safe non-negative integer epoch milliseconds. */
function isEpochMilliseconds(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseRun(value: unknown): ReviewRunRecord | undefined {
	if (!isObject(value) || value.schemaVersion !== REVIEW_STATE_SCHEMA_VERSION) return undefined;
	if (typeof value.runId !== "string" || typeof value.workflowAction !== "string") return undefined;
	if (value.engine !== undefined && !isExtensionReviewEngine(value.engine)) return undefined;
	if (value.engine === undefined ? value.engineLabel !== undefined : !isReviewEngineLabel(value.engineLabel))
		return undefined;
	if (
		value.status !== "completed" &&
		value.status !== "incomplete" &&
		value.status !== "failed" &&
		value.status !== "cancelled"
	)
		return undefined;
	if (
		!isEpochMilliseconds(value.startedAt) ||
		!isEpochMilliseconds(value.endedAt) ||
		!isObject(value.target) ||
		!isObject(value.options)
	)
		return undefined;
	if (
		typeof value.target.description !== "string" ||
		typeof value.target.diffCommand !== "string" ||
		!isObject(value.target.identity) ||
		!Array.isArray(value.target.files)
	)
		return undefined;
	const record = structuredClone(value) as unknown as ReviewRunRecord;
	delete record.usage;
	const usage = parseReviewUsage(value.usage);
	if (usage) record.usage = usage;
	return record;
}

function parseAcknowledgment(value: unknown): ReviewAcknowledgmentRecord | undefined {
	if (!isObject(value) || value.schemaVersion !== REVIEW_STATE_SCHEMA_VERSION) return undefined;
	if (typeof value.runId !== "string" || !isEpochMilliseconds(value.acknowledgedAt)) return undefined;
	return structuredClone(value) as unknown as ReviewAcknowledgmentRecord;
}

function parseTransition(value: unknown): ReviewFindingTransitionRecord | undefined {
	if (!isObject(value) || value.schemaVersion !== REVIEW_STATE_SCHEMA_VERSION) return undefined;
	if (typeof value.runId !== "string" || typeof value.findingId !== "string" || !Number.isFinite(value.createdAt))
		return undefined;
	if (
		value.status !== "open" &&
		value.status !== "accepted" &&
		value.status !== "fixed" &&
		value.status !== "dismissed" &&
		value.status !== "uncertain"
	)
		return undefined;
	return structuredClone(value) as unknown as ReviewFindingTransitionRecord;
}

function branchCustomEntries(sessionManager: SessionManager): CustomEntry[] {
	return sessionManager.getBranch().filter((entry: SessionEntry): entry is CustomEntry => entry.type === "custom");
}

function acknowledgmentMap(entries: readonly CustomEntry[]): Map<string, ReviewAcknowledgmentRecord> {
	const acknowledgments = new Map<string, ReviewAcknowledgmentRecord>();
	for (const entry of entries) {
		if (entry.customType !== REVIEW_ACKNOWLEDGMENT_CUSTOM_ENTRY_TYPE) continue;
		const acknowledgment = parseAcknowledgment(entry.data);
		if (acknowledgment) acknowledgments.set(acknowledgment.runId, acknowledgment);
	}
	return acknowledgments;
}

function transitionMap(entries: readonly CustomEntry[]): Map<string, ReviewFindingTransitionRecord> {
	const transitions = new Map<string, ReviewFindingTransitionRecord>();
	for (const entry of entries) {
		if (entry.customType !== REVIEW_FINDING_TRANSITION_CUSTOM_ENTRY_TYPE) continue;
		const transition = parseTransition(entry.data);
		if (transition) transitions.set(`${transition.runId}\0${transition.findingId}`, transition);
	}
	return transitions;
}

function applyReviewState(
	run: ReviewRunRecord,
	acknowledgments: ReadonlyMap<string, ReviewAcknowledgmentRecord>,
	transitions: ReadonlyMap<string, ReviewFindingTransitionRecord>,
): HydratedReviewRunRecord {
	const result: HydratedReviewRunRecord = structuredClone(run);
	const acknowledgment = acknowledgments.get(run.runId);
	if (acknowledgment) result.acknowledgedAt = acknowledgment.acknowledgedAt;
	for (const finding of result.result?.findings ?? []) {
		const transition = transitions.get(`${run.runId}\0${finding.id}`);
		if (transition) finding.status = transition.status;
	}
	return result;
}

function encodeCursor(endedAt: number, runId: string): string {
	return Buffer.from(JSON.stringify({ endedAt, runId }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { endedAt: number; runId: string } {
	try {
		const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
		if (!isObject(value) || !Number.isFinite(value.endedAt) || typeof value.runId !== "string") throw new Error();
		return { endedAt: value.endedAt as number, runId: value.runId };
	} catch {
		throw new Error("Review result cursor is invalid.");
	}
}

function compareRuns(left: ReviewRunRecord, right: ReviewRunRecord): number {
	return right.endedAt - left.endedAt || right.runId.localeCompare(left.runId);
}

function hydrateRuns(entries: readonly CustomEntry[]): Map<string, ReviewRunRecord> {
	const runs = new Map<string, ReviewRunRecord>();
	for (const entry of entries) {
		if (entry.customType !== REVIEW_RUN_CUSTOM_ENTRY_TYPE) continue;
		const run = parseRun(entry.data);
		if (!run) continue;
		const previous = runs.get(run.runId);
		if (previous?.usage && run.usage && previous.usage.revision > run.usage.revision) continue;
		if (previous?.usage && !run.usage) run.usage = previous.usage;
		runs.set(run.runId, run);
	}
	return runs;
}

export function captureReviewStateForHandoff(sessionManager: SessionManager): ReviewStateHandoffSnapshot {
	const entries = branchCustomEntries(sessionManager);
	const acknowledgments = acknowledgmentMap(entries);
	const transitions = transitionMap(entries);
	const byRunId = hydrateRuns(entries);
	const runs = [...byRunId.values()].sort(compareRuns).slice(0, MAX_HYDRATED_REVIEW_RUNS);
	const retainedFindingKeys = new Set(
		runs.flatMap((run) => (run.result?.findings ?? []).map((finding) => `${run.runId}\0${finding.id}`)),
	);
	return {
		runs,
		acknowledgments: runs.flatMap((run) => {
			const acknowledgment = acknowledgments.get(run.runId);
			return acknowledgment ? [acknowledgment] : [];
		}),
		transitions: [...transitions.entries()].flatMap(([key, transition]) =>
			retainedFindingKeys.has(key) ? [transition] : [],
		),
	};
}

export async function restoreReviewStateFromHandoff(
	writer: SessionWriter,
	snapshot: ReviewStateHandoffSnapshot,
): Promise<void> {
	for (const run of snapshot.runs) await appendReviewRun(writer, run);
	for (const acknowledgment of snapshot.acknowledgments) {
		await acknowledgeReviewRun(writer, acknowledgment.runId, acknowledgment.acknowledgedAt);
	}
	for (const transition of snapshot.transitions) {
		await appendReviewFindingTransition(writer, transition);
	}
}

export function listReviewRuns(
	sessionManager: SessionManager,
	options: { cursor?: string; limit?: number; engine?: string } = {},
): ReviewRunPage {
	const limit = options.limit ?? 10;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
		throw new Error("Review result limit must be between 1 and 50.");
	const entries = branchCustomEntries(sessionManager);
	const acknowledgments = acknowledgmentMap(entries);
	const transitions = transitionMap(entries);
	const byRunId = hydrateRuns(entries);
	let runs = [...byRunId.values()].sort(compareRuns).slice(0, MAX_HYDRATED_REVIEW_RUNS);
	const { engine } = options;
	if (engine !== undefined) runs = runs.filter((run) => reviewRunEngine(run) === engine);
	if (options.cursor) {
		const cursor = decodeCursor(options.cursor);
		const index = runs.findIndex((run) => run.endedAt === cursor.endedAt && run.runId === cursor.runId);
		if (index < 0) throw new Error("Review result cursor no longer identifies a retained run.");
		runs = runs.slice(index + 1);
	}
	const selected = runs.slice(0, limit).map((run) => applyReviewState(run, acknowledgments, transitions));
	const finalRun = selected.at(-1);
	return {
		runs: selected,
		...(runs.length > selected.length && finalRun
			? { nextCursor: encodeCursor(finalRun.endedAt, finalRun.runId) }
			: {}),
	};
}

export function getReviewRun(sessionManager: SessionManager, runId: string): HydratedReviewRunRecord | undefined {
	let cursor: string | undefined;
	do {
		const page = listReviewRuns(sessionManager, { cursor, limit: 50 });
		const match = page.runs.find((run) => run.runId === runId);
		if (match) return match;
		cursor = page.nextCursor;
	} while (cursor);
	return undefined;
}

function reviewConversationGuard(manager: SessionManager): () => void {
	const sessionId = manager.getSessionId();
	const generation = manager.getSessionRef()?.sessionGeneration;
	const cwd = manager.getCwd();
	return () => {
		if (
			manager.getSessionId() !== sessionId ||
			manager.getSessionRef()?.sessionGeneration !== generation ||
			manager.getCwd() !== cwd
		)
			throw new ReviewSourceUnavailableError("The review conversation changed during lookup.");
	};
}

/** Snapshot readers above intentionally stay local for persistence replay and handoff copying. */
async function readCanonicalReviewState<T>(
	manager: SessionManager,
	runId: string,
	read: (source: SessionManager) => T,
): Promise<T> {
	const assertCurrent = reviewConversationGuard(manager);
	const ref = await resolveCanonicalReviewSource(manager, runId);
	assertCurrent();
	if (!ref) return read(manager);
	let source: SessionManager;
	try {
		source = await SessionManager.openReadOnly(ref);
	} catch (cause) {
		throw new ReviewSourceUnavailableError(undefined, { cause });
	}
	try {
		// A source reads its own runs: one it no longer holds is unknown. An alias's source must still hold it.
		const self = manager.getSessionId() === ref.sessionId;
		if (!self && !getReviewRun(source, runId))
			throw new ReviewSourceUnavailableError("The canonical review run is no longer retained.");
		const result = read(source);
		const current = await resolveCanonicalReviewSource(manager, runId);
		assertCurrent();
		if (
			current?.storeId !== ref.storeId ||
			current.sessionDirectory !== ref.sessionDirectory ||
			current.sessionId !== ref.sessionId ||
			current.sessionGeneration !== ref.sessionGeneration
		)
			throw new ReviewSourceUnavailableError();
		return result;
	} finally {
		await source.closePersistence();
		assertCurrent();
	}
}

/** Live review consumers must not use the copied finding statuses on a handoff alias. */
export async function getCanonicalReviewRun(
	manager: SessionManager,
	runId: string,
): Promise<HydratedReviewRunRecord | undefined> {
	const assertCurrent = reviewConversationGuard(manager);
	const record = await readCanonicalReviewState(manager, runId, (source) => getReviewRun(source, runId));
	assertCurrent();
	// Acknowledgment is conversation-local UI state, unlike canonical finding outcomes.
	const acknowledgedAt = getReviewRun(manager, runId)?.acknowledgedAt;
	return record && acknowledgedAt !== undefined ? { ...record, acknowledgedAt } : record;
}

export async function listCanonicalReviewRuns(
	manager: SessionManager,
	options: { cursor?: string; limit?: number; engine?: string } = {},
): Promise<ReviewRunPage> {
	const assertCurrent = reviewConversationGuard(manager);
	const page = listReviewRuns(manager, options);
	const runs: HydratedReviewRunRecord[] = [];
	for (const run of page.runs) {
		const current = await getCanonicalReviewRun(manager, run.runId);
		assertCurrent();
		if (!current) throw new ReviewSourceUnavailableError("The review run changed during listing.");
		runs.push(current);
	}
	return { ...page, runs };
}

/** Use the runtime-owned writer for canonical aliases; never open a second unfenced writer. */
export async function recordReviewFindingOutcome(
	writer: SessionWriter,
	transition: Omit<ReviewFindingTransitionRecord, "schemaVersion" | "createdAt">,
	options: {
		recordCanonicalOutcome?: (
			transition: Omit<ReviewFindingTransitionRecord, "schemaVersion" | "createdAt">,
		) => Promise<ReviewFindingTransitionRecord>;
		assertCurrent?: () => void;
	} = {},
): Promise<ReviewFindingTransitionRecord> {
	const manager = writer.sessionManager;
	const assertCurrent = reviewConversationGuard(manager);
	if (manager.getReviewDiscussion())
		throw new Error("Canonical finding outcomes belong to the source review; record the outcome there.");
	const run = await getCanonicalReviewRun(manager, transition.runId);
	if (!run?.result?.findings.some((finding) => finding.id === transition.findingId))
		throw new Error(`Unknown finding ${transition.findingId} in review run ${transition.runId}`);
	if (transition.status === "dismissed" && !transition.reason)
		throw new Error("Dismissed findings require an explicit reason.");
	assertCurrent();
	const source = await resolveCanonicalReviewSource(manager, transition.runId);
	assertCurrent();
	options.assertCurrent?.();
	if (source) {
		if (options.recordCanonicalOutcome) {
			try {
				return await options.recordCanonicalOutcome(transition);
			} catch (cause) {
				throw new ReviewSourceUnavailableError("The canonical review outcome could not be recorded.", { cause });
			}
		}
		const ref = manager.getSessionRef();
		if (ref?.sessionId !== source.sessionId || ref.sessionGeneration !== source.sessionGeneration)
			throw new ReviewSourceUnavailableError("Open the canonical source review to record this outcome.");
	}
	return appendReviewFindingTransition(writer, transition);
}

export async function appendReviewRun(writer: SessionWriter, record: ReviewRunRecord): Promise<void> {
	const persistedRecord = structuredClone(record) as HydratedReviewRunRecord;
	delete persistedRecord.acknowledgedAt;
	assertRecordSize(persistedRecord);
	await writer.appendCustomEntry(REVIEW_RUN_CUSTOM_ENTRY_TYPE, persistedRecord);
}

/**
 * Append the terminal record of a run the conversation executed, with an
 * accounting notice when it has no result. The run's `work_started` in the
 * same log anchors it.
 */
export async function appendReviewRunDurably(writer: SessionWriter, record: ReviewRunRecord): Promise<void> {
	await appendReviewRun(writer, record);
	if (!record.result) {
		const notice = createReviewAccountingMessage(record);
		await writer.appendCustomMessageEntry(notice.customType, notice.content, notice.display, notice.details);
	}
}

export async function acknowledgeReviewRun(
	writer: SessionWriter,
	runId: string,
	acknowledgedAt = Date.now(),
): Promise<ReviewAcknowledgmentRecord> {
	const run = getReviewRun(writer.sessionManager, runId);
	if (!run) throw new Error(`Unknown durable review run: ${runId}`);
	if (!isEpochMilliseconds(acknowledgedAt))
		throw new Error("Review acknowledgment timestamp must be a safe non-negative integer.");
	if (run.acknowledgedAt !== undefined) {
		return { schemaVersion: REVIEW_STATE_SCHEMA_VERSION, runId, acknowledgedAt: run.acknowledgedAt };
	}
	const record: ReviewAcknowledgmentRecord = {
		schemaVersion: REVIEW_STATE_SCHEMA_VERSION,
		runId,
		acknowledgedAt,
	};
	assertRecordSize(record);
	await writer.appendCustomEntry(REVIEW_ACKNOWLEDGMENT_CUSTOM_ENTRY_TYPE, record);
	return record;
}

export async function appendReviewFindingTransition(
	writer: SessionWriter,
	transition: Omit<ReviewFindingTransitionRecord, "schemaVersion" | "createdAt"> & { createdAt?: number },
): Promise<ReviewFindingTransitionRecord> {
	const record: ReviewFindingTransitionRecord = {
		schemaVersion: REVIEW_STATE_SCHEMA_VERSION,
		runId: transition.runId,
		findingId: transition.findingId,
		status: transition.status,
		...(transition.reason ? { reason: transition.reason } : {}),
		...(transition.note ? { note: transition.note.slice(0, 2_000) } : {}),
		createdAt: transition.createdAt ?? Date.now(),
	};
	assertRecordSize(record);
	await writer.appendCustomEntry(REVIEW_FINDING_TRANSITION_CUSTOM_ENTRY_TYPE, record);
	return record;
}

export async function appendReviewPublication(
	writer: SessionWriter,
	publication: Omit<ReviewPublicationRecord, "schemaVersion" | "createdAt"> & { createdAt?: number },
): Promise<ReviewPublicationRecord> {
	const record: ReviewPublicationRecord = {
		schemaVersion: REVIEW_STATE_SCHEMA_VERSION,
		runId: publication.runId,
		...(publication.reviewId === undefined ? {} : { reviewId: publication.reviewId }),
		...(publication.url === undefined ? {} : { url: publication.url }),
		inlineFindingIds: [...publication.inlineFindingIds],
		summaryOnlyFindingIds: [...publication.summaryOnlyFindingIds],
		createdAt: publication.createdAt ?? Date.now(),
	};
	assertRecordSize(record);
	await writer.appendCustomEntry(REVIEW_PUBLICATION_CUSTOM_ENTRY_TYPE, record);
	return record;
}

export function snapshotFileIdentities(snapshot: ReviewSnapshot): ReviewRunFileIdentity[] {
	if (snapshot.changedFiles.length > MAX_REVIEW_INVENTORY_FILES) return [];
	const files = snapshot.changedFiles.map((file) => ({
		path: file.path,
		...(file.previousPath ? { previousPath: file.previousPath } : {}),
		status: file.status,
		...(file.base ? { baseOid: file.base.oid, baseMode: file.base.mode, baseType: file.base.type } : {}),
		...(file.head ? { headOid: file.head.oid, headMode: file.head.mode, headType: file.head.type } : {}),
		hunkIds: file.hunks.map((hunk) => hunk.id),
		reviewable: file.reviewable,
		...(file.additions === undefined ? {} : { additions: file.additions }),
		...(file.deletions === undefined ? {} : { deletions: file.deletions }),
	}));
	return serializedBytes(files) <= MAX_REVIEW_INVENTORY_BYTES ? files : [];
}

function snapshotFileInventory(snapshot: ReviewSnapshot): {
	files: ReviewRunFileIdentity[];
	summary: ReviewRunFileSummary;
} {
	const files = snapshotFileIdentities(snapshot);
	const additions = snapshot.changedFiles.reduce((total, file) => total + (file.additions ?? 0), 0);
	const deletions = snapshot.changedFiles.reduce((total, file) => total + (file.deletions ?? 0), 0);
	if (!Number.isSafeInteger(additions) || !Number.isSafeInteger(deletions)) {
		throw new Error("Review changed-line totals exceed the safe integer range.");
	}
	return {
		files,
		summary: {
			totalCount: snapshot.changedFiles.length,
			additions,
			deletions,
			inventoryComplete: files.length === snapshot.changedFiles.length,
		},
	};
}

function snapshotContextMetadata(snapshot: ReviewSnapshot): ReviewRunContextMetadata | undefined {
	const manifest = snapshot.codeHostContext?.manifest;
	if (!manifest) return undefined;
	return {
		captureStatus: manifest.status,
		linkedIssueCount: manifest.linkedIssueCount,
		discussionEntryCount: manifest.discussionEntryCount,
		renderedLinkedIssueCount: manifest.renderedLinkedIssueCount,
		renderedDiscussionEntryCount: manifest.renderedDiscussionEntryCount,
		renderedBytes: manifest.renderedBytes,
		limitationCodes: [...new Set(manifest.limitations.map((limitation) => limitation.code))].sort(),
		fingerprint: manifest.fingerprint,
	};
}

export function createReviewRunRecord(options: {
	workflowId: string;
	workflowAction: string;
	/** The extension engine running the review, by id and label; none for the built-in pipeline. */
	engine?: { readonly id: string; readonly label: string };
	startedAt: number;
	endedAt?: number;
	snapshot: ReviewSnapshot;
	controls: ReviewRunControls;
	status: ReviewRunStatus;
	usage?: ReviewUsageAccounting;
	result?: ParsedReview;
	errorMessage?: string;
	incrementalPlan?: ReviewIncrementalPlan;
}): ReviewRunRecord {
	assertReviewControlsPersistLosslessly(options.controls);
	if (options.usage && !parseReviewUsage(options.usage)) throw new Error("Invalid review accounting");
	if (options.engine !== undefined && !isExtensionReviewEngine(options.engine.id)) {
		throw new Error(`Invalid review engine ${JSON.stringify(options.engine.id)}`);
	}
	if (options.engine !== undefined && !isReviewEngineLabel(options.engine.label)) {
		throw new Error(`Review engine ${options.engine.id} needs a label`);
	}
	const fileInventory = snapshotFileInventory(options.snapshot);
	const createRecord = (includeEvidence: boolean): ReviewRunRecord => ({
		schemaVersion: REVIEW_STATE_SCHEMA_VERSION,
		runId: options.workflowId,
		workflowAction: options.workflowAction,
		...(options.engine === undefined ? {} : { engine: options.engine.id, engineLabel: options.engine.label }),
		status: options.status,
		startedAt: options.startedAt,
		endedAt: options.endedAt ?? Date.now(),
		...(options.usage ? { usage: structuredClone(options.usage) } : {}),
		target: {
			description: truncateUtf8(options.snapshot.description, 4_000),
			diffCommand: truncateUtf8(options.snapshot.diffCommand, 4_000),
			identity: boundSnapshotIdentity(options.snapshot.identity),
			...(options.snapshot.branchBase ? { branchBase: structuredClone(options.snapshot.branchBase) } : {}),
			...(snapshotContextMetadata(options.snapshot) ? { context: snapshotContextMetadata(options.snapshot) } : {}),
			fileSummary: { ...fileInventory.summary },
			files: fileInventory.files.map((file) => ({ ...file, hunkIds: [...file.hunkIds] })),
		},
		options: cloneControls(options.controls),
		...(options.result ? { result: boundPublicReviewResult(options.result, includeEvidence) } : {}),
		...(options.errorMessage ? { errorMessage: truncateUtf8(options.errorMessage, 4_000) } : {}),
		...(options.incrementalPlan?.previousRun ? { parentRunId: options.incrementalPlan.previousRun.runId } : {}),
		...(options.incrementalPlan?.fallbackReason
			? { incrementalFallbackReason: truncateUtf8(options.incrementalPlan.fallbackReason, 4_000) }
			: {}),
	});
	let record = createRecord(true);
	if (serializedBytes(record) > MAX_REVIEW_STATE_RECORD_BYTES) record = createRecord(false);
	assertRecordSize(record);
	return record;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function fileIdentityChanged(previous: ReviewRunFileIdentity | undefined, current: ReviewChangedFile): boolean {
	if (!previous) return true;
	return (
		previous.previousPath !== current.previousPath ||
		previous.status !== current.status ||
		previous.baseOid !== current.base?.oid ||
		previous.baseMode !== current.base?.mode ||
		previous.baseType !== current.base?.type ||
		previous.headOid !== current.head?.oid ||
		previous.headMode !== current.head?.mode ||
		previous.headType !== current.head?.type ||
		previous.reviewable !== current.reviewable ||
		!sameStrings(
			previous.hunkIds,
			current.hunks.map((hunk) => hunk.id),
		)
	);
}

function fullReviewPlan(snapshot: ReviewSnapshot, fallbackReason?: string): ReviewIncrementalPlan {
	return {
		mode: "full",
		changedPaths: snapshot.changedFiles.map((file) => file.path),
		priorOpenFindings: [],
		suppressedDismissedFingerprints: [],
		...(fallbackReason ? { fallbackReason } : {}),
	};
}

function controlsCompatible(previous: ReviewRunControls, current: ReviewRunControls): boolean {
	return (
		previous.focus === current.focus &&
		sameStrings(previous.scope, current.scope) &&
		previous.effort === current.effort &&
		previous.includeOptional === current.includeOptional
	);
}

function pathInControlScope(path: string, controls: ReviewRunControls): boolean {
	return (
		controls.scope.length === 0 ||
		controls.scope.some((pattern) => minimatch(path, pattern, { dot: true, matchBase: false }))
	);
}

/** What an incremental plan builds on: the prior run to continue (the newest run of `engine` unless `parentRunId` names one). */
interface IncrementalReviewOptions {
	parentRunId?: string;
	/** The engine reviewing now: another engine's runs are never a prior run. The built-in pipeline by default. */
	engine?: string;
}

export function planIncrementalReview(
	sessionManager: SessionManager | undefined,
	snapshot: ReviewSnapshot,
	controls: ReviewRunControls,
	options: IncrementalReviewOptions = {},
): ReviewIncrementalPlan {
	if (controls.scopeMode === "full" || !sessionManager) return fullReviewPlan(snapshot);
	const engine = options.engine ?? STANDARD_REVIEW_ENGINE;
	const previousRun = options.parentRunId
		? getReviewRun(sessionManager, options.parentRunId)
		: listReviewRuns(sessionManager, { limit: 1, engine }).runs[0];
	return planReviewFromPreviousRun(previousRun, snapshot, controls, { ...options, engine });
}

export async function planCanonicalIncrementalReview(
	sessionManager: SessionManager | undefined,
	snapshot: ReviewSnapshot,
	controls: ReviewRunControls,
	options: IncrementalReviewOptions = {},
): Promise<ReviewIncrementalPlan> {
	if (controls.scopeMode === "full" || !sessionManager) return fullReviewPlan(snapshot);
	const engine = options.engine ?? STANDARD_REVIEW_ENGINE;
	const previousRun = options.parentRunId
		? await getCanonicalReviewRun(sessionManager, options.parentRunId)
		: (await listCanonicalReviewRuns(sessionManager, { limit: 1, engine })).runs[0];
	return planReviewFromPreviousRun(previousRun, snapshot, controls, { ...options, engine });
}

function planReviewFromPreviousRun(
	previousRun: ReviewRunRecord | undefined,
	snapshot: ReviewSnapshot,
	controls: ReviewRunControls,
	options: IncrementalReviewOptions & { engine: string },
): ReviewIncrementalPlan {
	if (previousRun && reviewRunEngine(previousRun) !== options.engine) {
		return fullReviewPlan(snapshot, "The prior review came from another review engine.");
	}
	if (!previousRun) {
		return fullReviewPlan(
			snapshot,
			options.parentRunId
				? `The requested parent review does not exist: ${options.parentRunId}.`
				: "No compatible prior completed review exists.",
		);
	}
	if (
		previousRun.status !== "completed" ||
		previousRun.result?.completionStatus !== "complete" ||
		!previousRun.result.coverage.changedFileInventoryComplete
	) {
		return fullReviewPlan(snapshot, "The prior review did not complete with a verified changed-file inventory.");
	}
	if (
		previousRun.target.identity.kind !== snapshot.identity.kind ||
		previousRun.target.identity.baseTree !== snapshot.identity.baseTree
	) {
		return fullReviewPlan(snapshot, "The prior review target or base tree is incompatible.");
	}
	const previousContextFingerprint = previousRun.target.context?.fingerprint;
	const currentContextFingerprint = snapshot.codeHostContext?.manifest.fingerprint;
	if (previousContextFingerprint !== currentContextFingerprint) {
		return fullReviewPlan(snapshot, "The pull request code-host context changed since the prior review.");
	}
	if (!controlsCompatible(previousRun.options, controls)) {
		return fullReviewPlan(snapshot, "The prior review controls are incompatible with this run.");
	}
	if (
		previousRun.target.fileSummary?.inventoryComplete === false ||
		(previousRun.target.files.length === 0 && snapshot.changedFiles.length > 0)
	) {
		return fullReviewPlan(snapshot, "The prior changed-file inventory exceeded its persistence bound.");
	}
	const priorFiles = new Map(previousRun.target.files.map((file) => [file.path, file]));
	const priorRenameAliases = new Map<string, Set<string>>();
	for (const file of previousRun.target.files) {
		if (file.status !== "renamed" || !file.previousPath) continue;
		const sourceAliases = priorRenameAliases.get(file.previousPath);
		if (sourceAliases) sourceAliases.add(file.path);
		else priorRenameAliases.set(file.previousPath, new Set([file.path]));
		const destinationAliases = priorRenameAliases.get(file.path);
		if (destinationAliases) destinationAliases.add(file.previousPath);
		else priorRenameAliases.set(file.path, new Set([file.previousPath]));
	}
	const changedPaths: string[] = [];
	const changedFindingPaths = new Set<string>();
	const inspectedFiles = new Set(previousRun.result.coverage.filesInspected);
	const inspectedHunks = new Set(previousRun.result.coverage.hunksInspected);
	const excludedPaths = new Set(previousRun.result.coverage.exclusions.map((entry) => entry.path));
	const uncoveredUnchangedPaths: string[] = [];
	for (const file of snapshot.changedFiles) {
		const priorFile = priorFiles.get(file.path);
		if (fileIdentityChanged(priorFile, file)) {
			changedPaths.push(file.path);
			const pendingFindingPaths = [
				file.path,
				...(file.status === "renamed" && file.previousPath ? [file.previousPath] : []),
			];
			for (let index = 0; index < pendingFindingPaths.length; index++) {
				const path = pendingFindingPaths[index];
				if (!path || changedFindingPaths.has(path)) continue;
				changedFindingPaths.add(path);
				const aliases = priorRenameAliases.get(path);
				if (aliases) pendingFindingPaths.push(...aliases);
			}
			continue;
		}
		if (!pathInControlScope(file.path, controls)) continue;
		if (
			!file.reviewable ||
			excludedPaths.has(file.path) ||
			!inspectedFiles.has(file.path) ||
			file.hunks.some((hunk) => !inspectedHunks.has(hunk.id))
		) {
			uncoveredUnchangedPaths.push(file.path);
		}
	}
	if (uncoveredUnchangedPaths.length > 0) {
		return fullReviewPlan(
			snapshot,
			`The prior review lacks verified coverage for unchanged paths: ${uncoveredUnchangedPaths.join(", ")}.`,
		);
	}
	const priorOpenFindings = previousRun.result.findings.filter(
		(finding) =>
			finding.status !== "fixed" &&
			finding.status !== "dismissed" &&
			!changedFindingPaths.has(finding.changeLocation.path),
	);
	const suppressedDismissedFingerprints = previousRun.result.findings
		.filter((finding) => finding.status === "dismissed")
		.map((finding) => finding.fingerprint);
	return { mode: "incremental", previousRun, changedPaths, priorOpenFindings, suppressedDismissedFingerprints };
}

/**
 * The plan of a full review that follows `previousRun`, an earlier review of the same target: it reviews every
 * changed path, and its verifier decides each finding `previousRun` left open. Findings dismissed in `previousRun`,
 * or in the runs it followed (`dismissedEarlier`, see {@link dismissedFingerprintsOfFollowedRuns}), are not reported
 * again.
 */
export function followUpReviewPlan(
	previousRun: ReviewRunRecord,
	snapshot: ReviewSnapshot,
	dismissedEarlier: readonly string[],
): ReviewIncrementalPlan {
	const findings = previousRun.result?.findings ?? [];
	const dismissed = findings.filter((finding) => finding.status === "dismissed").map((finding) => finding.fingerprint);
	return {
		mode: "full",
		previousRun,
		changedPaths: snapshot.changedFiles.map((file) => file.path),
		priorOpenFindings: findings.filter((finding) => finding.status !== "fixed" && finding.status !== "dismissed"),
		suppressedDismissedFingerprints: [...new Set([...dismissed, ...dismissedEarlier])],
	};
}

/** Whether `plan` is a full review that decides the findings of the run it follows ({@link followUpReviewPlan}). */
export function decidesPreviousFindings(
	plan: ReviewIncrementalPlan | undefined,
): plan is ReviewIncrementalPlan & { previousRun: ReviewRunRecord } {
	return plan?.mode === "full" && plan.previousRun !== undefined;
}

/** Throws unless `previousRun` reviewed the target `snapshot` reviews: the same kind, and the same pull request. */
export function assertFollowsReviewOf(previousRun: ReviewRunRecord, snapshot: ReviewSnapshot): void {
	const previous = previousRun.target.identity;
	const current = snapshot.identity;
	if (
		previous.kind !== current.kind ||
		(current.kind === "pr" &&
			(previous.pullRequest?.providerId !== current.pullRequest?.providerId ||
				previous.pullRequest?.url !== current.pullRequest?.url))
	) {
		throw new Error(`Review ${previousRun.runId} reviewed another target; a review follows one of its own target.`);
	}
}

/**
 * `current`, which reports the earlier finding `prior` again, keeps whether `prior` was introduced unless this review
 * determined it.
 */
function carryIntroduced(current: ReviewFinding, prior: ReviewFinding): void {
	if (current.introduced === undefined && prior.introduced !== undefined) current.introduced = prior.introduced;
}

/**
 * The findings of a full review that follows an earlier run, once its verifier decided that run's open findings. A
 * finding decided open or uncertain takes that status in the finding that holds its id; held by none, one decided open
 * gives its id to the finding that reports it now (`candidateFingerprints` maps candidate ids to the fingerprints of
 * their findings), or, reported by none, is carried with that status. One without a decision stays as it was: in the
 * finding that holds its id, else its id and status go to a finding with its fingerprint that holds no other earlier
 * finding's id, else it is carried unchanged. A finding that takes an earlier finding's id keeps whether that one was
 * introduced, unless this review determined it. Findings decided fixed are not carried: they are returned, to be
 * closed where they were found.
 */
export function applyPreviousFindingDecisions(
	findings: readonly ReviewFinding[],
	priorOpenFindings: readonly ReviewFinding[],
	decisions: readonly ReviewPriorFindingDecision[],
	candidateFingerprints: ReadonlyMap<string, string>,
): { findings: ReviewFinding[]; fixed: ReviewPriorFindingDecision[] } {
	const result = findings.map((finding) => structuredClone(finding));
	const fixed: ReviewPriorFindingDecision[] = [];
	const undecided: ReviewFinding[] = [];
	for (const prior of priorOpenFindings) {
		const decision = decisions.find((candidate) => candidate.findingId === prior.id);
		if (!decision) {
			undecided.push(prior);
			continue;
		}
		if (decision.outcome === "fixed") {
			fixed.push(decision);
			continue;
		}
		const fingerprint =
			decision.candidateId === undefined ? undefined : candidateFingerprints.get(decision.candidateId);
		// Reported again with the same anchor, it already has its id.
		const current =
			result.find((finding) => finding.id === prior.id) ??
			(decision.outcome === "open" && fingerprint !== undefined
				? result.find((finding) => finding.fingerprint === fingerprint)
				: undefined);
		if (current) {
			current.id = prior.id;
			current.status = decision.outcome;
			carryIntroduced(current, prior);
		} else result.push({ ...structuredClone(prior), status: decision.outcome });
	}
	// After the decided ones, so one does not take a finding a decision gave its id.
	const priorIds = new Set(priorOpenFindings.map((prior) => prior.id));
	for (const prior of undecided) {
		if (result.some((finding) => finding.id === prior.id)) continue;
		const current = result.find((finding) => finding.fingerprint === prior.fingerprint && !priorIds.has(finding.id));
		if (current) {
			current.id = prior.id;
			current.status = prior.status;
			carryIntroduced(current, prior);
		} else result.push(structuredClone(prior));
	}
	return { findings: result, fixed };
}

/**
 * Settle `parsed`, a full review that follows an earlier run, with its verifier's decisions on that run's open
 * findings ({@link applyPreviousFindingDecisions}), and its verdict with them. Returns the findings decided fixed, to
 * be closed where they were found. Only a complete review closes them: an incomplete one carries them as they were,
 * so the round that follows it decides them again.
 */
export function settlePreviousFindings(
	parsed: ParsedReview,
	priorOpenFindings: readonly ReviewFinding[],
	decisions: readonly ReviewPriorFindingDecision[],
	candidateFingerprints: ReadonlyMap<string, string>,
): ReviewPriorFindingDecision[] {
	const findings = parsed.findings;
	const decided = applyPreviousFindingDecisions(findings, priorOpenFindings, decisions, candidateFingerprints);
	parsed.findings = decided.findings;
	settleReviewVerdict(parsed);
	if (parsed.completionStatus === "complete" || decided.fixed.length === 0) return decided.fixed;
	parsed.findings = applyPreviousFindingDecisions(
		findings,
		priorOpenFindings,
		decisions.filter((decision) => decision.outcome !== "fixed"),
		candidateFingerprints,
	).findings;
	settleReviewVerdict(parsed);
	return [];
}

/** The most runs {@link closeFixedFindings} and {@link dismissedFingerprintsOfFollowedRuns} walk back through. */
const MAX_FOLLOWED_RUNS = 16;

/**
 * The fingerprints of the findings dismissed in the runs `previousRun` followed in turn. A review that follows a run
 * leaves out the findings dismissed there, so the round after it learns of an earlier dismissal only from these runs.
 * A run this conversation does not hold ends the walk.
 */
export async function dismissedFingerprintsOfFollowedRuns(
	manager: SessionManager,
	previousRun: ReviewRunRecord,
): Promise<string[]> {
	const fingerprints = new Set<string>();
	const seen = new Set([previousRun.runId]);
	let runId = previousRun.parentRunId;
	while (runId !== undefined && !seen.has(runId) && seen.size < MAX_FOLLOWED_RUNS) {
		seen.add(runId);
		const run: HydratedReviewRunRecord | undefined = await getCanonicalReviewRun(manager, runId).catch(
			() => undefined,
		);
		if (!run) break;
		for (const finding of run.result?.findings ?? []) {
			if (finding.status === "dismissed") fingerprints.add(finding.fingerprint);
		}
		runId = run.parentRunId;
	}
	return [...fingerprints];
}

/**
 * Close the findings a complete review that followed `previousRunId` decided fixed: in that run and in each run it
 * followed in turn, wherever the finding (which keeps its id from run to run) is still open. A run this conversation
 * does not hold, or whose outcome it cannot record, is left as it is.
 */
export async function closeFixedFindings(
	writer: SessionWriter,
	previousRunId: string,
	reviewRunId: string,
	fixed: readonly ReviewPriorFindingDecision[],
): Promise<void> {
	if (fixed.length === 0) return;
	const seen = new Set<string>();
	let runId: string | undefined = previousRunId;
	while (runId !== undefined && !seen.has(runId) && seen.size < MAX_FOLLOWED_RUNS) {
		seen.add(runId);
		const run: HydratedReviewRunRecord | undefined = await getCanonicalReviewRun(writer.sessionManager, runId).catch(
			() => undefined,
		);
		if (!run) return;
		for (const decision of fixed) {
			const finding = run.result?.findings.find((candidate) => candidate.id === decision.findingId);
			if (!finding || finding.status === "fixed" || finding.status === "dismissed") continue;
			await recordReviewFindingOutcome(writer, {
				runId: run.runId,
				findingId: finding.id,
				status: "fixed",
				note: `Review ${reviewRunId} found it fixed: ${decision.rationale}`,
			}).catch(() => undefined);
		}
		runId = run.parentRunId;
	}
}

export function reconcileFindingIdentities(
	findings: readonly ReviewFinding[],
	plan: ReviewIncrementalPlan | undefined,
): ReviewFinding[] {
	if (!plan?.previousRun?.result) return findings.map((finding) => structuredClone(finding));
	const previousByFingerprint = new Map(
		plan.previousRun.result.findings.map((finding) => [finding.fingerprint, finding]),
	);
	return findings.flatMap((finding) => {
		if (plan.suppressedDismissedFingerprints.includes(finding.fingerprint)) return [];
		const previous = previousByFingerprint.get(finding.fingerprint);
		const reconciled = structuredClone(finding);
		if (previous) {
			reconciled.id = previous.id;
			reconciled.status = previous.status;
			carryIntroduced(reconciled, previous);
		}
		return [reconciled];
	});
}

export async function exportCanonicalReviewFeedback(
	manager: SessionManager,
): Promise<ReturnType<typeof exportReviewFeedback>> {
	const assertCurrent = reviewConversationGuard(manager);
	const feedback = exportReviewFeedback(manager);
	const runIds = new Set([
		...listReviewRuns(manager, { limit: 50 }).runs.map((run) => run.runId),
		...feedback.outcomes.map((outcome) => outcome.runId),
	]);
	let outcomes = feedback.outcomes;
	for (const runId of runIds) {
		const canonical = await readCanonicalReviewState(manager, runId, (source) =>
			source === manager
				? undefined
				: exportReviewFeedback(source).outcomes.filter((outcome) => outcome.runId === runId),
		);
		assertCurrent();
		if (canonical) outcomes = [...outcomes.filter((outcome) => outcome.runId !== runId), ...canonical];
	}
	return { ...feedback, outcomes };
}

export function exportReviewFeedback(sessionManager: SessionManager): {
	schemaVersion: 1;
	exportedAt: string;
	outcomes: ReviewFindingTransitionRecord[];
} {
	const outcomes = branchCustomEntries(sessionManager)
		.filter((entry) => entry.customType === REVIEW_FINDING_TRANSITION_CUSTOM_ENTRY_TYPE)
		.flatMap((entry) => {
			const transition = parseTransition(entry.data);
			return transition ? [transition] : [];
		});
	return { schemaVersion: REVIEW_STATE_SCHEMA_VERSION, exportedAt: new Date().toISOString(), outcomes };
}
