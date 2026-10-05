/**
 * Extension intents (RFC §8.2): enable or disable an extension and store its
 * settings, by manifest id. Both are stored in the user's global settings or,
 * for a trusted project, the project's; every open conversation then starts
 * or stops the extension, and this one has done so when the intent answers
 * (a disabled extension's instance retires at the next turn boundary).
 * Remote clients need `host.manage.v1`.
 *
 * Enabling an extension whose declared permissions the user has not
 * acknowledged asks the invoking client, and no other, to acknowledge them
 * (an `approval` host request); a paired remote device is refused instead,
 * so permissions are acknowledged only on the host. Permissions acknowledged
 * for an earlier revision of the same package that adds none are carried, as
 * an update carries them. Settings name an id, not the code it runs, so each
 * conversation runs an extension enabled at runtime only once its own
 * declaration is acknowledged (core/extensions/registry.ts).
 */

import { ExtensionPermissionStore, permissionRequestLines, permissionSubject } from "../../extensions/permissions.ts";
import type { DeclaredExtensionInfo } from "../../extensions/registry.ts";
import { ExtensionSettingsError, storeExtensionSettings } from "../../extensions/settings.ts";
import { targetOf } from "./conversation.ts";
import { defineIntent, type IntentContext, IntentRejectedError } from "./types.ts";

const hostManage = ["host.manage.v1"] as const;

/** How long enabling waits for the user to acknowledge an extension's permissions. */
export const EXTENSION_PERMISSION_APPROVAL_TIMEOUT_MS = 5 * 60_000;

/**
 * Settle the permissions of `extension` before it is enabled: acknowledged
 * already (or carried from an earlier revision), acknowledged now by the
 * invoking local client, or refused.
 */
async function acknowledgePermissions(ctx: IntentContext, extension: DeclaredExtensionInfo): Promise<void> {
	const { conversation, client } = targetOf(ctx);
	const store = new ExtensionPermissionStore(conversation.services.agentDir);
	const subject = permissionSubject(extension);
	const review = store.review(subject);
	if (review.status === "acknowledged") return;
	if (review.status === "carried") {
		store.acknowledge({ ...subject, version: extension.version });
		return;
	}
	if (ctx.profile.name !== "local") {
		throw new IntentRejectedError(
			"not_allowed",
			`Extension "${extension.id}" asks for permissions not acknowledged on the host; enable it there first`,
		);
	}
	const lines = permissionRequestLines(
		{ ...subject, displayName: extension.manifest.displayName, version: extension.version },
		review.added,
	);
	// Only the invoking client is asked: no other client may acknowledge for it.
	const outcome = await conversation.liveState.request(
		{
			kind: "approval",
			action: "enable_extension",
			title: `Enable ${extension.manifest.displayName}?`,
			message: [...lines, "", "Extensions run with your permissions; these are not enforced."].join("\n"),
			confirmLabel: "Acknowledge and enable",
			cancelLabel: "Cancel",
			timeoutMs: EXTENSION_PERMISSION_APPROVAL_TIMEOUT_MS,
		},
		{ client: client.id },
	);
	if (outcome.status !== "answered") {
		throw new IntentRejectedError(
			"not_allowed",
			outcome.reason === "unavailable"
				? `Extension "${extension.id}" asks for permissions, and this client cannot acknowledge them`
				: `Extension "${extension.id}" was not enabled: its permissions were not acknowledged`,
		);
	}
	if (!("decision" in outcome.response) || outcome.response.decision !== "approved") {
		throw new IntentRejectedError(
			"not_allowed",
			`Extension "${extension.id}" was not enabled: its permissions were not acknowledged`,
		);
	}
	store.acknowledge({ ...subject, version: extension.version });
}

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
	async run(ctx, input) {
		const { session } = targetOf(ctx);
		const registry = session.extensionRegistry;
		const extension = registry.get(input.id);
		if (!extension) throw new IntentRejectedError("invalid_input", `No extension "${input.id}" in this conversation`);
		const settingsManager = session.settingsManager;
		if (input.scope === "project" && !settingsManager.isProjectTrusted()) {
			throw new IntentRejectedError("not_allowed", "Project settings are stored only for a trusted project");
		}
		if (input.enabled) {
			await acknowledgePermissions(ctx, extension);
			// What was acknowledged must be what runs: a reload meanwhile may have declared other code under the id.
			if (registry.get(input.id)?.fingerprint !== extension.fingerprint) {
				throw new IntentRejectedError("conflict", `Extension "${input.id}" changed while it was being enabled`);
			}
		}
		ctx.assertCurrent?.();
		try {
			settingsManager.setExtensionEnabled(input.id, input.scope, input.enabled);
			await settingsManager.flush();
		} catch (error) {
			throw new IntentRejectedError("failed", error instanceof Error ? error.message : String(error));
		}
		// Every open conversation follows the settings; this one has when the intent answers.
		await registry.reconcile();
		// Enabling a failed extension tries it again.
		if (input.enabled) await registry.retry(input.id);
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
		const extension = session.extensionRegistry.get(input.id);
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
