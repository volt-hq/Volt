/**
 * Session intents of local clients: moving the active branch, labels,
 * reloading resources, importing and exporting JSONL session files, and
 * deleting stored sessions. Every one is local-only: each names host paths
 * or the host's stored sessions.
 */

import { resolvePath } from "../../../utils/paths.ts";
import { SessionImportFileNotFoundError } from "../../host/conversation-host.ts";
import { findStoredSession, openImport } from "../../host/session-intents.ts";
import { configureHttpDispatcher } from "../../http-dispatcher.ts";
import { deleteStoredSession } from "../../session-delete.ts";
import { existingDirectory, rejectingMissingCwd, targetOf } from "./conversation.ts";
import { isIntentStateBusy } from "./state.ts";
import { defineIntent, INTENT_ENABLED, IntentRejectedError } from "./types.ts";

const control = ["conversation.control.v1"] as const;

export const navigateTreeIntent = defineIntent({
	name: "navigate_tree",
	label: "Navigate tree",
	description: "Move the active branch to an entry of the session tree",
	category: "session",
	scope: "conversation",
	fence: "branch",
	remote: "unsafe",
	requires: control,
	whileBusy: "reject",
	async run(ctx, input) {
		ctx.assertCurrent?.();
		const result = await targetOf(ctx).session.navigateTree(input.entryId, {
			...(input.summarize === undefined ? {} : { summarize: input.summarize }),
			...(input.customInstructions === undefined ? {} : { customInstructions: input.customInstructions }),
			...(input.replaceInstructions === undefined ? {} : { replaceInstructions: input.replaceInstructions }),
			...(input.label === undefined ? {} : { label: input.label }),
		});
		return {
			cancelled: result.cancelled,
			...(result.aborted === true ? { aborted: true } : {}),
			...(result.editorText === undefined ? {} : { editorText: result.editorText }),
		};
	},
	accept: (result) => ({ result }),
});

export const setLabelIntent = defineIntent({
	name: "set_label",
	label: "Label entry",
	description: "Bookmark an entry of the session tree, or remove its label",
	category: "session",
	scope: "conversation",
	fence: "none",
	remote: "unsafe",
	requires: control,
	whileBusy: "run",
	async run(ctx, input) {
		const { session } = targetOf(ctx);
		if (!session.sessionManager.getEntry(input.entryId)) {
			throw new IntentRejectedError("invalid_input", `Unknown entry: ${input.entryId}`);
		}
		await session.sessionWriter.appendLabelChange(input.entryId, input.label ?? undefined);
	},
});

/** The reload's host half: extensions and resources rebind, and the host settings the session reads apply again. */
export const reloadIntent = defineIntent({
	name: "reload",
	label: "Reload",
	description: "Reload extensions, skills, prompts, themes, and settings",
	category: "session",
	scope: "conversation",
	fence: "none",
	remote: "unsafe",
	requires: control,
	whileBusy: "reject",
	available(view) {
		const { state } = view;
		if (state.isStreaming || isIntentStateBusy(state)) {
			return { enabled: false, reason: "Wait for the current response to finish before reloading" };
		}
		if (state.isCompacting) return { enabled: false, reason: "Wait for compaction to finish before reloading" };
		return INTENT_ENABLED;
	},
	async run(ctx) {
		const { session } = targetOf(ctx);
		await session.reload();
		configureHttpDispatcher(session.settingsManager.getHttpIdleTimeoutMs());
		session.setTransport(session.settingsManager.getTransport());
	},
});

/** Imports a JSONL session file as a new conversation and moves the client there. */
export const importSessionIntent = defineIntent({
	name: "import_session",
	label: "Import session",
	description: "Open a JSONL session file as a new session",
	category: "session",
	scope: "conversation",
	fence: "branch",
	remote: "unsafe",
	requires: control,
	whileBusy: "reject",
	sourceOwned: true,
	async run(ctx, input) {
		const { host, client, session } = targetOf(ctx);
		const cwd = session.sessionManager.getCwd();
		const cwdOverride = input.cwdOverride === undefined ? undefined : existingDirectory(input.cwdOverride, cwd);
		try {
			return await rejectingMissingCwd(() =>
				openImport(host, client, resolvePath(input.path, cwd), cwdOverride, {
					...(ctx.assertCurrent === undefined ? {} : { assertConversationGenerationCurrent: ctx.assertCurrent }),
				}),
			);
		} catch (error) {
			if (error instanceof SessionImportFileNotFoundError)
				throw new IntentRejectedError("invalid_input", error.message);
			throw error;
		}
	},
	accept: (outcome) =>
		outcome.cancelled ? { result: { cancelled: true as const } } : { conversation: outcome.sessionId },
});

export const exportJsonlIntent = defineIntent({
	name: "export_jsonl",
	label: "Export JSONL",
	description: "Write the active branch as a JSONL session file",
	category: "session",
	scope: "conversation",
	fence: "none",
	remote: "unsafe",
	requires: ["conversation.observe.v1"],
	whileBusy: "run",
	async run(ctx, input) {
		return { path: targetOf(ctx).session.exportToJsonl(input.outputPath) };
	},
	accept: (result) => ({ result }),
});

/**
 * Deletes a stored session of the conversation's workspace after writing its
 * recovery snapshot. A session open in this host is refused; one another
 * process holds is refused by its lock.
 */
export const deleteSessionIntent = defineIntent({
	name: "delete_session",
	label: "Delete session",
	description: "Delete a stored session of this workspace",
	category: "session",
	scope: "conversation",
	fence: "none",
	remote: "unsafe",
	requires: control,
	whileBusy: "run",
	confirm: { destructive: true },
	async run(ctx, input) {
		const { conversation, host } = targetOf(ctx);
		const refuseOpen = (): void => {
			if (host.get(input.sessionId)) {
				throw new IntentRejectedError("unavailable", `Session ${input.sessionId} is open; it cannot be deleted`);
			}
		};
		refuseOpen();
		const stored = await findStoredSession(conversation, input.sessionId);
		if (!stored) {
			throw new IntentRejectedError("invalid_input", `Session not found in current workspace: ${input.sessionId}`);
		}
		refuseOpen();
		const { deleted, trashed } = await deleteStoredSession(stored.ref);
		if (!deleted) throw new IntentRejectedError("invalid_input", `Session not found: ${input.sessionId}`);
		return { trashed };
	},
	accept: (result) => ({ result }),
});
