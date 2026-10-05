/**
 * Extension queries (RFC §8.2, §8.3): the extension catalog, one extension's
 * settings, and editor completions from extension completion providers.
 * `extension_settings` returns an extension's settings form and the values
 * stored in each scope; remote clients need `host.manage.v1`. Hosts do not
 * list extensions by id yet, so `extensions` is unavailable everywhere.
 * Editor completions ask the conversation's completion providers
 * (core/extensions/completions.ts); a remote client asks only those whose
 * extension opted in.
 */

import { completeEditorText } from "../../extensions/completions.ts";
import { extensionSettingsView } from "../../extensions/settings.ts";
import type { IntentTarget } from "../intents/types.ts";
import { defineQuery, QueryRejectedError } from "./types.ts";

function unavailable(): never {
	throw new QueryRejectedError("unavailable", "Extensions are not managed by id on this host");
}

export const extensionsQuery = defineQuery({
	name: "extensions",
	scope: "conversation",
	remote: "safe",
	requires: ["conversation.observe.v1"],
	run: async () => unavailable(),
});

export const extensionSettingsQuery = defineQuery({
	name: "extension_settings",
	scope: "conversation",
	remote: "safe",
	requires: ["host.manage.v1"],
	run: async (ctx, params) => {
		const session = ctx.target?.session;
		if (!session) throw new QueryRejectedError("unavailable", "This query needs a conversation");
		const extension = session.extensionRunner.getExtension(params.id);
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
