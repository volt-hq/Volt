/**
 * The extensions of one conversation and their runtime toggle (RFC §8.2; Q10:
 * one instance per conversation).
 *
 * The registry keeps a record per extension that owns its manifest id in the
 * conversation, in load order: `active` (its instance runs), `disabled`
 * (settings disable it, and nothing of it runs), `failed` (it failed to load
 * or activate), and `activating` or `deactivating` while it changes. Settings
 * decide which extensions run (`extensions.<id>.enabled`, true by default);
 * `reconcile` brings the records in line with them, one change at a time.
 *
 * Enabling runs a new instance: a package's entry is imported and the factory
 * runs into the conversation's runtime. Its contributions join the
 * conversation at once (hooks, commands, intents, shortcuts, completion
 * providers, providers, and work kinds; its tools are offered from the next
 * request), then `activate{enable}` and `session_start{enable}` reach it,
 * once the conversation's extensions are bound.
 *
 * Disabling stops the instance: its contributions leave the active set at
 * once, so no hook, command, intent, shortcut, completion provider, renderer,
 * or presenter of it runs again, and the next request no longer offers its
 * tools. `session_shutdown{disable}` and `deactivate{disable}` reach it alone
 * (for at most {@link EXTENSION_STOP_TIMEOUT_MS}); then its UI goes (status
 * items, panels, its title, its pending dialogs, and its terminal UI), its
 * providers are unregistered, its managed-services tasks are cancelled, and
 * its work is cancelled (waited for up to 10 seconds, then finished
 * `cancelled`). Its tools leave at the next turn boundary: the instance
 * retires once the running turn ended and its tool calls settled. A retired
 * instance's `volt` and contexts throw, and its event-bus listeners are gone.
 *
 * Contributions live on the instance's record as it registers them, and the
 * runner reads them from the active records only: a kind of contribution
 * added later is removed with its record without more work here.
 *
 * Reloading replaces every record: the binding stops the generation
 * (`session_shutdown{reload}`, `deactivate{reload}`), and `reset` takes the
 * next one. `rescan` picks up extensions installed or removed since, without
 * a reload.
 */

import {
	EXTENSION_ERROR_MAX_CHARS,
	type ExtensionState,
	type ExtensionSummary,
	UI_NODE_LINE_PATTERN,
} from "@hansjm10/volt-protocol";
import type { SourceScope } from "../source-info.ts";
import { stripTerminalControls } from "../ui/ansi-tokens.ts";
import type { ExtensionManifest } from "./manifest.ts";
import {
	type ExtensionPermissionStore,
	type PermissionAcknowledgment,
	permissionSubject,
	reviewPermissions,
} from "./permissions.ts";
import type { ExtensionRunner } from "./runner.ts";
import type { Extension, ExtensionDeclaration, ExtensionError, LoadExtensionsResult } from "./types.ts";

/** How long an extension's `session_shutdown` and `deactivate` handlers may run when it is disabled. */
export const EXTENSION_STOP_TIMEOUT_MS = 10_000;

/** What the registry acts through: the conversation the extensions run in. */
export interface ExtensionRegistryHost {
	/** The runner of the conversation's extensions. */
	runner(): ExtensionRunner;
	/** Whether settings enable the extension `id`. */
	enabled(id: string): boolean;
	/**
	 * Whether the user acknowledged what `extension` declares it does
	 * (permissions bound to its fingerprint): enabling one at runtime needs it.
	 */
	acknowledged(extension: DeclaredExtensionInfo): boolean;
	/** Whether the conversation's extensions are bound: an extension enabled now hears `activate` and `session_start`. */
	bound(): boolean;
	/**
	 * The active extensions changed: register the work kinds they declare,
	 * rebuild the tools (the next request offers the active ones), and tell
	 * the clients (commands, intents, shortcuts, and the extension list).
	 */
	changed(): void;
	/** The extensions' states changed without changing what runs: tell the clients. */
	statesChanged(): void;
	/**
	 * Remove what the stopped extension `id` declared outside its record: its
	 * live UI and pending dialogs, its terminal UI, its managed-services tasks,
	 * and its providers (`extension.providers`).
	 */
	retireDeclarations(extension: Extension): void;
	/** Remove the work kinds of `id`, cancelling their work. Resolves once that work finished. */
	retireWork(id: string): Promise<void>;
	/** Resolves at the next turn boundary: at once when no turn runs. */
	turnBoundary(): Promise<void>;
	/** Report an extension's failure to the clients. */
	reportError(error: ExtensionError): void;
	/**
	 * The extensions the current sources name besides `known` (resolved
	 * paths): declared, none of them run; and every current source's resolved
	 * path. Undefined when the conversation's resources cannot be rescanned.
	 */
	rescan?(known: readonly { readonly id: string; readonly path: string; readonly resolvedPath: string }[]): Promise<{
		declarations: ExtensionDeclaration[];
		present: ReadonlySet<string>;
		errors: LoadExtensionsResult["errors"];
	}>;
}

/** One extension of the conversation. */
interface ExtensionRecord {
	readonly id: string;
	/** How a new instance is loaded; absent for an extension given already loaded, which runs until it is disabled. */
	declaration: ExtensionDeclaration | undefined;
	/** The running instance. */
	instance: Extension | undefined;
	state: ExtensionState;
	error: string | undefined;
	/** The stopped instance's retirement: it waits for the turn boundary and the instance's tool calls. */
	retiring: Promise<void> | undefined;
	/** Its source is gone (a rescan found it removed): the record goes once the extension stopped. */
	removed: boolean;
}

/** What an extension declares, whether or not it runs. */
export interface DeclaredExtensionInfo {
	readonly id: string;
	readonly manifest: ExtensionManifest;
	readonly version: string;
	readonly scope: SourceScope;
	readonly fingerprint: string;
	readonly state: ExtensionState;
}

const VERSION_LINE = new RegExp(UI_NODE_LINE_PATTERN);

/** Text a summary may carry: terminal controls removed, at most `max` characters. */
function summaryText(text: string, max: number): string {
	const plain = stripTerminalControls(text);
	return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

/** A failure's message. */
function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Resolves with `work`, or after `ms` without waiting further for it. */
async function bounded(work: Promise<unknown>, ms: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
	try {
		await Promise.race([work.then(() => undefined), timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

export class ExtensionRegistry {
	private readonly host: ExtensionRegistryHost;
	private records = new Map<string, ExtensionRecord>();
	private result: LoadExtensionsResult | undefined;
	/** Changes run one at a time; a change waits for the previous one to take effect. */
	private queue: Promise<void> = Promise.resolve();
	/** Bumped by `reset`: a change of an earlier generation stops where it is. */
	private generation = 0;
	private closed = false;

	constructor(host: ExtensionRegistryHost) {
		this.host = host;
	}

	/**
	 * Take a generation's extensions, as loading left them: each declared
	 * extension runs (`result.extensions`), is disabled, or failed to load.
	 * Records of an earlier generation are dropped; their instances belong to
	 * the earlier runtime.
	 */
	reset(result: LoadExtensionsResult): void {
		this.generation++;
		this.result = result;
		const running = new Map(result.extensions.map((extension) => [extension.id, extension]));
		const records = new Map<string, ExtensionRecord>();
		for (const declaration of result.declarations ?? []) {
			const instance = running.get(declaration.id);
			records.set(declaration.id, {
				id: declaration.id,
				declaration,
				instance,
				state: instance ? "active" : declaration.error !== undefined ? "failed" : "disabled",
				error: instance ? undefined : declaration.error,
				retiring: undefined,
				removed: false,
			});
		}
		for (const extension of result.extensions) {
			if (records.has(extension.id)) continue;
			records.set(extension.id, {
				id: extension.id,
				declaration: undefined,
				instance: extension,
				state: "active",
				error: undefined,
				retiring: undefined,
				removed: false,
			});
		}
		this.records = records;
	}

	/** Stop taking changes: the conversation closes. */
	close(): void {
		this.closed = true;
		this.generation++;
	}

	/** The active extensions, in load order. */
	active(): Extension[] {
		return [...this.records.values()].flatMap((record) => (record.instance ? [record.instance] : []));
	}

	/**
	 * Whether the extension `id` stopped running in the conversation, or is
	 * stopping: its UI shows nothing more. False for an id the conversation has
	 * none of.
	 */
	stopped(id: string): boolean {
		const state = this.records.get(id)?.state;
		return state === "deactivating" || state === "disabled" || state === "failed";
	}

	/** The running instance of the extension `id`, if it runs. */
	instance(id: string): Extension | undefined {
		return this.records.get(id)?.instance;
	}

	/** What the extension `id` declares, whether or not it runs; undefined for an id the conversation has none of. */
	get(id: string): DeclaredExtensionInfo | undefined {
		const record = this.records.get(id);
		const source = record?.instance ?? record?.declaration;
		if (!record || !source) return undefined;
		return {
			id,
			manifest: source.manifest,
			version: source.version,
			scope: source.sourceInfo.scope,
			fingerprint: source.fingerprint,
			state: record.state,
		};
	}

	/** Every extension of the conversation as the `extensions` query lists it. */
	summaries(permissions: ExtensionPermissionStore): ExtensionSummary[] {
		let acknowledgments: ReadonlyMap<string, PermissionAcknowledgment> | undefined;
		try {
			acknowledgments = permissions.all();
		} catch {
			// An unreadable acknowledgment file acknowledges nothing.
			acknowledgments = undefined;
		}
		return [...this.records.keys()].flatMap((id) => {
			const info = this.get(id);
			const record = this.records.get(id);
			if (!info || !record) return [];
			const { manifest } = info;
			const subject = permissionSubject(info);
			const acknowledged =
				acknowledgments === undefined
					? subject.permissions.length === 0
					: reviewPermissions(subject, acknowledgments.get(id)).status === "acknowledged";
			const version = summaryText(info.version, 256).replace(/\s+/g, " ").trim();
			const summary: ExtensionSummary = {
				id,
				displayName: manifest.displayName,
				...(manifest.description === undefined ? {} : { description: manifest.description }),
				version: version.length > 0 && VERSION_LINE.test(version) ? version : "unknown",
				scope: info.scope,
				enabled: this.host.enabled(id),
				state: info.state,
				permissions: [...(manifest.permissions ?? [])],
				permissionsAcknowledged: acknowledged,
				hasSettings: Object.keys(manifest.settings?.properties ?? {}).length > 0,
				...(record.state === "failed" && record.error !== undefined
					? { error: summaryText(record.error, EXTENSION_ERROR_MAX_CHARS) }
					: {}),
			};
			return [summary];
		});
	}

	/**
	 * Bring the extensions in line with settings: enable the disabled ones
	 * settings enable, and disable the active ones they disable, one at a
	 * time; a failed one settings disable counts as disabled, so enabling it
	 * again tries it again. Resolves once each change took effect: an enabled
	 * extension runs (or failed), a disabled one's contributions are gone,
	 * while its instance retires at the next turn boundary.
	 */
	reconcile(): Promise<void> {
		return this.enqueue(async (generation) => {
			for (const record of [...this.records.values()]) {
				if (generation !== this.generation) return;
				if (this.records.get(record.id) !== record) continue;
				const wanted = this.host.enabled(record.id) && !record.removed;
				if (wanted && record.state === "disabled" && !record.retiring) {
					await this.enable(record, generation);
				} else if (!wanted && record.state === "active") {
					await this.disable(record, generation);
				} else if (!wanted && record.state === "failed") {
					record.state = "disabled";
					record.error = undefined;
					this.host.statesChanged();
				}
			}
		});
	}

	/** Try a failed extension that settings enable again. Resolves once it runs or failed again. */
	retry(id: string): Promise<void> {
		return this.enqueue(async (generation) => {
			const record = this.records.get(id);
			if (record?.state === "failed" && this.host.enabled(id) && !record.removed)
				await this.enable(record, generation);
		});
	}

	/**
	 * Pick up extensions installed or removed since the conversation loaded
	 * them: a new source's extension is declared (its manifest read; a single
	 * file from a trusted location is evaluated for it) and runs when settings
	 * enable it; a removed source's extension stops. Resolves once the changes
	 * took effect.
	 */
	rescan(): Promise<void> {
		const scan = this.host.rescan;
		if (!scan) return Promise.resolve();
		return this.enqueue(async (generation) => {
			const known = [...this.records.values()].flatMap((record) => {
				const source = record.declaration ?? record.instance;
				return source ? [{ id: record.id, path: source.path, resolvedPath: source.resolvedPath }] : [];
			});
			const { declarations, present, errors } = await scan.call(this.host, known);
			if (generation !== this.generation) return;
			for (const error of errors) {
				this.host.reportError({
					extensionId: "<runtime>",
					event: "rescan",
					error: `${error.path}: ${error.error}`,
				});
			}
			for (const record of [...this.records.values()]) {
				const source = record.declaration;
				// Extensions given loaded, and SDK extensions, have no source to lose.
				if (!source || source.path.startsWith("<") || present.has(source.resolvedPath)) continue;
				record.removed = true;
				// One that does not run goes now; a running one goes once it stopped.
				if ((record.state === "disabled" || record.state === "failed") && !record.retiring) {
					this.records.delete(record.id);
				}
			}
			for (const declaration of declarations) {
				if (this.records.has(declaration.id)) continue;
				this.records.set(declaration.id, {
					id: declaration.id,
					declaration,
					instance: undefined,
					state: "disabled",
					error: undefined,
					retiring: undefined,
					removed: false,
				});
			}
			this.host.statesChanged();
		}).then(() => this.reconcile());
	}

	/**
	 * Run `operation` exclusively, after the changes queued before it, such as
	 * a reload that replaces the generation.
	 */
	exclusive<T>(operation: () => Promise<T>): Promise<T> {
		const run = this.queue.then(operation, operation);
		this.queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/** Wait until every queued change took effect and every stopped instance retired. */
	async settled(): Promise<void> {
		await this.queue;
		for (;;) {
			const retiring = [...this.records.values()].flatMap((record) => (record.retiring ? [record.retiring] : []));
			if (retiring.length === 0) return;
			await Promise.all(retiring);
			await this.queue;
		}
	}

	/**
	 * Queue `change` against the records it finds when it runs: a change
	 * queued while a reload replaced the generation applies to the new one,
	 * since it reads the records and settings as they are then.
	 */
	private enqueue(change: (generation: number) => Promise<void>): Promise<void> {
		return this.exclusive(async () => {
			if (this.closed) return;
			await change(this.generation);
		});
	}

	/** Keep the generation's `extensions` the active ones, and the runner's active set. */
	private applyActive(): void {
		const active = this.active();
		this.host.runner().setExtensions(active);
		if (this.result) this.result.extensions = active;
	}

	private async enable(record: ExtensionRecord, generation: number): Promise<void> {
		const declaration = record.declaration;
		if (!declaration) {
			record.state = "failed";
			record.error = "It was loaded by its host and cannot run again until the extensions reload";
			this.host.statesChanged();
			return;
		}
		// Enabling at runtime runs only what the user acknowledged: settings name an id, not the code it runs.
		const info = this.get(record.id);
		if (info && !this.host.acknowledged(info)) {
			record.state = "failed";
			record.error = "Its permissions are not acknowledged; enable it from a client that can acknowledge them";
			this.host.statesChanged();
			return;
		}
		record.state = "activating";
		record.error = undefined;
		this.host.statesChanged();
		let instance: Extension;
		try {
			instance = await declaration.load();
		} catch (error) {
			if (generation !== this.generation) return;
			record.state = "failed";
			record.error = `Failed to load extension: ${message(error)}`;
			this.host.reportError({ extensionId: record.id, event: "activate", error: record.error });
			this.host.statesChanged();
			return;
		}
		if (generation !== this.generation || this.records.get(record.id) !== record) {
			// The conversation closed meanwhile (a reload waits for queued changes): this instance never joins it.
			instance.lifetime.retire(`Extension ${record.id} stopped before it started`);
			return;
		}
		record.instance = instance;
		record.state = "active";
		this.applyActive();
		this.host.changed();
		if (this.host.bound()) {
			const runner = this.host.runner();
			await runner.emitTo(instance, { type: "activate", reason: "enable" });
			await runner.emitTo(instance, { type: "session_start", reason: "enable" });
		}
		this.host.statesChanged();
	}

	private async disable(record: ExtensionRecord, generation: number): Promise<void> {
		const instance = record.instance;
		if (!instance) return;
		record.state = "deactivating";
		record.instance = undefined;
		// Its hooks, commands, intents, shortcuts, completion providers, and tools leave now.
		this.applyActive();
		this.host.changed();
		const runner = this.host.runner();
		if (this.host.bound()) {
			await bounded(
				(async () => {
					await runner.emitTo(instance, { type: "session_shutdown", reason: "disable" });
					await runner.emitTo(instance, { type: "deactivate", reason: "disable" });
				})(),
				EXTENSION_STOP_TIMEOUT_MS,
			);
		}
		// It registers nothing more; whatever it declared outside its record, and its work, go too.
		instance.lifetime.stop(`Extension ${record.id} was disabled`);
		this.host.retireDeclarations(instance);
		const work = this.host.retireWork(record.id);
		const retiring = (async () => {
			try {
				await work;
				await this.host.turnBoundary();
				// Once the turn ended, a tool call of it still running gets the stop bound before the instance retires.
				await bounded(runner.toolCallsSettled(record.id), EXTENSION_STOP_TIMEOUT_MS);
			} finally {
				instance.lifetime.retire(`Extension ${record.id} was disabled`);
				record.retiring = undefined;
				if (generation === this.generation && this.records.get(record.id) === record) {
					record.state = "disabled";
					if (record.removed) this.records.delete(record.id);
					this.host.statesChanged();
					// Settings may enable it again meanwhile.
					void this.reconcile().catch(() => undefined);
				}
			}
		})();
		record.retiring = retiring;
		this.host.statesChanged();
	}
}
