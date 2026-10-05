/**
 * The work kinds a session's extensions declare (RFC §7.2, `ext:<id>/<kind>`),
 * registered in the conversation's work registry, and the work they start.
 *
 * An extension's id is provisional until extensions declare manifest ids
 * (RFC §8.1): a slug of its path, the directory's name for an index file. The
 * first extension in load order with an id owns it; another extension with
 * the same id registers no kinds. An extension starts only its own kinds:
 * `ctx.startWork` finds a kind by name among the kinds of the extension the
 * context belongs to, and a name never spells another extension's or a
 * built-in kind.
 *
 * A runner generation's kinds are removed when the extensions reload, which
 * interrupts the work they run: what its executors return or report
 * afterwards no longer counts (WorkRegistry.register). Extension kinds do not
 * resume, so a restart interrupts their open work too.
 *
 * An executor sees the work id, an abort signal, progress, checkpoints, and
 * output; never the host, its clients, or the session. Its result keeps a
 * summary, output, data, and the notice's own text; never a child
 * conversation.
 */

import { basename, dirname, parse } from "node:path";
import type { JsonValue } from "@hansjm10/volt-ai";
import {
	REMOTE_CAPABILITIES,
	type RemoteCapability,
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
import { type WorkContext, type WorkExecution, type WorkRegistry, workText } from "./registry.ts";

/** A kind's name within its extension. */
const WORK_KIND_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Most kinds one extension declares. */
export const EXTENSION_KINDS_MAX = 16;

/** Most items of one extension kind running at once. */
export const EXTENSION_KIND_MAX_ACTIVE = 8;

/** Most steps extension progress keeps. */
const PROGRESS_STEPS_MAX = 64;

const DELIVERIES: ReadonlySet<string> = new Set(["none", "message", "wake"]);
const CAPABILITIES: ReadonlySet<string> = new Set(REMOTE_CAPABILITIES);
const STEP_STATUSES: ReadonlySet<string> = new Set(["pending", "active", "done", "failed", "skipped"]);
/** Directories an index file's extension is not named after. */
const BUILD_DIRECTORIES: ReadonlySet<string> = new Set(["src", "dist", "lib"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCapability(value: unknown): value is RemoteCapability {
	return typeof value === "string" && CAPABILITIES.has(value);
}

/**
 * An extension's provisional id: a slug of its path's name, the directory's
 * for an index file (past `src`, `dist`, and `lib`). `<inline:1>` is `inline-1`.
 */
export function provisionalExtensionId(extensionPath: string): string {
	let name: string;
	if (extensionPath.startsWith("<")) {
		name = extensionPath.replace(/^<|>$/g, "");
	} else {
		const parsed = parse(extensionPath);
		name = parsed.name;
		let directory = parsed.dir;
		if (name === "index") {
			name = basename(directory);
			while (BUILD_DIRECTORIES.has(name)) {
				directory = dirname(directory);
				name = basename(directory);
			}
		}
	}
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+/, "")
		.slice(0, 64)
		.replace(/-+$/, "");
	return slug.length > 0 ? slug : "extension";
}

/** The declaration of kind `name`, checked and copied; throws what an extension author must fix. */
export function validateWorkKind(name: unknown, kind: unknown = {}): WorkKindDeclaration {
	if (typeof name !== "string" || !WORK_KIND_NAME_PATTERN.test(name)) {
		throw new Error(
			`Invalid work kind name ${JSON.stringify(name)}: use at most 64 lowercase letters, digits, "-", and "_", starting with a letter or digit`,
		);
	}
	if (!isRecord(kind)) throw new TypeError(`Work kind ${name} must be declared as an object`);
	const { delivery = "none", cancellable = true, cancelOnAbort, maxActive = 1, requires = [] } = kind;
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
	if (!Array.isArray(requires) || !requires.every(isCapability)) {
		throw new TypeError(`Work kind ${name}: requires must list remote capabilities`);
	}
	return Object.freeze({
		delivery: delivery as WorkKindDeclaration["delivery"],
		cancellable,
		...(cancelOnAbort === false ? { cancelOnAbort } : {}),
		maxActive,
		requires: Object.freeze([...new Set(requires)]),
	});
}

/** Progress a client can render: text without control sequences, finite numbers, and well-formed steps. */
function keptProgress(progress: unknown): WorkProgress | undefined {
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
	readonly extensionPath: string;
	readonly name: string;
	readonly kind: WorkKindDeclaration;
}

/** A declared kind the host did not register, and why. */
export interface WorkKindRefusal {
	readonly extensionPath: string;
	readonly error: string;
}

/** Owns `ctx.startWork`: starts work of `name` for the extension at `owner`. */
export type StartWorkHandler = (
	owner: string | undefined,
	name: string,
	options: StartWorkOptions,
	run: WorkRun,
) => Promise<{ readonly workId: string }>;

interface OwnedKind {
	readonly kind: WorkKind;
	readonly remove: () => Promise<void>;
}

/** The extension kinds registered in one conversation's work registry. */
export class ExtensionKinds {
	private readonly work: () => WorkRegistry;
	/** Extension ids, each owned by the first extension in load order with it. */
	private owners = new Map<string, string>();
	/** The registered kinds, by extension path, then name. */
	private kinds = new Map<string, Map<string, OwnedKind>>();
	/** Declared kinds already refused, so each is reported once. */
	private refused = new Set<string>();

	constructor(work: () => WorkRegistry) {
		this.work = work;
	}

	/**
	 * Bind the kinds of a runner generation whose extensions are
	 * `extensionPaths` in load order. Clear the previous generation's kinds
	 * first. Returns the declared kinds it refused.
	 */
	bind(extensionPaths: readonly string[], declared: readonly DeclaredWorkKind[]): WorkKindRefusal[] {
		this.owners = new Map();
		this.refused = new Set();
		for (const extensionPath of extensionPaths) {
			const id = provisionalExtensionId(extensionPath);
			if (!this.owners.has(id)) this.owners.set(id, extensionPath);
		}
		return this.sync(declared);
	}

	/** Register the declared kinds not registered yet. Returns the ones it refused, each once. */
	sync(declared: readonly DeclaredWorkKind[]): WorkKindRefusal[] {
		const refusals: WorkKindRefusal[] = [];
		for (const { extensionPath, name, kind } of declared) {
			const owned = this.kinds.get(extensionPath) ?? new Map<string, OwnedKind>();
			const key = `${extensionPath}\u0000${name}`;
			if (owned.has(name) || this.refused.has(key)) continue;
			const id = provisionalExtensionId(extensionPath);
			const owner = this.owners.get(id);
			const workKind: WorkKind = `ext:${id}/${name}`;
			let error: string | undefined;
			if (owner !== extensionPath) {
				error = `Work kind ${workKind} is not registered: the extension id ${id} belongs to ${owner ?? "another extension"}`;
			} else {
				try {
					const remove = this.work().register({
						kind: workKind,
						delivery: kind.delivery ?? "none",
						cancellable: kind.cancellable ?? true,
						...(kind.cancelOnAbort === false ? { cancelOnAbort: false as const } : {}),
						...(kind.requires === undefined || kind.requires.length === 0 ? {} : { requires: kind.requires }),
						maxActive: kind.maxActive ?? 1,
						title: () => name,
					});
					owned.set(name, { kind: workKind, remove });
					this.kinds.set(extensionPath, owned);
				} catch (refusal) {
					error = refusal instanceof Error ? refusal.message : String(refusal);
				}
			}
			if (error !== undefined) {
				this.refused.add(key);
				refusals.push({ extensionPath, error });
			}
		}
		return refusals;
	}

	/** Remove every kind, interrupting the work they run. Resolves once that work finished. */
	clear(): Promise<void> {
		const removals = [...this.kinds.values()].flatMap((owned) => [...owned.values()].map((kind) => kind.remove()));
		this.kinds = new Map();
		return Promise.all(removals).then(() => undefined);
	}

	/**
	 * Start work of kind `name` for the extension at `owner`, as `ctx.startWork`
	 * does: only that extension's kinds are found.
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
