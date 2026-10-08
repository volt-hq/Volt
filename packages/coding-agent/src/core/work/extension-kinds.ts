/**
 * The work kinds a session's extensions declare (RFC §7.2, `ext:<id>/<kind>`),
 * registered in the conversation's work registry, and the work they start.
 *
 * The id is the extension's manifest id (RFC §8.1), which no other extension
 * in the conversation has. An extension starts only its own kinds:
 * `ctx.startWork` finds a kind by name among the kinds of the extension the
 * context belongs to, and a name never spells another extension's or a
 * built-in kind.
 *
 * A runner generation's kinds are removed when the extensions reload, which
 * interrupts the work they run: what its executors return or report
 * afterwards no longer counts (WorkRegistry.register). Disabling one
 * extension removes its kinds and cancels their work instead: each executor
 * is aborted and waited for up to {@link EXTENSION_DISABLE_GRACE_MS}, then
 * what is still open finishes `cancelled`. Extension kinds do not resume, so
 * a restart interrupts their open work too.
 *
 * An executor sees the work id, an abort signal, progress, checkpoints, and
 * output; never the host, its clients, or the session. Its result keeps a
 * summary, output, data, and the notice's own text; never a child
 * conversation. A kind's `detail` presents a running item's detail from the
 * item; what it returns is normalized under the extension's action policy and
 * bounded, and an item it throws for shows its progress only.
 */

import type { JsonValue } from "@hansjm10/volt-ai";
import {
	REMOTE_CAPABILITIES,
	type RemoteCapability,
	type UiNode,
	WORK_CHECKPOINT_MAX_SERIALIZED_BYTES,
	type WorkKind,
	type WorkProgress,
	type WorkProgressStep,
	type WorkResult,
} from "@hansjm10/volt-protocol";
import { cloneCanonicalData } from "../canonical-data.ts";
import type {
	StartWorkOptions,
	WorkKindDeclaration,
	WorkRun,
	WorkRunContext,
	WorkRunResult,
} from "../extensions/types.ts";
import { normalizeUiNode } from "../ui/normalize.ts";
import { refuseThenable, type WorkDetailInput, type WorkDetailPresenter } from "../ui/presentation.ts";
import {
	type WorkContext,
	type WorkExecution,
	type WorkKindCancellation,
	type WorkRegistry,
	workText,
} from "./registry.ts";

/** A kind's name within its extension. */
const WORK_KIND_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Most kinds one extension declares. */
export const EXTENSION_KINDS_MAX = 16;

/** Most items of one extension kind running at once. */
export const EXTENSION_KIND_MAX_ACTIVE = 8;

/** How long disabling an extension waits for its work's executors to stop before it finishes the work without them. */
export const EXTENSION_DISABLE_GRACE_MS = 10_000;

/** Most steps extension progress keeps. */
const PROGRESS_STEPS_MAX = 64;

const DELIVERIES: ReadonlySet<string> = new Set(["none", "message", "wake"]);
const CAPABILITIES: ReadonlySet<string> = new Set(REMOTE_CAPABILITIES);
const STEP_STATUSES: ReadonlySet<string> = new Set(["pending", "active", "done", "failed", "skipped"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCapability(value: unknown): value is RemoteCapability {
	return typeof value === "string" && CAPABILITIES.has(value);
}

/** The declaration of kind `name`, checked and copied; throws what an extension author must fix. */
export function validateWorkKind(name: unknown, kind: unknown = {}): WorkKindDeclaration {
	if (typeof name !== "string" || !WORK_KIND_NAME_PATTERN.test(name)) {
		throw new Error(
			`Invalid work kind name ${JSON.stringify(name)}: use at most 64 lowercase letters, digits, "-", and "_", starting with a letter or digit`,
		);
	}
	if (!isRecord(kind)) throw new TypeError(`Work kind ${name} must be declared as an object`);
	const { delivery = "none", cancellable = true, cancelOnAbort, maxActive = 1, requires = [], detail } = kind;
	if (detail !== undefined && typeof detail !== "function") {
		throw new TypeError(`Work kind ${name}: detail must be a function`);
	}
	if (typeof delivery !== "string" || !DELIVERIES.has(delivery)) {
		throw new TypeError(`Work kind ${name}: delivery must be "none", "message", or "wake"`);
	}
	if (typeof cancellable !== "boolean") throw new TypeError(`Work kind ${name}: cancellable must be a boolean`);
	if (cancelOnAbort !== undefined && cancelOnAbort !== false) {
		throw new TypeError(`Work kind ${name}: cancelOnAbort can only be false`);
	}
	if (
		typeof maxActive !== "number" ||
		!Number.isSafeInteger(maxActive) ||
		maxActive < 1 ||
		maxActive > EXTENSION_KIND_MAX_ACTIVE
	) {
		throw new TypeError(`Work kind ${name}: maxActive must be an integer from 1 to ${EXTENSION_KIND_MAX_ACTIVE}`);
	}
	// Read once: what is checked is what is kept.
	const capabilities: unknown[] | undefined = Array.isArray(requires) ? [...requires] : undefined;
	if (!capabilities?.every(isCapability)) {
		throw new TypeError(`Work kind ${name}: requires must list remote capabilities`);
	}
	return Object.freeze({
		delivery: delivery as WorkKindDeclaration["delivery"],
		cancellable,
		...(cancelOnAbort === false ? { cancelOnAbort } : {}),
		maxActive,
		requires: Object.freeze([...new Set(capabilities.filter(isCapability))]),
		...(detail === undefined ? {} : { detail: detail as WorkDetailPresenter }),
	});
}

/** Largest detail an extension kind presents, as serialized JSON in UTF-8 bytes: room for its progress in the live value. */
export const EXTENSION_DETAIL_MAX_BYTES = WORK_CHECKPOINT_MAX_SERIALIZED_BYTES - 1024;

/** Progress a client can render: text without control sequences, finite numbers, and well-formed steps. */
export function keptProgress(progress: unknown): WorkProgress | undefined {
	if (!isRecord(progress)) return undefined;
	const { text, value, max, steps } = progress;
	const kept: WorkProgressStep[] = [];
	if (Array.isArray(steps)) {
		for (const step of steps.slice(0, PROGRESS_STEPS_MAX)) {
			if (!isRecord(step) || typeof step.key !== "string" || typeof step.label !== "string") continue;
			if (typeof step.status !== "string" || !STEP_STATUSES.has(step.status)) continue;
			const key = workText(step.key, 256).replace(/\s+/g, " ").trim();
			if (key.length === 0) continue;
			kept.push({ key, label: workText(step.label), status: step.status as WorkProgressStep["status"] });
		}
	}
	return {
		...(typeof text === "string" ? { text: workText(text) } : {}),
		...(typeof value === "number" && Number.isFinite(value) && value >= 0 ? { value } : {}),
		...(typeof max === "number" && Number.isFinite(max) && max > 0 ? { max } : {}),
		...(Array.isArray(steps) ? { steps: kept } : {}),
	};
}

/** The parts of a run's result the registry takes from extension work, each read once: never a child conversation. */
function ownedExecution(value: WorkRunResult): WorkExecution {
	if (!isRecord(value)) return { outcome: "failed", error: "The work's run returned no outcome" };
	const { outcome, result, error, notice } = value;
	let kept: WorkResult | undefined;
	if (isRecord(result)) {
		const { summary, output, data } = result;
		let ownData: JsonValue | undefined;
		try {
			ownData = data === undefined ? undefined : cloneCanonicalData(data as JsonValue, "Work result data");
		} catch {
			// Data that is not JSON is dropped; the rest of the result stays.
		}
		kept = {
			...(typeof summary === "string" ? { summary } : {}),
			...(isRecord(output) && typeof output.text === "string"
				? { output: { text: output.text, truncated: output.truncated === true } }
				: {}),
			...(ownData === undefined ? {} : { data: ownData }),
		};
	}
	return {
		outcome: outcome as WorkExecution["outcome"],
		...(kept === undefined ? {} : { result: kept }),
		...(typeof error === "string" ? { error } : {}),
		...(typeof notice === "string" ? { deliver: { text: notice } } : {}),
	};
}

/** A kind an extension declared, as its runner lists them in load order. */
export interface DeclaredWorkKind {
	/** The manifest id of the extension that declared it. */
	readonly extensionId: string;
	readonly name: string;
	readonly kind: WorkKindDeclaration;
}

/** A declared kind the host did not register, and why. */
export interface WorkKindRefusal {
	readonly extensionId: string;
	readonly error: string;
}

/** Owns `ctx.startWork`: starts work of `name` for the extension whose manifest id is `owner`. */
export type StartWorkHandler = (
	owner: string | undefined,
	name: string,
	options: StartWorkOptions,
	run: WorkRun,
) => Promise<{ readonly workId: string }>;

interface OwnedKind {
	readonly kind: WorkKind;
	readonly remove: (cancel?: WorkKindCancellation) => Promise<void>;
}

/** The extension kinds registered in one conversation's work registry. */
export class ExtensionKinds {
	private readonly work: () => WorkRegistry;
	/** The registered kinds, by extension id, then name. */
	private kinds = new Map<string, Map<string, OwnedKind>>();
	/** Declared kinds already refused, so each is reported once. */
	private refused = new Set<string>();

	constructor(work: () => WorkRegistry) {
		this.work = work;
	}

	/**
	 * Bind the kinds of a runner generation, whose extensions have distinct
	 * ids. Clear the previous generation's kinds first. Returns the declared
	 * kinds it refused.
	 */
	bind(declared: readonly DeclaredWorkKind[]): WorkKindRefusal[] {
		this.refused = new Set();
		return this.sync(declared);
	}

	/** Register the declared kinds not registered yet. Returns the ones it refused, each once. */
	sync(declared: readonly DeclaredWorkKind[]): WorkKindRefusal[] {
		const refusals: WorkKindRefusal[] = [];
		for (const { extensionId, name, kind } of declared) {
			const owned = this.kinds.get(extensionId) ?? new Map<string, OwnedKind>();
			const key = `${extensionId}\u0000${name}`;
			if (owned.has(name) || this.refused.has(key)) continue;
			const workKind: WorkKind = `ext:${extensionId}/${name}`;
			try {
				// The registry refuses a kind that is not `ext:<extension id>/<name>`.
				const remove = this.work().register({
					kind: workKind,
					delivery: kind.delivery ?? "none",
					cancellable: kind.cancellable ?? true,
					...(kind.cancelOnAbort === false ? { cancelOnAbort: false as const } : {}),
					...(kind.requires === undefined || kind.requires.length === 0 ? {} : { requires: kind.requires }),
					maxActive: kind.maxActive ?? 1,
					title: () => name,
					...(kind.detail === undefined ? {} : { detail: this.detailOf(extensionId, kind.detail) }),
				});
				owned.set(name, { kind: workKind, remove });
				this.kinds.set(extensionId, owned);
			} catch (refusal) {
				this.refused.add(key);
				refusals.push({ extensionId, error: refusal instanceof Error ? refusal.message : String(refusal) });
			}
		}
		return refusals;
	}

	/** The detail an extension kind presents, normalized under the extension's action policy and bounded. */
	private detailOf(extensionId: string, present: WorkDetailPresenter): (work: WorkDetailInput) => UiNode | undefined {
		return (work) => {
			// The presenter sees a copy: what it changes never reaches the work record.
			const detail = present(structuredClone(work));
			refuseThenable(detail);
			return normalizeUiNode(detail, {
				policy: { owner: "extension", extensionId, ownsWork: (workId) => this.owns(extensionId, workId) },
				maxBytes: EXTENSION_DETAIL_MAX_BYTES,
			});
		};
	}

	/** Whether work `workId` is of a kind of the extension with manifest id `extensionId`. */
	owns(extensionId: string, workId: string): boolean {
		return this.work().get(workId)?.kind.startsWith(`ext:${extensionId}/`) === true;
	}

	/**
	 * Remove the kinds of the extension with manifest id `extensionId`, which
	 * was disabled: their open work is cancelled, waited for up to `graceMs`,
	 * then finished `cancelled`. Resolves once that work finished.
	 */
	retire(extensionId: string, graceMs = EXTENSION_DISABLE_GRACE_MS): Promise<void> {
		const owned = this.kinds.get(extensionId);
		this.kinds.delete(extensionId);
		for (const key of [...this.refused]) if (key.startsWith(`${extensionId}\u0000`)) this.refused.delete(key);
		const error = `Extension ${extensionId} was disabled`;
		return Promise.all([...(owned?.values() ?? [])].map((kind) => kind.remove({ graceMs, error }))).then(
			() => undefined,
		);
	}

	/** Remove every kind, interrupting the work they run. Resolves once that work finished. */
	clear(): Promise<void> {
		const removed = [...this.kinds.values()];
		// Emptied first: an abort listener that registers a kind registers it anew.
		this.kinds = new Map();
		return Promise.all(removed.flatMap((owned) => [...owned.values()].map((kind) => kind.remove()))).then(
			() => undefined,
		);
	}

	/**
	 * Start work of kind `name` for the extension whose manifest id is `owner`,
	 * as `ctx.startWork` does: only that extension's kinds are found.
	 */
	readonly start: StartWorkHandler = async (owner, name, options, run) => {
		if (owner === undefined) {
			throw new Error("ctx.startWork is available only in an extension's own handlers, commands, and tools");
		}
		const owned = typeof name === "string" ? this.kinds.get(owner)?.get(name) : undefined;
		if (!owned) {
			throw new Error(`Unknown work kind ${JSON.stringify(name)}: register it with volt.registerWorkKind first`);
		}
		if (!isRecord(options) || typeof options.title !== "string") {
			throw new TypeError("ctx.startWork needs { title } and, optionally, a JSON input");
		}
		if (typeof run !== "function") throw new TypeError("ctx.startWork needs a function that runs the work");
		const input = options.input === undefined ? null : cloneCanonicalData(options.input, "Work input");
		const record = await this.work().start(owned.kind, input, (ctx) => this.execute(ctx, run), {
			title: options.title,
		});
		return { workId: record.workId };
	};

	/** Run extension work with the narrowed context. */
	private async execute(ctx: WorkContext, run: WorkRun): Promise<WorkExecution> {
		const reporter: WorkRunContext = Object.freeze({
			workId: ctx.workId,
			signal: ctx.signal,
			progress: (progress: WorkProgress) => {
				const kept = keptProgress(progress);
				if (kept) ctx.progress(kept);
			},
			checkpoint: (progress: WorkProgress) => {
				const kept = keptProgress(progress);
				if (kept) ctx.checkpoint(kept);
			},
			output: (text: string) => {
				if (typeof text === "string") ctx.output(text);
			},
		});
		return ownedExecution(await run(reporter));
	}
}
