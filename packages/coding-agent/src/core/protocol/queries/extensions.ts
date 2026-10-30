/**
 * Extension queries (RFC §8.2, §8.3): the extension catalog, one extension's
 * settings, and editor completions from extension completion providers.
 * `extensions` lists every extension of the conversation, running or not,
 * with its state, permissions, and whether the user acknowledged them; only a
 * local client reads each one's fingerprint (core/extensions/inventory.ts).
 * `extension_settings` returns an extension's settings form and the values
 * stored in each scope, whether it runs or not; remote clients need
 * `host.manage.v1`. `extension_remote_commands` lists a running extension's
 * commands and who lets paired remote devices invoke each; only local clients
 * read it. Editor completions ask the conversation's completion
 * providers (core/extensions/completions.ts); a remote client asks only
 * those whose extension opted in.
 */

import { EXTENSION_DESCRIPTION_MAX_CHARS } from "@hansjm10/volt-protocol";
import { completeEditorText } from "../../extensions/completions.ts";
import { remoteExtensionSummary } from "../../extensions/inventory.ts";
import { ExtensionPermissionStore } from "../../extensions/permissions.ts";
import { extensionSettingsView } from "../../extensions/settings.ts";
import { boundedDisplayString } from "../intents/dynamic.ts";
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
		return { extensions: ctx.profile.name === "local" ? summaries : summaries.map(remoteExtensionSummary) };
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

export const extensionRemoteCommandsQuery = defineQuery({
	name: "extension_remote_commands",
	scope: "conversation",
	// A paired device must not learn, or change, which commands it may invoke beyond what it is offered.
	remote: "unsafe",
	requires: ["host.manage.v1"],
	run: async (ctx, params) => {
		const session = ctx.target?.session;
		if (!session) throw new QueryRejectedError("unavailable", "This query needs a conversation");
		if (!session.extensionRegistry.get(params.id)) {
			throw new QueryRejectedError("invalid_input", `No extension "${params.id}" in this conversation`);
		}
		const allowed = new Set(session.settingsManager.getExtensionRemoteSafeCommands(params.id));
		const extension = session.extensionRunner.getExtensions().find((candidate) => candidate.id === params.id);
		const commands = [...(extension?.commands.values() ?? [])].map((command) => {
			const description = boundedDisplayString(command.description, EXTENSION_DESCRIPTION_MAX_CHARS);
			return {
				name: command.name,
				...(description === undefined ? {} : { description }),
				access: command.remoteSafe === true ? "extension" : allowed.has(command.name) ? "user" : "local",
			} as const;
		});
		return { commands };
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
