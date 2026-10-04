/**
 * Tree navigation ({@link SessionNavigation}): moving the active branch
 * inside one conversation navigation (the `session_before_tree` hook, the
 * abandoned branch's summary, the label), then restoring the session's
 * branch-local runtime state from the branch it moved to and notifying
 * conversation-generation observers.
 */

import type {
	AgentTool,
	Conversation,
	ConversationBranchSummary,
	ConversationBranchSummaryRequest,
	ThinkingLevel,
} from "@hansjm10/volt-agent-core";
import type { Api, Model } from "@hansjm10/volt-ai";
import type {
	AgentSessionEvent,
	ConversationGenerationChange,
	ConversationGenerationListener,
} from "../agent-session.ts";
import type { BackgroundJobManager } from "../background-jobs.ts";
import { collectEntriesForBranchSummary, generateBranchSummary } from "../compaction/index.ts";
import type { ExtensionRunner, SessionBeforeTreeResult, TreePreparation } from "../extensions/index.ts";
import type { BranchSummaryEntry, SessionEntry, SessionManager } from "../session-manager.ts";
import type { SettingsManager } from "../settings-manager.ts";
import type { SessionBackgroundContinuation } from "./background-continuation.ts";
import { withInferenceSpeed } from "./compaction.ts";
import type { SessionExtensionServices } from "./extension-services.ts";
import type { ModelSettings } from "./model-settings.ts";
import type { SessionPlanning } from "./planning.ts";
import { extractUserMessageText } from "./session-info.ts";

export interface NavigateTreeOptions {
	summarize?: boolean;
	customInstructions?: string;
	replaceInstructions?: boolean;
	label?: string;
}

export interface NavigateTreeResult {
	editorText?: string;
	cancelled: boolean;
	aborted?: boolean;
	summaryEntry?: BranchSummaryEntry;
}

export interface SessionNavigationHost {
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	readonly modelSettings: ModelSettings;
	readonly backgroundJobs: BackgroundJobManager;
	conversation(): Conversation<AgentTool>;
	extensionRunner(): ExtensionRunner;
	extensionServices(): SessionExtensionServices;
	background(): SessionBackgroundContinuation;
	planning(): SessionPlanning;
	/** A turn holds the conversation, a prompt's reservation included. */
	turnActive(): boolean;
	isBashRunning(): boolean;
	/** A structural operation holds the conversation: compaction, tree navigation, or reload. */
	hasSessionOperationBarrier(): boolean;
	/** The branch generation: changes exactly when the active branch switches. */
	generation(): number;
	/** The model the active branch names. */
	model(): Model<Api> | undefined;
	thinkingLevel(): ThinkingLevel;
	fastModeEnabled(): boolean;
	emit(event: AgentSessionEvent): void;
}

export class SessionNavigation {
	private readonly host: SessionNavigationHost;
	private readonly generationListeners = new Set<ConversationGenerationListener>();
	/** The branch summary navigation prepared for the summarizer. */
	private pendingBranchSummary:
		| { entries: SessionEntry[]; customInstructions?: string; replaceInstructions?: boolean }
		| undefined;

	constructor(host: SessionNavigationHost) {
		this.host = host;
	}

	/** Observe conversation-generation commits such as tree navigation. */
	subscribeGenerationChanges(listener: ConversationGenerationListener): () => void {
		this.generationListeners.add(listener);
		return () => {
			this.generationListeners.delete(listener);
		};
	}

	/** Drop every conversation-generation observer. */
	clearListeners(): void {
		this.generationListeners.clear();
	}

	private notifyGenerationChange(change: ConversationGenerationChange): void {
		if (change.previousLeafId === change.nextLeafId) {
			return;
		}
		for (const listener of this.generationListeners) {
			try {
				listener(change);
			} catch {
				// The branch and runtime state are already authoritative. A projection
				// observer cannot make a committed navigation appear to have failed.
			}
		}
	}

	/**
	 * Navigate to a different node in the session tree: see
	 * {@link AgentSession.navigateTree}.
	 */
	navigateTree(targetId: string, options: NavigateTreeOptions = {}): Promise<NavigateTreeResult> {
		if (this.host.turnActive() || this.host.isBashRunning() || this.host.backgroundJobs.hasActive) {
			return Promise.reject(
				new Error(
					"Cannot navigate the session tree while an agent, bash run, or background job is active; abort or wait for it to finish",
				),
			);
		}
		if (this.host.hasSessionOperationBarrier()) {
			return Promise.reject(new Error("Cannot navigate the session tree while another session mutation is active"));
		}
		this.host.extensionServices().invalidate();
		return this.navigate(targetId, options).finally(() => this.host.background().schedule());
	}

	/**
	 * Cancel in-progress branch summarization.
	 */
	abortBranchSummary(): void {
		if (this.host.conversation().operation?.kind === "navigation") this.host.conversation().abort("host_action");
	}

	/**
	 * Move the active branch inside one conversation navigation: the
	 * `session_before_tree` hook may cancel it or supply the summary, the
	 * summarizer summarizes the abandoned branch, and the move commits with
	 * its summary. The session then restores its branch-local runtime state.
	 */
	private async navigate(targetId: string, options: NavigateTreeOptions): Promise<NavigateTreeResult> {
		const sessionManager = this.host.sessionManager;
		const oldLeafId = sessionManager.getLeafId();

		// No-op if already at target
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		// Model required for summarization
		const model = options.summarize ? this.host.model() : undefined;
		if (options.summarize && !model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		// Determine the new leaf position based on target type
		let newLeafId: string | null;
		let editorText: string | undefined;
		if (targetEntry.type === "message" && targetEntry.message.role === "user") {
			// User message: leaf = parent (null if root), text goes to editor
			newLeafId = targetEntry.parentId;
			editorText = extractUserMessageText(targetEntry.message.content);
		} else if (targetEntry.type === "custom_message") {
			// Custom message: leaf = parent (null if root), text goes to editor
			newLeafId = targetEntry.parentId;
			editorText =
				typeof targetEntry.content === "string"
					? targetEntry.content
					: targetEntry.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("");
		} else {
			// Non-user message: leaf = selected node
			newLeafId = targetId;
		}

		let label = options.label;
		let fromExtension = false;
		let summarized = false;
		const previousGeneration = this.host.generation();
		const previousModel = this.host.model();
		const previousThinkingLevel = this.host.thinkingLevel();
		const previousFastMode = this.host.fastModeEnabled();
		const result = await this.host.conversation().navigate(newLeafId, {
			summarize: options.summarize === true,
			prepare: async ({ signal }) => {
				// Collect entries to summarize (from old leaf to common ancestor)
				const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
					sessionManager,
					oldLeafId,
					targetId,
				);
				let customInstructions = options.customInstructions;
				let replaceInstructions = options.replaceInstructions;
				let extensionSummary: ConversationBranchSummary | undefined;

				if (this.host.extensionRunner().hasHandlers("session_before_tree")) {
					const preparation: TreePreparation = {
						targetId,
						oldLeafId,
						commonAncestorId,
						entriesToSummarize,
						userWantsSummary: options.summarize ?? false,
						customInstructions,
						replaceInstructions,
						label,
					};
					const hookResult = (await this.host.extensionRunner().emit({
						type: "session_before_tree",
						preparation,
						signal,
					})) as SessionBeforeTreeResult | undefined;

					if (hookResult?.cancel) {
						return { cancel: true };
					}

					if (hookResult?.summary && options.summarize) {
						extensionSummary = {
							summary: hookResult.summary.summary,
							...(hookResult.summary.details === undefined ? {} : { details: hookResult.summary.details }),
							fromHook: true,
						};
						fromExtension = true;
					}

					// Allow extensions to override instructions and label
					if (hookResult?.customInstructions !== undefined) {
						customInstructions = hookResult.customInstructions;
					}
					if (hookResult?.replaceInstructions !== undefined) {
						replaceInstructions = hookResult.replaceInstructions;
					}
					if (hookResult?.label !== undefined) {
						label = hookResult.label;
					}
				}

				summarized =
					extensionSummary !== undefined || (options.summarize === true && entriesToSummarize.length > 0);
				this.pendingBranchSummary = summarized
					? {
							entries: entriesToSummarize,
							...(customInstructions === undefined ? {} : { customInstructions }),
							...(replaceInstructions === undefined ? {} : { replaceInstructions }),
						}
					: undefined;
				// A summary carries the label; without one, the selected entry does.
				return {
					...(extensionSummary === undefined ? {} : { summary: extensionSummary }),
					...(summarized && label !== undefined ? { label } : {}),
				};
			},
		});
		this.pendingBranchSummary = undefined;
		// The navigation's events, its end included, are observed before it resolves.
		await this.host.conversation().waitForIdle();
		if (result.status === "cancelled") return { cancelled: true };
		if (result.status === "aborted") return { cancelled: true, aborted: true };

		const summaryEntry =
			result.summaryEntryId === undefined
				? undefined
				: (sessionManager.getEntry(result.summaryEntryId) as BranchSummaryEntry | undefined);
		if (label && !summaryEntry) {
			await this.host.conversation().setLabel(targetId, label);
		}

		const conversationGenerationChange = {
			previousLeafId: oldLeafId,
			nextLeafId: sessionManager.getLeafId(),
		};
		if (this.host.generation() !== previousGeneration) {
			// Prompt authority and runtime-only research evidence belong to the abandoned branch.
			this.host.backgroundJobs.cancelInaccessible();
			this.host.background().discardNotifications();
			this.host.planning().clearResearch();
		}

		// Restore branch-local runtime policy from the committed branch: model,
		// thinking level, and fast mode come from it; the plan state follows it.
		this.host.planning().restoreFromBranch();
		if (this.host.thinkingLevel() !== previousThinkingLevel) {
			this.host.emit({ type: "thinking_level_changed", level: this.host.thinkingLevel() });
			void this.host.extensionRunner().emit({
				type: "thinking_level_select",
				level: this.host.thinkingLevel(),
				previousLevel: previousThinkingLevel,
			});
		}
		if (previousFastMode !== this.host.fastModeEnabled()) {
			this.host.modelSettings.emitFastModeStateChanged();
		}
		const restoredModel = this.host.model();
		if (restoredModel) {
			await this.host.modelSettings.emitModelSelect(restoredModel, previousModel, "restore");
		}
		this.notifyGenerationChange(conversationGenerationChange);

		// Emit session_tree event
		await this.host.extensionRunner().emit({
			type: "session_tree",
			newLeafId: sessionManager.getLeafId(),
			oldLeafId,
			summaryEntry,
			...(fromExtension ? { fromExtension: true } : {}),
		});

		return { editorText, cancelled: false, summaryEntry };
	}

	/** The conversation's summarizer for tree navigation: a summary of the abandoned branch. */
	async summarizeBranch(request: ConversationBranchSummaryRequest): Promise<ConversationBranchSummary | undefined> {
		const pending = this.pendingBranchSummary;
		if (!pending || pending.entries.length === 0) return undefined;
		const branchSummarySettings = this.host.settingsManager.getBranchSummarySettings();
		const result = await generateBranchSummary(pending.entries, {
			model: request.model,
			signal: request.signal,
			customInstructions: pending.customInstructions,
			replaceInstructions: pending.replaceInstructions,
			reserveTokens: branchSummarySettings.reserveTokens,
			streamFn: withInferenceSpeed(request.stream, () => this.host.fastModeEnabled()),
		});
		if (result.aborted) return undefined;
		if (result.error) throw new Error(result.error);
		if (!result.summary) return undefined;
		return {
			summary: result.summary,
			details: {
				readFiles: result.readFiles || [],
				modifiedFiles: result.modifiedFiles || [],
			},
		};
	}
}
