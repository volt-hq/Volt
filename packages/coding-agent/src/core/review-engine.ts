/**
 * Review engines: what runs a review besides the host's own pipeline. An engine reviews a host-resolved
 * snapshot with passes of its own and submits a candidate report and a verification report in the host's
 * shapes. The host validates and bounds them, builds the result with the same code the built-in pipeline
 * uses (anchors checked against the snapshot, finding ids and fingerprints, completeness, caps), and
 * writes the run record: an engine supplies findings, never records.
 *
 * An engine never sees patch text through its context. A pass gets the diff through {@link ReviewEnginePass.diff}
 * and the host's snapshot tools, which is what makes the run's coverage observed: a hunk counts as covered
 * only when some pass was given the whole of it through the host. That proves the host delivered the bytes,
 * not that a model read them or that passes were independent. A run is complete when the engine's own
 * assessment is complete and nothing is left unchecked, so a complete engine run says what the engine
 * reported and the host observed, and no more.
 */

import {
	type ExtensionSettings,
	ExtensionSettingsSchema,
	type ExtensionSettingsValues,
	type UiNode,
	type WorkProgress,
} from "@hansjm10/volt-protocol";
import { Compile, type Validator } from "typebox/compile";
import {
	checkSettingsSchema,
	ExtensionSettingsError,
	normalizeSettingsSchema,
	settingsDefaults,
	settingValueProblem,
} from "./extensions/settings.ts";
import type { ToolDefinition } from "./extensions/types.ts";
import { formatSchemaError } from "./protocol/schema-errors.ts";
import {
	controlsWithDefaults,
	inRunScope,
	type ReviewEffort,
	type ReviewRunControls,
	type ReviewTarget,
	reviewExclusions,
} from "./review.ts";
import { STATIC_REVIEW_LIMITATION } from "./review-presentation.ts";
import {
	buildParsedReview,
	declassifyReviewFindings,
	type ParsedReview,
	type ReviewCandidateReport,
	ReviewCandidateReportSchema,
	type ReviewVerificationReport,
	ReviewVerificationReportSchema,
	type ValidatedReviewCandidate,
	validateReviewCandidates,
	validateReviewVerification,
} from "./review-report.ts";
import type { ReviewChangedFileStatus, ReviewSnapshot, ReviewSnapshotIdentity } from "./review-snapshot.ts";
import { isExtensionReviewEngine } from "./review-state.ts";
import {
	createReviewSnapshotTools,
	deliverReviewDiff,
	type ReviewCoverageTracker,
	type ReviewDiffDelivery,
	type ReviewObservedCoverage,
	ReviewRunCoverage,
} from "./review-tools.ts";

/** An engine's name within its extension. */
export const REVIEW_ENGINE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Most review engines one extension registers. */
export const EXTENSION_REVIEW_ENGINES_MAX = 8;

/** Most characters of an engine's label, description, and cost note. */
const ENGINE_TEXT_MAX_CHARS = 500;

const TARGET_KINDS: readonly ReviewTarget["kind"][] = ["uncommitted", "branch", "branch_uncommitted", "pr", "commit"];

/**
 * Names an engine's parameters cannot take: they are flags beside the review's own options (`/review --focus
 * ... --workers 10`), so a parameter named like one of those would shadow it.
 */
export const RESERVED_REVIEW_PARAMETER_NAMES: ReadonlySet<string> = new Set([
	"target",
	"base",
	"number",
	"url",
	"ref",
	"engine",
	"engineParams",
	"focus",
	"scope",
	"effort",
	"includeOptional",
	"scopeMode",
	"tools",
	"incremental",
	"full",
]);

let parametersValidator: Validator | undefined;

/** What an engine declares about itself, and the function that runs its reviews. */
export interface ReviewEngineDeclaration {
	/** `ext:<extension id>/<engine name>`: how run records, intents, and clients name it. */
	readonly id: string;
	readonly label: string;
	readonly description: string;
	/** What choosing it costs compared with the built-in pipeline, shown before it starts. */
	readonly cost?: string;
	/** The targets it reviews. A pull request is captured by its identity alone: an engine reviews its code, not its discussion. */
	readonly targets: readonly ReviewTarget["kind"][];
	/** Whether a paired remote device may start it. */
	readonly remoteSafe: boolean;
	/**
	 * The engine's options, declared like an extension's manifest settings: a flat object of string, string enum,
	 * boolean, and integer parameters with defaults and bounds. A run's {@link ReviewEngineContext.params} are
	 * these, checked, with the defaults filled in.
	 */
	readonly parameters?: ExtensionSettings;
	/** Parameters only a client at the host may set: a paired remote device is refused them, and never sees them. */
	readonly localOnly?: readonly string[];
	/** Review `ctx.target`, submit the result with {@link ReviewEngineContext.submit}, and return. */
	run(ctx: ReviewEngineContext): Promise<void>;
}

/** An engine that is not valid; the message says what to fix. */
export class ReviewEngineDeclarationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ReviewEngineDeclarationError";
	}
}

/** The declaration of an engine, checked and copied; throws what an engine's author must fix. */
export function validateReviewEngine(engine: unknown): ReviewEngineDeclaration {
	if (typeof engine !== "object" || engine === null) {
		throw new ReviewEngineDeclarationError("A review engine must be declared as an object");
	}
	const { id, label, description, cost, targets, remoteSafe, parameters, localOnly, run } = engine as Record<
		string,
		unknown
	>;
	if (!isExtensionReviewEngine(id)) {
		throw new ReviewEngineDeclarationError(
			`Invalid review engine id ${JSON.stringify(id)}: use ext:<extension id>/<engine name>`,
		);
	}
	const text = (name: string, value: unknown, required: boolean): string | undefined => {
		if (value === undefined && !required) return undefined;
		if (typeof value !== "string" || value.trim().length === 0 || value.length > ENGINE_TEXT_MAX_CHARS) {
			throw new ReviewEngineDeclarationError(
				`Review engine ${id}: ${name} must be text of at most ${ENGINE_TEXT_MAX_CHARS} characters`,
			);
		}
		return value;
	};
	const kept = {
		label: text("label", label, true) as string,
		description: text("description", description, true) as string,
		cost: text("cost", cost, false),
	};
	// Read once: what is checked is what is kept.
	const targetList: unknown[] | undefined = Array.isArray(targets) ? [...targets] : undefined;
	const keptTargets = targetList?.filter((target): target is ReviewTarget["kind"] =>
		TARGET_KINDS.includes(target as ReviewTarget["kind"]),
	);
	if (!targetList || targetList.length === 0 || keptTargets?.length !== targetList.length) {
		throw new ReviewEngineDeclarationError(
			`Review engine ${id}: targets must list review targets (${TARGET_KINDS.join(", ")})`,
		);
	}
	if (remoteSafe !== undefined && typeof remoteSafe !== "boolean") {
		throw new ReviewEngineDeclarationError(`Review engine ${id}: remoteSafe must be a boolean`);
	}
	if (typeof run !== "function") throw new ReviewEngineDeclarationError(`Review engine ${id}: run must be a function`);
	let keptParameters: ExtensionSettings | undefined;
	if (parameters !== undefined) {
		const normalized = normalizeSettingsSchema(parameters);
		parametersValidator ??= Compile(ExtensionSettingsSchema);
		if (!parametersValidator.Check(normalized)) {
			throw new ReviewEngineDeclarationError(
				`Review engine ${id}: parameters ${formatSchemaError(ExtensionSettingsSchema, parametersValidator.Errors(normalized))}`,
			);
		}
		// Plain data from here on: what is checked is what is kept.
		keptParameters = structuredClone(normalized) as ExtensionSettings;
		try {
			checkSettingsSchema(keptParameters);
		} catch (error) {
			if (error instanceof ExtensionSettingsError) {
				throw new ReviewEngineDeclarationError(`Review engine ${id}: parameters: ${error.message}`);
			}
			throw error;
		}
		const shadowing = Object.keys(keptParameters.properties).filter((name) =>
			RESERVED_REVIEW_PARAMETER_NAMES.has(name),
		);
		if (shadowing.length > 0) {
			throw new ReviewEngineDeclarationError(
				`Review engine ${id}: parameters cannot be named like a review option: ${shadowing.join(", ")}`,
			);
		}
		deepFreeze(keptParameters);
	}
	let keptLocalOnly: string[] | undefined;
	if (localOnly !== undefined) {
		const names: unknown[] | undefined = Array.isArray(localOnly) ? [...localOnly] : undefined;
		if (
			!names ||
			names.some((name) => typeof name !== "string" || !Object.hasOwn(keptParameters?.properties ?? {}, name))
		) {
			throw new ReviewEngineDeclarationError(`Review engine ${id}: localOnly must list declared parameters`);
		}
		keptLocalOnly = [...new Set(names as string[])];
	}
	return Object.freeze({
		id,
		label: kept.label,
		description: kept.description,
		...(kept.cost === undefined ? {} : { cost: kept.cost }),
		targets: Object.freeze([...new Set(keptTargets)]),
		remoteSafe: remoteSafe === true,
		...(keptParameters === undefined ? {} : { parameters: keptParameters }),
		...(keptLocalOnly === undefined ? {} : { localOnly: Object.freeze(keptLocalOnly) }),
		run: run as ReviewEngineDeclaration["run"],
	});
}

function deepFreeze<T>(value: T): T {
	if (typeof value === "object" && value !== null) {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}

/** Parameters that cannot be used; `localOnly` says a remote client set one only a local client may. */
export class ReviewEngineParametersError extends Error {
	readonly reason: "invalid" | "local_only";

	constructor(reason: "invalid" | "local_only", message: string) {
		super(message);
		this.name = "ReviewEngineParametersError";
		this.reason = reason;
	}
}

/**
 * The parameters of a run of `engine`: the values a client supplied, checked against its declaration, over its
 * defaults. A remote client may not set a `localOnly` parameter; the default stands for it.
 */
export function resolveReviewEngineParameters(
	engine: Pick<ReviewEngineDeclaration, "label" | "parameters" | "localOnly">,
	supplied: Readonly<Record<string, unknown>> | undefined,
	options: { remote: boolean },
): Readonly<ExtensionSettingsValues> {
	const properties = engine.parameters?.properties ?? {};
	const problems: string[] = [];
	const values: ExtensionSettingsValues = {};
	for (const [name, value] of Object.entries(supplied ?? {})) {
		const setting = Object.hasOwn(properties, name) ? properties[name] : undefined;
		if (!setting) {
			problems.push(`${name} is not a parameter of the ${engine.label} engine`);
			continue;
		}
		if (options.remote && engine.localOnly?.includes(name)) {
			throw new ReviewEngineParametersError("local_only", `${name} can only be set by a client at the host`);
		}
		const problem = settingValueProblem(setting, value);
		if (problem !== undefined) problems.push(`${name} ${problem}`);
		else Object.defineProperty(values, name, { value, enumerable: true, configurable: true, writable: true });
	}
	const effective: ExtensionSettingsValues = { ...settingsDefaults(engine.parameters), ...values };
	for (const name of engine.parameters?.required ?? []) {
		if (!Object.hasOwn(effective, name)) problems.push(`${name} is required`);
	}
	if (problems.length > 0) throw new ReviewEngineParametersError("invalid", problems.join("; "));
	return Object.freeze(effective);
}

/** The engines a conversation can run besides the built-in pipeline, by id. */
export class ReviewEngineRegistry {
	private readonly engines = new Map<string, ReviewEngineDeclaration>();

	/** Add `engine` and return the function that removes it. Throws when its id is taken. */
	register(engine: ReviewEngineDeclaration): () => void {
		const kept = validateReviewEngine(engine);
		if (this.engines.has(kept.id))
			throw new ReviewEngineDeclarationError(`Review engine ${kept.id} is already registered`);
		this.engines.set(kept.id, kept);
		return () => {
			if (this.engines.get(kept.id) === kept) this.engines.delete(kept.id);
		};
	}

	get(id: string): ReviewEngineDeclaration | undefined {
		return this.engines.get(id);
	}

	list(): ReviewEngineDeclaration[] {
		return [...this.engines.values()];
	}
}

/** One hunk of a changed file, without its patch text. */
export interface ReviewEngineHunk {
	id: string;
	header: string;
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
	/** The patch's size in UTF-8 bytes: what {@link ReviewEnginePass.diff} counts against its budget. */
	patchBytes: number;
}

/** One changed file of the reviewed snapshot, without patch text. */
export interface ReviewEngineChangedFile {
	path: string;
	previousPath?: string;
	status: ReviewChangedFileStatus;
	/** The host can review it: not binary and not unsupported. */
	reviewable: boolean;
	/** The run's scope includes it. */
	inScope: boolean;
	unsupportedReason?: string;
	additions?: number;
	deletions?: number;
	baseOid?: string;
	headOid?: string;
	hunks: ReviewEngineHunk[];
}

/** What is being reviewed, as the host resolved it. */
export interface ReviewEngineTarget {
	kind: ReviewTarget["kind"];
	description: string;
	/** Git facts about the commits, trees, and (for a pull request) its identity. */
	identity: ReviewSnapshotIdentity;
	/** The repository the review was started in. */
	root: string;
	/** Host-written text about the target, such as a branch's commit list, or none. */
	extraContext?: string;
	controls: { focus?: string; scope: string[]; effort: ReviewEffort; includeOptional: boolean };
}

/** One independent pass over the snapshot: what it reads through the host is what the run's coverage counts. */
export interface ReviewEnginePass {
	/** The host's snapshot tools for this pass (changed files, diff, file, tree, search), whose reads are observed. */
	tools(): ToolDefinition[];
	/**
	 * The diff text of `hunkIds`, within `maxBytes` of UTF-8: a hunk is delivered whole or left in `omitted`, and
	 * only the hunks delivered count as covered. A hunk id the snapshot does not have throws.
	 */
	diff(hunkIds: readonly string[], maxBytes: number): ReviewDiffDelivery;
	/** What this pass has observed so far. */
	coverage(): ReviewObservedCoverage;
}

/** What {@link ReviewEngineContext.validate} says about a candidate report. */
export interface ReviewEngineValidation {
	/** The ids of the candidates the host would accept. */
	accepted: string[];
	/** Why it would reject the others, and anything wrong with the report itself. */
	errors: string[];
}

/** What an engine submits: the host's own report shapes, and what the engine ran. */
export interface ReviewEngineResult {
	candidates: ReviewCandidateReport;
	verification: ReviewVerificationReport;
	/** Commands the engine ran while verifying (at most 100, one line of 500 characters each); none means the review was static. */
	commandsRun?: string[];
	/** Verification attempts that failed, bounded the same way. */
	failedVerificationAttempts?: string[];
}

/** What the host made of a submitted result. */
export interface ReviewEngineSubmission {
	completionStatus: ParsedReview["completionStatus"];
	/** The findings the run keeps. */
	findings: number;
	/** The ids of candidates the host did not accept; their decisions were dropped. */
	rejected: string[];
	/** Why it rejected them. */
	errors: string[];
}

/** A submission the host refused as a whole; the engine may fix it and submit again. */
export class ReviewEngineSubmissionError extends Error {
	readonly errors: readonly string[];

	constructor(errors: readonly string[]) {
		super(`The review result was refused: ${errors.join("; ")}`);
		this.name = "ReviewEngineSubmissionError";
		this.errors = errors;
	}
}

/** What an engine's run gets: the target, the passes, the host's validation, and the work's channels. */
export interface ReviewEngineContext {
	/** The review's work id, which is its run id: what a detail action names to cancel or open this run. */
	readonly workId: string;
	/** The run's parameters: checked against {@link ReviewEngineDeclaration.parameters}, defaults filled in. */
	readonly params: Readonly<ExtensionSettingsValues>;
	/** Aborted when the review is cancelled or the conversation closes. */
	readonly signal: AbortSignal;
	readonly target: ReviewEngineTarget;
	/** The conversation's working directory. */
	readonly cwd: string;
	/** Fine-grained progress and detail (UI data), which clients see live. */
	progress(progress: WorkProgress, detail?: UiNode): void;
	/** A phase: live at once, and durable as a coarse checkpoint. */
	checkpoint(progress: WorkProgress, detail?: UiNode): void;
	/** The run's output: its newest part becomes the work's output. */
	output(text: string): void;
	/**
	 * The changed files with their hunk ids, without patch text. Calling it counts as the engine receiving
	 * the changed-file inventory, which a complete run needs.
	 */
	changedFiles(): ReviewEngineChangedFile[];
	/** Start one more independent pass. */
	pass(): ReviewEnginePass;
	/** Check a candidate report as {@link submit} would, without keeping anything: for an engine to repair its reports. */
	validate(candidates: ReviewCandidateReport): Promise<ReviewEngineValidation>;
	/**
	 * Submit the run's result once. Candidates that fail the host's anchor checks are dropped (see
	 * {@link ReviewEngineSubmission}); a result that cannot stand as a whole throws a
	 * {@link ReviewEngineSubmissionError}, after which the engine may submit again.
	 */
	submit(result: ReviewEngineResult): Promise<ReviewEngineSubmission>;
	/** A disposable checkout of the reviewed head, removed when the review ends. */
	checkout(): Promise<string>;
}

/** Most commands, and most failed attempts, one result reports. */
const REPORTED_COMMANDS_MAX = 100;
/** Longest command or failed attempt a result reports, in characters. */
const REPORTED_COMMAND_MAX_CHARS = 500;

/** A reported list of commands: strings, one line each, bounded as the built-in pipeline bounds the commands it saw. */
function reportedCommands(label: string, value: unknown): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		throw new ReviewEngineSubmissionError([`${label} must be a list of strings`]);
	}
	if (value.length > REPORTED_COMMANDS_MAX) {
		throw new ReviewEngineSubmissionError([`${label} lists more than ${REPORTED_COMMANDS_MAX} entries`]);
	}
	return value.map((entry: string) => entry.replace(/\s+/g, " ").trim().slice(0, REPORTED_COMMAND_MAX_CHARS));
}

let candidateValidator: Validator | undefined;
let verificationValidator: Validator | undefined;

function schemaErrors(
	label: string,
	validator: Validator,
	schema: typeof ReviewCandidateReportSchema | typeof ReviewVerificationReportSchema,
	value: unknown,
): string[] {
	if (validator.Check(value)) return [];
	return [`${label}: ${formatSchemaError(schema, validator.Errors(value))}`];
}

function candidateSchemaErrors(report: unknown): string[] {
	candidateValidator ??= Compile(ReviewCandidateReportSchema);
	return schemaErrors("candidates", candidateValidator, ReviewCandidateReportSchema, report);
}

function verificationSchemaErrors(report: unknown): string[] {
	verificationValidator ??= Compile(ReviewVerificationReportSchema);
	return schemaErrors("verification", verificationValidator, ReviewVerificationReportSchema, report);
}

export interface ReviewEngineRunOptions {
	snapshot: ReviewSnapshot;
	target: ReviewTarget;
	controls: ReviewRunControls;
	cwd: string;
}

/** The state of one engine run: its passes' coverage, and the result it submitted. */
export class ReviewEngineRun {
	private readonly snapshot: ReviewSnapshot;
	private readonly target: ReviewTarget;
	private readonly controls: ReviewRunControls;
	private readonly cwd: string;
	private readonly coverage = new ReviewRunCoverage();
	private readonly inScopeHunkIds: ReadonlySet<string>;
	private inventory: ReviewCoverageTracker | undefined;
	private submitted: ParsedReview | undefined;
	private ended = false;

	constructor(options: ReviewEngineRunOptions) {
		this.snapshot = options.snapshot;
		this.target = options.target;
		this.controls = controlsWithDefaults(options.controls);
		this.cwd = options.cwd;
		this.inScopeHunkIds = new Set(
			this.snapshot.changedFiles
				.filter((file) => file.reviewable && inRunScope(file.path, this.controls, undefined))
				.flatMap((file) => file.hunks.map((hunk) => hunk.id)),
		);
	}

	/** The result the engine submitted, if it did. */
	result(): ParsedReview | undefined {
		return this.submitted;
	}

	/** The run is over: its context refuses further calls. */
	end(): void {
		this.ended = true;
	}

	private assertLive(): void {
		if (this.ended) throw new Error("The review has ended");
	}

	/** The context for an engine's run, with the work's channels. */
	context(
		channels: Pick<ReviewEngineContext, "workId" | "params" | "signal" | "progress" | "checkpoint" | "output">,
	): ReviewEngineContext {
		const snapshot = this.snapshot;
		const controls = this.controls;
		const context: ReviewEngineContext = {
			...channels,
			cwd: this.cwd,
			target: Object.freeze({
				kind: this.target.kind,
				description: snapshot.description,
				identity: structuredClone(snapshot.identity),
				root: snapshot.root,
				...(snapshot.extraContext === undefined ? {} : { extraContext: snapshot.extraContext }),
				controls: {
					...(controls.focus === undefined ? {} : { focus: controls.focus }),
					scope: [...controls.scope],
					effort: controls.effort,
					includeOptional: controls.includeOptional,
				},
			}),
			changedFiles: () => this.changedFiles(),
			pass: () => this.pass(),
			validate: (candidates) => this.validate(candidates),
			submit: (result) => this.submit(result),
			checkout: async () => {
				this.assertLive();
				return await snapshot.materializeHead();
			},
		};
		return Object.freeze(context);
	}

	private changedFiles(): ReviewEngineChangedFile[] {
		this.assertLive();
		this.inventory ??= this.coverage.newPass();
		this.inventory.recordChangedFilePage(true);
		return this.snapshot.changedFiles.map((file) => ({
			path: file.path,
			...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
			status: file.status,
			reviewable: file.reviewable,
			inScope: inRunScope(file.path, this.controls, undefined),
			...(file.unsupportedReason === undefined ? {} : { unsupportedReason: file.unsupportedReason }),
			...(file.additions === undefined ? {} : { additions: file.additions }),
			...(file.deletions === undefined ? {} : { deletions: file.deletions }),
			...(file.base === undefined ? {} : { baseOid: file.base.oid }),
			...(file.head === undefined ? {} : { headOid: file.head.oid }),
			hunks: file.hunks.map((hunk) => ({
				id: hunk.id,
				header: hunk.header,
				oldStart: hunk.oldStart,
				oldCount: hunk.oldCount,
				newStart: hunk.newStart,
				newCount: hunk.newCount,
				patchBytes: Buffer.byteLength(hunk.patch, "utf8"),
			})),
		}));
	}

	private pass(): ReviewEnginePass {
		this.assertLive();
		const tracker = this.coverage.newPass();
		let tools: ToolDefinition[] | undefined;
		return Object.freeze({
			tools: () => {
				this.assertLive();
				tools ??= createReviewSnapshotTools(this.snapshot, tracker);
				return [...tools];
			},
			diff: (hunkIds: readonly string[], maxBytes: number) => {
				this.assertLive();
				return deliverReviewDiff(this.snapshot, tracker, hunkIds, maxBytes);
			},
			coverage: () => tracker.snapshot(),
		});
	}

	/**
	 * Check a candidate report against the snapshot. A candidate is accepted only when nothing was found wrong with
	 * it: the built-in pipeline sends a report with any error back to its pass, but a submission is final, so a
	 * candidate the checks complained about, however mildly, is dropped.
	 */
	private async checkCandidates(report: ReviewCandidateReport): Promise<{
		accepted: ValidatedReviewCandidate[];
		rejected: string[];
		errors: string[];
	}> {
		const validation = await validateReviewCandidates(this.snapshot, report, {
			includeOptional: this.controls.includeOptional,
			inScopeHunkIds: this.inScopeHunkIds,
		});
		const complained = new Set(
			validation.errors.flatMap((error) => {
				const index = /^candidates\[(\d+)\]/.exec(error)?.[1];
				return index === undefined ? [] : [Number(index)];
			}),
		);
		const accepted: ValidatedReviewCandidate[] = [];
		const rejected: string[] = [];
		const seen = new Set<string>();
		for (const [index, candidate] of report.candidates.entries()) {
			const first = !seen.has(candidate.candidateId);
			seen.add(candidate.candidateId);
			const verified = first
				? validation.candidates.find((entry) => entry.candidateId === candidate.candidateId)
				: undefined;
			if (verified && !complained.has(index)) accepted.push(verified);
			else rejected.push(candidate.candidateId);
		}
		return { accepted, rejected, errors: validation.errors };
	}

	private async validate(candidates: ReviewCandidateReport): Promise<ReviewEngineValidation> {
		this.assertLive();
		const shape = candidateSchemaErrors(candidates);
		if (shape.length > 0) return { accepted: [], errors: shape };
		const checked = await this.checkCandidates(candidates);
		return { accepted: checked.accepted.map((candidate) => candidate.candidateId), errors: checked.errors };
	}

	private async submit(result: ReviewEngineResult): Promise<ReviewEngineSubmission> {
		this.assertLive();
		if (this.submitted) throw new Error("The review result was already submitted");
		const shape = [...candidateSchemaErrors(result?.candidates), ...verificationSchemaErrors(result?.verification)];
		if (shape.length > 0) throw new ReviewEngineSubmissionError(shape);
		const checked = await this.checkCandidates(result.candidates);
		const validated = checked.accepted;
		const acceptedIds = new Set(validated.map((candidate) => candidate.candidateId));
		const rejected = checked.rejected;
		// A decision about a candidate the host dropped goes with it.
		const dropped = new Set(rejected.filter((candidateId) => !acceptedIds.has(candidateId)));
		const verification: ReviewVerificationReport = {
			...result.verification,
			decisions: result.verification.decisions.filter((decision) => !dropped.has(decision.candidateId)),
		};
		const verificationErrors = validateReviewVerification(validated, verification);
		if (verificationErrors.length > 0) throw new ReviewEngineSubmissionError(verificationErrors);
		const observed = this.coverage.snapshot();
		const commandsRun = reportedCommands("commandsRun", result.commandsRun);
		const failedVerificationAttempts = reportedCommands(
			"failedVerificationAttempts",
			result.failedVerificationAttempts,
		);
		const parsed = buildParsedReview({
			snapshot: this.snapshot,
			candidateReport: { ...result.candidates, candidates: validated },
			validatedCandidates: validated,
			verificationReport: verification,
			declassifiedFindings: declassifyReviewFindings(validated, verification),
			discoveryCoverage: observed,
			verificationCoverage: observed,
			commandsRun,
			failedVerificationAttempts,
			excludedPaths: reviewExclusions(this.snapshot, this.controls, undefined),
		});
		if (commandsRun.length === 0) parsed.coverage.residualRisk.unshift(STATIC_REVIEW_LIMITATION);
		this.submitted = parsed;
		return {
			completionStatus: parsed.completionStatus,
			findings: parsed.findings.length,
			rejected,
			errors: checked.errors,
		};
	}
}
