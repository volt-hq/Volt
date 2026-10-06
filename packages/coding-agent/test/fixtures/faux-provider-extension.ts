/**
 * A single-file extension that registers faux providers in each session that
 * loads it, so no real provider is involved.
 *
 * - Under a test, the providers the test offered (`offerFauxProvider`), so a
 *   conversation the test does not build itself (a daemon's in-process
 *   worker) streams from the test's faux provider. Its module may load more
 *   than once in a process (the extension loader loads its own copy), so the
 *   offered providers live on `globalThis`.
 * - Run on its own (`./volt-test.sh --no-env -e <this file>`), a `faux`
 *   provider that answers every request with a canned reply.
 */

import { type Context, createFauxProvider, type FauxProvider, fauxAssistantMessage } from "@hansjm10/volt-ai";
import type { ExtensionAPI, ProviderConfig } from "../../src/core/extensions/types.ts";

export const manifest = {
	id: "faux-provider",
	displayName: "Faux provider",
	permissions: ["providers"],
} as const;

const PROVIDERS = Symbol.for("volt.test.fauxProviders");

function offered(): Map<string, FauxProvider> {
	const global = globalThis as { [PROVIDERS]?: Map<string, FauxProvider> };
	global[PROVIDERS] ??= new Map();
	return global[PROVIDERS];
}

/** Offer `faux` to the sessions that load this extension, until the returned function withdraws it. */
export function offerFauxProvider(faux: FauxProvider): () => void {
	const name = faux.getModel().provider;
	offered().set(name, faux);
	return () => {
		if (offered().get(name) === faux) offered().delete(name);
	};
}

function lastUserText(context: Context): string {
	const message = context.messages.findLast((candidate) => candidate.role === "user");
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** A provider for a standalone run: every turn and every auxiliary completion gets a canned reply. */
function standaloneProvider(): { faux: FauxProvider; streamSimple: ProviderConfig["streamSimple"] } {
	const faux = createFauxProvider();
	const reply = (context: Context) => fauxAssistantMessage(`Faux reply to: ${lastUserText(context).slice(0, 200)}`);
	return {
		faux,
		streamSimple: (model, context, options) => {
			if (faux.getPendingResponseCount() === 0) faux.appendResponses([reply]);
			if (faux.getPendingSimpleResponseCount() === 0) faux.appendSimpleResponses([reply]);
			return faux.streamSimple(model, context, options);
		},
	};
}

function register(volt: ExtensionAPI, name: string, faux: FauxProvider, streamSimple: ProviderConfig["streamSimple"]) {
	volt.registerProvider(name, {
		baseUrl: faux.getModel().baseUrl,
		apiKey: "faux-key",
		api: faux.api,
		streamSimple,
		models: faux.models.map((model) => ({
			id: model.id,
			name: model.name,
			api: model.api,
			reasoning: model.reasoning,
			input: model.input,
			cost: model.cost,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
		})),
	});
}

export default function fauxProviderExtension(volt: ExtensionAPI): void {
	if (offered().size === 0) {
		const standalone = standaloneProvider();
		register(volt, standalone.faux.getModel().provider, standalone.faux, standalone.streamSimple);
		return;
	}
	for (const [name, faux] of offered()) register(volt, name, faux, faux.streamSimple);
}
