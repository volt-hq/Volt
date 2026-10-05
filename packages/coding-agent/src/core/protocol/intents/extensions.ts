/**
 * Extension intents (RFC §8.2): enable or disable an extension and store its
 * settings, by manifest id. Hosts do not manage extensions by id yet, so both
 * are unavailable everywhere.
 */

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
	available: unavailable,
	async run() {
		throw new IntentRejectedError("unavailable", UNAVAILABLE_REASON);
	},
});
