/**
 * The reviews extensions run (`ctx.reviews`): each starts as the conversation's `review` work, as `/review`
 * does, on the standard engine or one the conversation's extensions registered, and ends with the same run
 * record. An extension acts only on the reviews it started: it cancels them, posts them to their pull request,
 * and records what became of their findings; its UI may open and cancel them. Disabling or reloading it cancels
 * those still running.
 */

import type { QueryResult } from "@hansjm10/volt-protocol";
import type {
	ExtensionReviewEnd,
	ExtensionReviewEngine,
	ExtensionReviewFindingOutcome,
	ExtensionReviewPublication,
	ExtensionReviewPublishOptions,
	ExtensionReviewResult,
	ExtensionReviewRun,
	ExtensionReviewStartOptions,
	ExtensionReviewsHandler,
} from "../extensions/types.ts";
import {
	MAX_PULL_REQUEST_NUMBER,
	MUTABLE_WORKSPACE_REVIEW_TOOLS,
	type ReviewCheckoutSetup,
	type ReviewEffort,
	type ReviewRunControls,
	type ReviewTarget,
} from "../review.ts";
import type { ReviewEngineRegistry } from "../review-engine.ts";
import { projectReviewRun } from "../review-projection.ts";
import { publishReviewRun } from "../review-publish.ts";
import type { ConversationReviewOptions, StartedConversationReview } from "../review-start.ts";
import {
	appendReviewPublication,
	getCanonicalReviewRun,
	type HydratedReviewRunRecord,
	recordReviewFindingOutcome,
	STANDARD_REVIEW_ENGINE,
} from "../review-state.ts";
import type { SessionManager } from "../session-manager.ts";
import type { SessionWriter } from "../session-writer.ts";
import type { WorkRegistry } from "../work/registry.ts";

const TARGET_KINDS: readonly ExtensionReviewTarget[] = ["uncommitted", "branch", "branch_uncommitted", "pr", "commit"];
const EFFORTS: readonly ReviewEffort[] = ["low", "standard", "high"];
const OUTCOME_STATUSES: readonly ExtensionReviewFindingOutcome["status"][] = ["accepted", "fixed", "dismissed"];
const OUTCOME_REASONS: readonly NonNullable<ExtensionReviewFindingOutcome["reason"]>[] = [
	"false_positive",
	"intentional",
	"not_actionable",
	"other",
];
/** The longest trailer a posted review takes. */
const PUBLISH_TRAILER_MAX_CHARS = 4_000;
/** The most words of a command that runs the code host's CLI. */
const PUBLISH_COMMAND_MAX_WORDS = 8;

type ExtensionReviewTarget = ExtensionReviewEngine["targets"][number];

/** The host's own review, as `ctx.reviews.engines()` lists it. */
const STANDARD_ENGINE: ExtensionReviewEngine = Object.freeze({
	id: STANDARD_REVIEW_ENGINE,
	label: "Standard",
	description: "The built-in review: discovery and independent verification passes over a snapshot of the change.",
	targets: Object.freeze([...TARGET_KINDS]),
});

export interface ExtensionReviewRunsHost {
	readonly sessionManager: SessionManager;
	/** The writer of the conversation's log, where a review's publication and finding outcomes are recorded. */
	sessionWriter(): SessionWriter;
	work(): WorkRegistry;
	reviewEngines(): ReviewEngineRegistry;
	/** The names of the conversation's tools: what a standard review's auxiliary tools are checked against. */
	toolNames(): readonly string[];
	/** Whether `workId` is work of a kind the extension `owner` registered. */
	ownsKindWork(owner: string, workId: string): boolean;
	startReview(target: ReviewTarget, options: ConversationReviewOptions): Promise<StartedConversationReview>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): TypeError {
	return new TypeError(`ctx.reviews.start: ${message}`);
}

function optionalText(value: unknown, name: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim().length === 0) throw invalid(`${name} must be a non-empty string`);
	return value.trim();
}

function textList(value: unknown, name: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
		throw invalid(`${name} must be a list of non-empty strings`);
	}
	return value.map((item: string) => item.trim());
}

/** The host target an extension's review target names. */
function reviewTarget(value: unknown): ReviewTarget {
	if (!isRecord(value) || !TARGET_KINDS.includes(value.kind as ExtensionReviewTarget)) {
		throw invalid(`target.kind must be one of ${TARGET_KINDS.join(", ")}`);
	}
	switch (value.kind as ExtensionReviewTarget) {
		case "uncommitted":
			return { kind: "uncommitted" };
		case "branch": {
			const base = optionalText(value.base, "target.base");
			return { kind: "branch", ...(base === undefined ? {} : { base }) };
		}
		case "branch_uncommitted": {
			const base = optionalText(value.base, "target.base");
			return { kind: "branch_uncommitted", ...(base === undefined ? {} : { base }) };
		}
		case "pr": {
			const number = value.number;
			if (
				typeof number !== "number" ||
				!Number.isSafeInteger(number) ||
				number < 1 ||
				number > MAX_PULL_REQUEST_NUMBER
			) {
				throw invalid("target.number must be a pull request number");
			}
			return { kind: "pr", number: String(number) };
		}
		case "commit": {
			const ref = optionalText(value.ref, "target.ref");
			if (ref === undefined) throw invalid("target.ref must name the commit to review");
			return { kind: "commit", sha: ref };
		}
	}
}

/** The longest setup command a review takes, in characters. */
const SETUP_COMMAND_MAX_CHARS = 10_000;
/** The longest a review's setup may run. */
const SETUP_TIMEOUT_MAX_MS = 3_600_000;

/** A review checkout's setup as the extension supplied it: a command, and how long it may run. */
function checkoutSetup(value: unknown): ReviewCheckoutSetup | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw invalid("setup must be { command, timeoutMs? }");
	const { command, timeoutMs } = value;
	if (typeof command !== "string" || command.trim().length === 0 || command.length > SETUP_COMMAND_MAX_CHARS) {
		throw invalid(`setup.command must be a shell command of at most ${SETUP_COMMAND_MAX_CHARS} characters`);
	}
	if (
		timeoutMs !== undefined &&
		(typeof timeoutMs !== "number" ||
			!Number.isSafeInteger(timeoutMs) ||
			timeoutMs < 1 ||
			timeoutMs > SETUP_TIMEOUT_MAX_MS)
	) {
		throw invalid(`setup.timeoutMs must be a positive number of milliseconds of at most ${SETUP_TIMEOUT_MAX_MS}`);
	}
	return { command, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
}

/** The engine's parameters as the extension supplied them: a flat object of strings, numbers, and booleans. */
function engineParameters(value: unknown): Readonly<Record<string, string | number | boolean>> | undefined {
	if (value === undefined) return undefined;
	if (
		!isRecord(value) ||
		Object.values(value).some((item) => !["string", "number", "boolean"].includes(typeof item))
	) {
		throw invalid("params must map parameter names to strings, numbers, or booleans");
	}
	return { ...(value as Record<string, string | number | boolean>) };
}

export class ExtensionReviewRuns implements ExtensionReviewsHandler {
	private readonly host: ExtensionReviewRunsHost;
	/** The reviews each extension started, by manifest id: its UI may open and cancel them. */
	private readonly owned = new Map<string, Set<string>>();
	/** The extensions' reviews that have not ended. */
	private readonly running = new Set<string>();

	constructor(host: ExtensionReviewRunsHost) {
		this.host = host;
	}

	engines(): ExtensionReviewEngine[] {
		return [
			STANDARD_ENGINE,
			...this.host
				.reviewEngines()
				.list()
				.map((engine) => ({
					id: engine.id,
					label: engine.label,
					description: engine.description,
					...(engine.cost === undefined ? {} : { cost: engine.cost }),
					targets: [...engine.targets],
				})),
		];
	}

	async start(owner: string, options: ExtensionReviewStartOptions): Promise<ExtensionReviewRun> {
		const { target, review } = this.check(owner, options);
		const { workId } = await this.host.startReview(target, review);
		let owned = this.owned.get(owner);
		if (!owned) {
			owned = new Set();
			this.owned.set(owner, owned);
		}
		owned.add(workId);
		this.running.add(workId);
		const ended = this.host
			.work()
			.settled(workId)
			.then(() => this.end(workId))
			.catch(
				(error: unknown): ExtensionReviewEnd => ({
					status: "failed",
					error: error instanceof Error ? error.message : String(error),
				}),
			)
			.finally(() => this.running.delete(workId));
		return { id: workId, ended };
	}

	async result(runId: string): Promise<ExtensionReviewResult | undefined> {
		if (typeof runId !== "string") throw new TypeError("ctx.reviews.result needs a run id");
		const record = await getCanonicalReviewRun(this.host.sessionManager, runId);
		return record === undefined ? undefined : project(record);
	}

	async cancel(owner: string, runId: string): Promise<void> {
		this.requireOwned(owner, runId, "cancels");
		if (!this.running.has(runId)) return;
		const work = this.host.work();
		// It may have ended since.
		if (work.get(runId)?.outcome !== undefined) return;
		await work.cancel(runId);
	}

	async publish(
		owner: string,
		runId: string,
		options: ExtensionReviewPublishOptions = {},
	): Promise<ExtensionReviewPublication> {
		this.requireOwned(owner, runId, "posts");
		if (!isRecord(options)) throw new TypeError("ctx.reviews.publish: options must be an object");
		const { trailer, command } = options;
		if (
			trailer !== undefined &&
			(typeof trailer !== "string" || trailer.length === 0 || trailer.length > PUBLISH_TRAILER_MAX_CHARS)
		) {
			throw new TypeError(
				`ctx.reviews.publish: trailer must be text of at most ${PUBLISH_TRAILER_MAX_CHARS} characters`,
			);
		}
		if (
			command !== undefined &&
			(!Array.isArray(command) ||
				command.length === 0 ||
				command.length > PUBLISH_COMMAND_MAX_WORDS ||
				command.some((word) => typeof word !== "string" || word.length === 0))
		) {
			throw new TypeError(
				`ctx.reviews.publish: command must be a list of at most ${PUBLISH_COMMAND_MAX_WORDS} non-empty words`,
			);
		}
		const record = await getCanonicalReviewRun(this.host.sessionManager, runId);
		if (!record) throw new Error(`Unknown review run: ${runId}`);
		const published = await publishReviewRun(this.host.sessionManager.getCwd(), record, undefined, {
			...(trailer === undefined ? {} : { trailer }),
			...(command === undefined ? {} : { command: [...command] }),
		});
		await appendReviewPublication(this.host.sessionWriter(), { runId, ...published });
		return published;
	}

	async recordOutcome(
		owner: string,
		runId: string,
		findingId: string,
		outcome: ExtensionReviewFindingOutcome,
	): Promise<void> {
		this.requireOwned(owner, runId, "records outcomes of");
		if (typeof findingId !== "string" || findingId.length === 0) {
			throw new TypeError("ctx.reviews.recordOutcome needs a finding id");
		}
		if (!isRecord(outcome) || !OUTCOME_STATUSES.includes(outcome.status)) {
			throw new TypeError(`ctx.reviews.recordOutcome: status must be one of ${OUTCOME_STATUSES.join(", ")}`);
		}
		if (outcome.reason !== undefined && !OUTCOME_REASONS.includes(outcome.reason)) {
			throw new TypeError(`ctx.reviews.recordOutcome: reason must be one of ${OUTCOME_REASONS.join(", ")}`);
		}
		if (outcome.note !== undefined && typeof outcome.note !== "string") {
			throw new TypeError("ctx.reviews.recordOutcome: note must be text");
		}
		await recordReviewFindingOutcome(this.host.sessionWriter(), {
			runId,
			findingId,
			status: outcome.status,
			...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
			...(outcome.note === undefined ? {} : { note: outcome.note }),
		});
	}

	/** Whether the extension `owner` started review `workId`: its UI may open and cancel it. */
	owns(owner: string, workId: string): boolean {
		return this.owned.get(owner)?.has(workId) === true;
	}

	/** Cancel the reviews of the extension `owner` that have not ended. */
	async retire(owner: string): Promise<void> {
		const work = this.host.work();
		const running = [...(this.owned.get(owner) ?? [])].filter((runId) => this.running.has(runId));
		await Promise.all(running.map((runId) => work.cancel(runId).catch(() => undefined)));
	}

	private requireOwned(owner: string, runId: unknown, verb: string): void {
		if (typeof runId !== "string" || this.owned.get(owner)?.has(runId) !== true) {
			throw new Error(`Unknown review ${JSON.stringify(runId)}: an extension ${verb} only the reviews it started`);
		}
	}

	/** Check an extension's review start: what it reviews, on which engine, with which options. */
	private check(
		owner: string,
		options: ExtensionReviewStartOptions,
	): {
		target: ReviewTarget;
		review: ConversationReviewOptions;
	} {
		if (!isRecord(options)) throw new TypeError("ctx.reviews.start needs { target }");
		const target = reviewTarget(options.target);
		const engine = options.engine === undefined ? undefined : optionalText(options.engine, "engine");
		const extensionEngine = engine === STANDARD_REVIEW_ENGINE ? undefined : engine;
		const params = engineParameters(options.params);
		if (params !== undefined && extensionEngine === undefined) {
			throw invalid("params need an engine other than standard");
		}
		const previousRunId = optionalText(options.previousRunId, "previousRunId");
		if (options.followUps !== undefined && typeof options.followUps !== "boolean") {
			throw invalid("followUps must be true or false");
		}
		const tools = textList(options.tools, "tools");
		if (extensionEngine !== undefined && tools !== undefined) {
			throw invalid("tools apply to the standard review only");
		}
		const setup = checkoutSetup(options.setup);
		if (setup !== undefined && (tools === undefined || tools.length === 0)) {
			throw invalid("setup applies to a review whose passes run tools in a checkout: name them in tools");
		}
		if (tools !== undefined) {
			const available = new Set(this.host.toolNames());
			const refused = tools.filter((name) => !available.has(name) || MUTABLE_WORKSPACE_REVIEW_TOOLS.has(name));
			if (refused.length > 0) throw invalid(`tools not available to reviews: ${refused.join(", ")}`);
		}
		const { parentWorkId } = options;
		if (
			parentWorkId !== undefined &&
			(typeof parentWorkId !== "string" || !this.host.ownsKindWork(owner, parentWorkId))
		) {
			throw invalid("parentWorkId must be work of the extension's own kinds");
		}
		if (options.effort !== undefined && !EFFORTS.includes(options.effort)) {
			throw invalid(`effort must be one of ${EFFORTS.join(", ")}`);
		}
		if (options.includeOptional !== undefined && typeof options.includeOptional !== "boolean") {
			throw invalid("includeOptional must be true or false");
		}
		const focus = optionalText(options.focus, "focus");
		const scope = textList(options.scope, "scope");
		const controls: Partial<ReviewRunControls> = {
			...(focus === undefined ? {} : { focus }),
			...(scope === undefined ? {} : { scope }),
			...(options.effort === undefined ? {} : { effort: options.effort }),
			...(options.includeOptional === undefined ? {} : { includeOptional: options.includeOptional }),
			// Never incremental: a review an extension starts reviews everything.
			scopeMode: "full",
		};
		return {
			target,
			review: {
				// An extension runs at the host, with the permission to run commands.
				remote: false,
				...(extensionEngine === undefined ? {} : { engine: extensionEngine }),
				...(params === undefined ? {} : { engineParams: params }),
				controls,
				...(previousRunId === undefined ? {} : { previousRunId }),
				...(options.followUps === true ? { followUps: true } : {}),
				...(tools === undefined ? {} : { tools }),
				...(setup === undefined ? {} : { setup }),
				...(parentWorkId === undefined ? {} : { parentWorkId }),
			},
		};
	}

	/** How review `workId` ended: its run as its record says, else as its work does. */
	private async end(workId: string): Promise<ExtensionReviewEnd> {
		const record = await getCanonicalReviewRun(this.host.sessionManager, workId);
		if (record !== undefined) {
			return {
				status: record.status,
				...(record.errorMessage === undefined ? {} : { error: record.errorMessage }),
				run: project(record),
			};
		}
		const work = this.host.work().get(workId);
		return {
			status: work?.outcome === "cancelled" ? "cancelled" : "failed",
			error: work?.error ?? "The review ended without a run record",
		};
	}
}

/** A run as clients see it, with the follow-ups an extension reads besides. */
function project(record: HydratedReviewRunRecord): ExtensionReviewResult {
	const followUps = record.result?.followUps;
	return {
		...(projectReviewRun(record, true) as QueryResult<"review.result">),
		...(followUps === undefined ? {} : { followUps: structuredClone(followUps) }),
	};
}
