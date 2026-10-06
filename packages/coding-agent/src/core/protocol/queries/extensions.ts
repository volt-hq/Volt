/**
 * Extension queries (RFC §8.2, §8.3): the extension catalog, one extension's
 * settings, and editor completions from extension completion providers.
 * `extensions` lists every extension of the conversation, running or not,
 * with its state, permissions, and whether the user acknowledged them; a
 * local client also reads each one's fingerprint.
 * `extension_settings` returns an extension's settings form and the values
 * stored in each scope, whether it runs or not; remote clients need
 * `host.manage.v1`. Editor completions ask the conversation's completion
 * providers (core/extensions/completions.ts); a remote client asks only
 * those whose extension opted in.
 */

import { completeEditorText } from "../../extensions/completions.ts";
import { ExtensionPermissionStore } from "../../extensions/permissions.ts";
import { extensionSettingsView } from "../../extensions/settings.ts";
import type { IntentTarget } from "../intents/types.ts";
import { defineQuery, QueryRejectedError } from "./types.ts";

export const extensionsQuery = defineQuery({
	name: "extensions",
	scope: "conversation",
	remote: "safe",
	requires: ["conversation.observe.v1"],
	run: async (ctx) => {
		const target = ctx.target;
		if (!target) throw new QueryRejectedError("unavailable", "This query needs a conversation");
		const permissions = new ExtensionPermissionStore(target.conversation.services.agentDir);
		const summaries = target.session.extensionRegistry.summaries(permissions);
		if (ctx.profile.name !== "local") return { extensions: summaries };
		const registry = target.session.extensionRegistry;
		return {
			extensions: summaries.map((summary) => {
				const fingerprint = registry.get(summary.id)?.fingerprint;
				return fingerprint === undefined ? summary : { ...summary, fingerprint };
			}),
		};
	},
});

export const extensionSettingsQuery = defineQuery({
	name: "extension_settings",
	scope: "conversation",
	remote: "safe",
	requires: ["host.manage.v1"],
	run: async (ctx, params) => {
		const session = ctx.target?.session;
		if (!session) throw new QueryRejectedError("unavailable", "This query needs a conversation");
		const extension = session.extensionRegistry.get(params.id);
		if (!extension) throw new QueryRejectedError("invalid_input", `No extension "${params.id}" in this conversation`);
		return extensionSettingsView(session.settingsManager, extension.id, extension.manifest.settings);
	},
});

export const editorCompletionsQuery = defineQuery({
	name: "editor_completions",
	scope: "conversation",
	remote: "safe",
	requires: ["conversation.control.v1"],
	run: async (ctx, { text, cursor }) => {
		const runner = (ctx.target as IntentTarget).session.extensionRunner;
		const remote = ctx.profile.name === "remote";
		const providers = runner.getCompletionProviders().filter((provider) => !remote || provider.remote);
		return completeEditorText(providers, text, cursor, { onError: (error) => runner.emitError(error) });
	},
});
