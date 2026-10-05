/**
 * Extension intents (RFC §8.2): enable or disable an extension and store its
 * settings, by manifest id. Settings are stored in the user's global settings
 * or, for a trusted project, the project's, once the values check out against
 * the extension's manifest. Remote clients need `host.manage.v1`. Hosts do not
 * enable or disable extensions by id yet, so `set_extension_enabled` is
 * unavailable everywhere.
 */

import { ExtensionSettingsError, storeExtensionSettings } from "../../extensions/settings.ts";
import { targetOf } from "./conversation.ts";
import { defineIntent, type IntentAvailability, IntentRejectedError } from "./types.ts";

const hostManage = ["host.manage.v1"] as const;

const UNAVAILABLE_REASON = "Extensions are not managed by id on this host";

const unavailable = (): IntentAvailability => ({ enabled: false, reason: UNAVAILABLE_REASON, code: "unavailable" });

export const setExtensionEnabledIntent = defineIntent({
	name: "set_extension_enabled",
	label: "Enable extension",
	description: "Enable or disable an extension",
	category: "extension",
	scope: "conversation",
	fence: "none",
	remote: "safe",
	requires: hostManage,
	whileBusy: "run",
	presentation: { kind: "hidden" },
	available: unavailable,
	async run() {
		throw new IntentRejectedError("unavailable", UNAVAILABLE_REASON);
	},
});

export const setExtensionSettingsIntent = defineIntent({
	name: "set_extension_settings",
	label: "Extension settings",
	description: "Store an extension's settings",
	category: "extension",
	scope: "conversation",
	fence: "none",
	remote: "safe",
	requires: hostManage,
	whileBusy: "run",
	presentation: { kind: "hidden" },
	async run(ctx, input) {
		const { session } = targetOf(ctx);
		const extension = session.extensionRunner.getExtension(input.id);
		if (!extension) throw new IntentRejectedError("invalid_input", `No extension "${input.id}" in this conversation`);
		const settingsManager = session.settingsManager;
		if (input.scope === "project" && !settingsManager.isProjectTrusted()) {
			throw new IntentRejectedError("not_allowed", "Project settings are stored only for a trusted project");
		}
		ctx.assertCurrent?.();
		try {
			await storeExtensionSettings(
				settingsManager,
				extension.id,
				extension.manifest.settings,
				input.scope,
				input.values,
			);
		} catch (error) {
			if (error instanceof ExtensionSettingsError) throw new IntentRejectedError("invalid_input", error.message);
			throw error;
		}
	},
});
