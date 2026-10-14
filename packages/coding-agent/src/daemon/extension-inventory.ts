/**
 * The daemon's extension inventories: what a new conversation in a workspace
 * root would load (its extensions and the review engines they register),
 * answered for paired devices before any conversation exists.
 *
 * The daemon runs no extension code, so an inventory is evaluated in a
 * process of its own (`volt daemon extension-inventory`, through the worker
 * launcher) that loads the root's extensions as a phone conversation there
 * would (`worker/extension-inventory.ts`) and writes the result as JSON.
 *
 * Evaluations are kept per root, trust decision, and profile (and workspace
 * generation, so an unregistered workspace's never answer its successor).
 * Each reports the files and directories it read (settings, permission
 * acknowledgments, the extension directories, each extension's source); a
 * kept one answers while none of them changed (by lstat) and it is younger
 * than {@link EXTENSION_INVENTORY_MAX_AGE_MS}. An evaluation that left out a
 * package that is not installed is not kept: a conversation would install it.
 * Concurrent requests for one key share one process, at most
 * {@link EXTENSION_INVENTORY_MAX_CONCURRENT} processes run at once, each is
 * killed past {@link EXTENSION_INVENTORY_TIMEOUT_MS}, and a request whose
 * caller leaves stops waiting without stopping the evaluation others share.
 */

import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { ExtensionSummarySchema, RpcReviewEngineSchema } from "@hansjm10/volt-protocol";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import type { ExtensionInventory } from "../core/extensions/inventory.ts";
import type { ExtensionInventoryLaunchRequest, LaunchedExtensionInventory } from "./worker-launcher.ts";

const closed = { additionalProperties: false } as const;

/** What an extension inventory process writes on fd 3: its evaluation, or why it failed. */
export const ExtensionInventoryProbeOutputSchema = Type.Union([
	Type.Object(
		{
			ok: Type.Literal(true),
			projectTrusted: Type.Boolean(),
			extensions: Type.Array(ExtensionSummarySchema),
			reviewEngines: Type.Array(RpcReviewEngineSchema, { maxItems: 128 }),
			inputs: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 512 }),
			cacheable: Type.Boolean(),
		},
		closed,
	),
	Type.Object({ ok: Type.Literal(false), error: Type.String({ maxLength: 2000 }) }, closed),
]);
export type ExtensionInventoryProbeOutput = Static<typeof ExtensionInventoryProbeOutputSchema>;

/** How long an evaluation may run before its process is killed. */
export const EXTENSION_INVENTORY_TIMEOUT_MS = 20_000;
/** How long a kept evaluation answers at most, even when nothing it read changed. */
export const EXTENSION_INVENTORY_MAX_AGE_MS = 10 * 60_000;
/** Most evaluations kept; the least recently used goes first. */
export const EXTENSION_INVENTORY_MAX_ENTRIES = 32;
/** Most evaluation processes at once; more wait their turn. */
export const EXTENSION_INVENTORY_MAX_CONCURRENT = 2;
/**
 * How long before an evaluation starts a change to one of its inputs still counts as made during it. File
 * timestamps are coarse (a few milliseconds behind the clock on Linux, whole seconds on some file systems), so a
 * change made as the evaluation began can carry an earlier time.
 */
export const EXTENSION_INVENTORY_SETTLE_MS = 2_000;

/** What an inventory is evaluated for: a conversation opened in `root` with this trust and profile. */
export interface ExtensionInventoryTarget {
	readonly workspaceName: string;
	readonly workspaceGeneration: number;
	/** The workspace path, or a worktree checkout of it. */
	readonly root: string;
	readonly projectTrusted: boolean;
	readonly profile?: string;
}

export interface ExtensionInventoryServiceOptions {
	readonly agentDir: string;
	readonly launch: (request: ExtensionInventoryLaunchRequest) => LaunchedExtensionInventory;
	readonly log?: (message: string) => void;
	/** The clock kept evaluations age by; `Date.now` by default. */
	readonly now?: () => number;
	readonly timeoutMs?: number;
	readonly maxAgeMs?: number;
	readonly maxEntries?: number;
	readonly maxConcurrent?: number;
	readonly settleMs?: number;
}

/** A failed evaluation; its message is for the host's log, not a device. */
export class ExtensionInventoryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ExtensionInventoryError";
	}
}

interface KeptInventory {
	readonly inventory: ExtensionInventory;
	/** Each input's lstat stamp when the evaluation finished. */
	readonly stamps: ReadonlyMap<string, string>;
	readonly keptAt: number;
}

function compileProbeOutput() {
	return Compile(ExtensionInventoryProbeOutputSchema);
}
let probeOutputValidator: ReturnType<typeof compileProbeOutput> | undefined;

/** What lstat says of `path`: enough to tell a change, or that it is absent. */
function stamp(path: string): string {
	try {
		const stats = lstatSync(path, { bigint: true });
		return `${stats.mtimeNs}:${stats.ctimeNs}:${stats.size}:${stats.ino}`;
	} catch {
		return "absent";
	}
}

/** When `path` last changed, in ms; undefined when absent. */
function changedAtMs(path: string): number | undefined {
	try {
		const stats = lstatSync(path);
		return Math.max(stats.mtimeMs, stats.ctimeMs);
	} catch {
		return undefined;
	}
}

export class ExtensionInventoryService {
	private readonly options: ExtensionInventoryServiceOptions;
	private readonly kept = new Map<string, KeptInventory>();
	private readonly evaluating = new Map<string, Promise<ExtensionInventory>>();
	private readonly running = new Set<LaunchedExtensionInventory>();
	/** Evaluations waiting for a free process slot, in arrival order. */
	private readonly waiting: Array<{ start: () => void; fail: (error: Error) => void }> = [];
	private active = 0;
	private disposed = false;

	constructor(options: ExtensionInventoryServiceOptions) {
		this.options = options;
	}

	/**
	 * The inventory of a conversation opened at `target`: a kept evaluation while nothing it read changed,
	 * else a new one, shared with concurrent requests for the same target. `signal` stops this caller waiting.
	 */
	async get(target: ExtensionInventoryTarget, signal?: AbortSignal): Promise<ExtensionInventory> {
		signal?.throwIfAborted();
		if (this.disposed) throw new ExtensionInventoryError("The daemon is shutting down");
		let root: string;
		try {
			root = realpathSync(target.root);
		} catch {
			throw new ExtensionInventoryError(`The root ${target.root} is unavailable`);
		}
		const key = JSON.stringify([
			target.workspaceName,
			target.workspaceGeneration,
			root,
			target.projectTrusted,
			target.profile ?? null,
		]);
		const kept = this.kept.get(key);
		if (kept) {
			if (this.fresh(kept)) {
				this.kept.delete(key);
				this.kept.set(key, kept);
				return kept.inventory;
			}
			this.kept.delete(key);
		}
		let evaluation = this.evaluating.get(key);
		if (!evaluation) {
			evaluation = this.evaluate(key, { ...target, root }).finally(() => this.evaluating.delete(key));
			// A caller that leaves does not leave the rejection unhandled.
			evaluation.catch(() => undefined);
			this.evaluating.set(key, evaluation);
		}
		return signal === undefined ? evaluation : abortable(evaluation, signal);
	}

	/** Kill every running evaluation, fail every waiting one, and keep nothing. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const launched of this.running) launched.kill();
		for (const waiter of this.waiting.splice(0))
			waiter.fail(new ExtensionInventoryError("The daemon is shutting down"));
		this.kept.clear();
	}

	private fresh(kept: KeptInventory): boolean {
		if (this.now() - kept.keptAt >= (this.options.maxAgeMs ?? EXTENSION_INVENTORY_MAX_AGE_MS)) return false;
		for (const [path, recorded] of kept.stamps) if (stamp(path) !== recorded) return false;
		return true;
	}

	private now(): number {
		return (this.options.now ?? Date.now)();
	}

	private async evaluate(key: string, target: ExtensionInventoryTarget): Promise<ExtensionInventory> {
		await this.acquire();
		const startedAt = Date.now();
		let outcome = "failed";
		try {
			if (this.disposed) throw new ExtensionInventoryError("The daemon is shutting down");
			const output = await this.run(target);
			const inventory: ExtensionInventory = {
				projectTrusted: output.projectTrusted,
				extensions: output.extensions,
				reviewEngines: output.reviewEngines,
			};
			// An input that changed as it was read may not be what it read: not kept, the next request evaluates again.
			const settledBefore = startedAt - (this.options.settleMs ?? EXTENSION_INVENTORY_SETTLE_MS);
			const unsettled = output.inputs.some((path) => (changedAtMs(path) ?? 0) >= settledBefore);
			if (output.cacheable && !unsettled && !this.disposed) {
				this.kept.set(key, {
					inventory,
					stamps: new Map(output.inputs.map((path) => [path, stamp(path)])),
					keptAt: this.now(),
				});
				while (this.kept.size > (this.options.maxEntries ?? EXTENSION_INVENTORY_MAX_ENTRIES)) {
					const oldest = this.kept.keys().next().value;
					if (oldest === undefined) break;
					this.kept.delete(oldest);
				}
				outcome = "kept";
			} else {
				outcome = "not kept";
			}
			return inventory;
		} catch (error) {
			outcome = `failed: ${error instanceof Error ? error.message : String(error)}`;
			throw error;
		} finally {
			this.release();
			this.options.log?.(
				`extension inventory of ${target.workspaceName} (${target.root}): ${outcome} in ${Date.now() - startedAt} ms`,
			);
		}
	}

	/** Run one evaluation process, killed past the timeout. */
	private async run(target: ExtensionInventoryTarget): Promise<Extract<ExtensionInventoryProbeOutput, { ok: true }>> {
		const launched = this.options.launch({
			id: randomUUID(),
			agentDir: this.options.agentDir,
			root: target.root,
			projectTrusted: target.projectTrusted,
			...(target.profile === undefined ? {} : { profile: target.profile }),
		});
		this.running.add(launched);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeoutMs = this.options.timeoutMs ?? EXTENSION_INVENTORY_TIMEOUT_MS;
		const timedOut = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				// Settled first, so the evaluation fails as timed out rather than as killed.
				reject(new ExtensionInventoryError(`The evaluation took longer than ${timeoutMs} ms`));
				launched.kill();
			}, timeoutMs);
			timer.unref?.();
		});
		let output: unknown;
		try {
			output = await Promise.race([launched.result, timedOut]);
		} catch (error) {
			throw error instanceof ExtensionInventoryError
				? error
				: new ExtensionInventoryError(error instanceof Error ? error.message : String(error));
		} finally {
			clearTimeout(timer);
			this.running.delete(launched);
			launched.result.catch(() => undefined);
		}
		probeOutputValidator ??= compileProbeOutput();
		if (!probeOutputValidator.Check(output))
			throw new ExtensionInventoryError("The evaluation wrote an invalid result");
		if (!output.ok) throw new ExtensionInventoryError(output.error);
		return output;
	}

	private acquire(): Promise<void> {
		if (this.active < (this.options.maxConcurrent ?? EXTENSION_INVENTORY_MAX_CONCURRENT)) {
			this.active++;
			return Promise.resolve();
		}
		return new Promise((resolve, reject) => {
			this.waiting.push({
				start: () => {
					this.active++;
					resolve();
				},
				fail: reject,
			});
		});
	}

	private release(): void {
		this.active--;
		this.waiting.shift()?.start();
	}
}

/** `promise`, or a rejection once `signal` aborts first. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted();
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}
