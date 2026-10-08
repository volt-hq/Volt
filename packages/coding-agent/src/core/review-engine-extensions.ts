/**
 * The review engines a session's extensions register (`volt.registerReviewEngine`), kept in the session's
 * {@link ReviewEngineRegistry} while their runner generation is current.
 *
 * What an extension's engine reports reaches clients bounded and normalized: progress is read as the plain
 * data work progress is, detail (UI data) goes through the extension's action policy, where `open_work` and
 * `cancel_work` are allowed only for the extension's own reviews, and the size of detail is capped. An
 * extension's reviews are cancelled when the extension is disabled or its generation is replaced: each is
 * aborted and waited for up to {@link EXTENSION_DISABLE_GRACE_MS}, so none runs on after its engine is gone.
 */

import type { UiNode, WorkProgress } from "@hansjm10/volt-protocol";
import type { ReviewEngineContext, ReviewEngineDeclaration, ReviewEngineRegistry } from "./review-engine.ts";
import { normalizeUiNode } from "./ui/normalize.ts";
import { refuseThenable } from "./ui/presentation.ts";
import { EXTENSION_DETAIL_MAX_BYTES, EXTENSION_DISABLE_GRACE_MS, keptProgress } from "./work/extension-kinds.ts";
import type { WorkRegistry } from "./work/registry.ts";

/** An engine an extension registered, as its runner lists them in load order. */
export interface DeclaredReviewEngine {
	/** The manifest id of the extension that registered it. */
	readonly extensionId: string;
	readonly name: string;
	readonly engine: ReviewEngineDeclaration;
}

/** A registered engine the host did not take, and why. */
export interface ReviewEngineRefusal {
	readonly extensionId: string;
	readonly error: string;
}

export class ExtensionReviewEngines {
	private readonly registry: ReviewEngineRegistry;
	private readonly work: () => WorkRegistry;
	/** The engines taken into the registry, by extension id, then name. */
	private owned = new Map<string, Map<string, () => void>>();
	/** The work ids of the reviews each extension's engines are running. */
	private readonly running = new Map<string, Set<string>>();
	/** Declared engines already refused, so each is reported once. */
	private refused = new Set<string>();

	constructor(registry: ReviewEngineRegistry, work: () => WorkRegistry) {
		this.registry = registry;
		this.work = work;
	}

	/**
	 * Take the engines of a runner generation, whose extensions have distinct ids. Clear the previous
	 * generation's engines first. Returns the declared engines it refused.
	 */
	bind(declared: readonly DeclaredReviewEngine[]): ReviewEngineRefusal[] {
		this.refused = new Set();
		return this.sync(declared);
	}

	/** Take the declared engines not taken yet. Returns the ones it refused, each once. */
	sync(declared: readonly DeclaredReviewEngine[]): ReviewEngineRefusal[] {
		const refusals: ReviewEngineRefusal[] = [];
		for (const { extensionId, name, engine } of declared) {
			const owned = this.owned.get(extensionId) ?? new Map<string, () => void>();
			const key = `${extensionId}\u0000${name}`;
			if (owned.has(name) || this.refused.has(key)) continue;
			try {
				owned.set(name, this.registry.register(this.wrap(extensionId, engine)));
				this.owned.set(extensionId, owned);
			} catch (refusal) {
				this.refused.add(key);
				refusals.push({ extensionId, error: refusal instanceof Error ? refusal.message : String(refusal) });
			}
		}
		return refusals;
	}

	/** Whether review `workId` is a run of an engine of the extension with manifest id `extensionId`. */
	owns(extensionId: string, workId: string): boolean {
		return this.running.get(extensionId)?.has(workId) === true;
	}

	/**
	 * Remove the engines of the extension with manifest id `extensionId`, which was disabled, and cancel the
	 * reviews they run, waiting up to `graceMs` for them to stop.
	 */
	async retire(extensionId: string, graceMs = EXTENSION_DISABLE_GRACE_MS): Promise<void> {
		for (const remove of this.owned.get(extensionId)?.values() ?? []) remove();
		this.owned.delete(extensionId);
		for (const key of [...this.refused]) if (key.startsWith(`${extensionId}\u0000`)) this.refused.delete(key);
		await this.stop([extensionId], graceMs);
	}

	/** Remove every engine and cancel the reviews they run. */
	async clear(graceMs = EXTENSION_DISABLE_GRACE_MS): Promise<void> {
		const extensions = [...this.owned.keys()];
		for (const owned of this.owned.values()) for (const remove of owned.values()) remove();
		// Emptied first: a run that registers an engine registers it anew.
		this.owned = new Map();
		await this.stop(extensions, graceMs);
	}

	private async stop(extensionIds: readonly string[], graceMs: number): Promise<void> {
		const workIds = extensionIds.flatMap((id) => [...(this.running.get(id) ?? [])]);
		if (workIds.length === 0) return;
		const work = this.work();
		await Promise.all(workIds.map((workId) => work.cancel(workId).catch(() => undefined)));
		let timer: ReturnType<typeof setTimeout> | undefined;
		const grace = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, graceMs);
		});
		try {
			await Promise.race([Promise.all(workIds.map((workId) => work.settled(workId).catch(() => undefined))), grace]);
		} finally {
			clearTimeout(timer);
		}
	}

	/** The engine as the host runs it: what the extension reports is read as data and bounded, and its reviews are tracked. */
	private wrap(extensionId: string, engine: ReviewEngineDeclaration): ReviewEngineDeclaration {
		const report =
			(channel: (progress: WorkProgress, detail?: UiNode) => void) =>
			(progress: WorkProgress, detail?: UiNode): void => {
				const kept = keptProgress(progress);
				if (!kept) return;
				let node: UiNode | undefined;
				if (detail !== undefined) {
					try {
						refuseThenable(detail);
						node = normalizeUiNode(detail, {
							policy: { owner: "extension", extensionId, ownsWork: (workId) => this.owns(extensionId, workId) },
							maxBytes: EXTENSION_DETAIL_MAX_BYTES,
						});
					} catch {
						// Detail that is not valid UI data is dropped; the progress stays.
					}
				}
				channel(kept, node);
			};
		return {
			...engine,
			run: async (ctx: ReviewEngineContext): Promise<void> => {
				const running = this.running.get(extensionId) ?? new Set<string>();
				this.running.set(extensionId, running);
				running.add(ctx.workId);
				try {
					await engine.run(
						Object.freeze({
							...ctx,
							progress: report(ctx.progress),
							checkpoint: report(ctx.checkpoint),
							output: (text: string) => {
								if (typeof text === "string") ctx.output(text);
							},
						}),
					);
				} finally {
					running.delete(ctx.workId);
				}
			},
		};
	}
}
