/**
 * Settings, language server, and credential intents: the settings the host
 * reads, the settings profile, the model scope, the conversation's language
 * servers, and provider sign-in. Every one is local-only: a remote client
 * neither changes host-wide settings nor sees a credential prompt.
 */

import { resolvePath } from "../../../utils/paths.ts";
import { setHostSettings, setModelScope, switchProfile } from "../../host/settings-intents.ts";
import { loginProvider, logoutProvider, ProviderLoginError } from "../../provider-auth.ts";
import { targetOf } from "./conversation.ts";
import { defineIntent, IntentRejectedError } from "./types.ts";

const hostManage = ["host.manage.v1"] as const;

// ============================================================================
// Settings, profile, and model scope
// ============================================================================

export const setSettingsIntent = defineIntent({
	name: "set_settings",
	label: "Settings",
	description: "Change settings the host reads: personality, transport, review model, images, timeouts, and warnings",
	category: "host",
	scope: "host",
	fence: "none",
	remote: "unsafe",
	requires: hostManage,
	whileBusy: "run",
	run: (ctx, input) => setHostSettings(targetOf(ctx).session, input),
});

export const setProfileIntent = defineIntent({
	name: "set_profile",
	label: "Settings profile",
	description: "Switch the settings profile and reload the conversation's resources and extensions",
	category: "host",
	scope: "conversation",
	fence: "none",
	remote: "unsafe",
	requires: hostManage,
	whileBusy: "reject",
	run: (ctx, input) =>
		switchProfile(targetOf(ctx).session, input.name, {
			...(input.create === undefined ? {} : { create: input.create }),
			...(ctx.services.modelScopePatterns === undefined
				? {}
				: { modelScopePatterns: ctx.services.modelScopePatterns }),
		}),
	accept: (result) => ({ result }),
});

export const setModelScopeIntent = defineIntent({
	name: "set_model_scope",
	label: "Model scope",
	description: "Choose the models the model-cycle control steps through",
	category: "model",
	scope: "conversation",
	fence: "none",
	remote: "unsafe",
	requires: ["model.select.v1"],
	whileBusy: "run",
	run: (ctx, input) => setModelScope(targetOf(ctx).session, input.models, input.persist === true),
});

// ============================================================================
// Language servers
// ============================================================================

export const lspRestartIntent = defineIntent({
	name: "lsp.restart",
	label: "Restart language servers",
	description: "Stop every running language server, shared ones included; they start again on next use",
	category: "advanced",
	scope: "conversation",
	fence: "none",
	remote: "unsafe",
	requires: hostManage,
	whileBusy: "run",
	async run(ctx) {
		return { stopped: targetOf(ctx).session.restartLspServers() };
	},
	accept: (result) => ({ result }),
});

export const lspSetTraceIntent = defineIntent({
	name: "lsp.set_trace",
	label: "Trace language servers",
	description: "Trace language server traffic to a file, or stop tracing",
	category: "advanced",
	scope: "conversation",
	fence: "none",
	remote: "unsafe",
	requires: hostManage,
	whileBusy: "run",
	async run(ctx, input) {
		const { session } = targetOf(ctx);
		if (!session.getLspStatus().enabled) {
			throw new IntentRejectedError("unavailable", "LSP is disabled; run with --lsp or set lsp.enabled=true");
		}
		await session.setLspTraceFile(
			input.path === null ? undefined : resolvePath(input.path, session.sessionManager.getCwd()),
		);
		const traceFile = session.getLspStatus().traceFile;
		return traceFile === undefined ? {} : { traceFile };
	},
	accept: (result) => ({ result }),
});

// ============================================================================
// Provider credentials
// ============================================================================

/** A login refusal as the intent's rejection. */
function loginRejection(error: unknown): unknown {
	return error instanceof ProviderLoginError ? new IntentRejectedError(error.code, error.message) : error;
}

export const authLoginIntent = defineIntent({
	name: "auth.login",
	label: "Sign in to a provider",
	description: "Sign in with a provider subscription or save its API key",
	category: "host",
	scope: "host",
	fence: "none",
	remote: "unsafe",
	requires: hostManage,
	whileBusy: "run",
	async run(ctx, input) {
		const { session, conversation, client } = targetOf(ctx);
		try {
			return await loginProvider(
				session,
				{ liveState: conversation.liveState, clientId: client.id },
				input.provider,
				input.method,
			);
		} catch (error) {
			throw loginRejection(error);
		}
	},
	accept: (outcome) => ({
		result: outcome.cancelled
			? { cancelled: true as const }
			: {
					...(outcome.model === undefined
						? {}
						: { model: { provider: outcome.model.provider, modelId: outcome.model.id } }),
					...(outcome.warning === undefined ? {} : { warning: outcome.warning }),
				},
	}),
});

export const authLogoutIntent = defineIntent({
	name: "auth.logout",
	label: "Sign out of a provider",
	description: "Remove a provider's stored credentials; environment variables and models.json stay",
	category: "host",
	scope: "host",
	fence: "none",
	remote: "unsafe",
	requires: hostManage,
	whileBusy: "run",
	confirm: { destructive: true },
	async run(ctx, input) {
		try {
			return { removed: logoutProvider(targetOf(ctx).session.modelRegistry, input.provider) };
		} catch (error) {
			throw loginRejection(error);
		}
	},
	accept: (result) => ({ result }),
});
