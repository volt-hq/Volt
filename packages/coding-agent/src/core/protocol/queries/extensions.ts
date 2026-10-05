/**
 * Extension queries (RFC §8.2, §8.3): the extension catalog, one extension's
 * settings, and editor completions from extension completion providers.
 * `extension_settings` returns an extension's settings form and the values
 * stored in each scope; remote clients need `host.manage.v1`. Hosts do not
 * list extensions by id or serve completion providers yet, so `extensions`
 * and `editor_completions` are unavailable everywhere.
 */

import { extensionSettingsView } from "../../extensions/settings.ts";
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
	run: async () => unavailable(),
});
