/**
 * Extension queries (RFC §8.2, §8.3): the extension catalog, one extension's
 * settings, and editor completions from extension completion providers.
 * Hosts do not manage extensions by id or serve completion providers yet, so
 * each is unavailable everywhere.
 */

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
	run: async () => unavailable(),
});

export const editorCompletionsQuery = defineQuery({
	name: "editor_completions",
	scope: "conversation",
	remote: "safe",
	requires: ["conversation.control.v1"],
	run: async () => unavailable(),
});
