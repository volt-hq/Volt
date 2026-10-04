/**
 * A persisted conversation over the faux provider with test extensions, open
 * in a host and not yet attached by any client, for tests of how several
 * clients attach to a conversation's extensions.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxProvider } from "@hansjm10/volt-ai";
import { createAgentSessionFromServices, createAgentSessionServices } from "../../src/core/agent-session-services.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { ExtensionMode } from "../../src/core/extensions/index.ts";
import type { ConversationHost } from "../../src/core/host/conversation-host.ts";
import type { ConversationFactory, HostedConversation } from "../../src/core/host/hosted-conversation.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { ExtensionAPI, ExtensionFactory } from "../../src/index.ts";
import { openTestHost } from "../utilities/host-client.ts";

export interface ExtensionRuntime {
	host: ConversationHost;
	conversation: HostedConversation;
	tempDir: string;
	dispose(): Promise<void>;
}

export async function createExtensionRuntime(
	extensionFactory: ExtensionFactory,
	options: { extensionMode?: ExtensionMode } = {},
): Promise<ExtensionRuntime> {
	const tempDir = mkdtempSync(join(tmpdir(), "volt-extension-runtime-"));
	const faux = createFauxProvider({ models: [{ id: "faux-1", reasoning: false }] });
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
	const createRuntime: ConversationFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir: tempDir,
			authStorage,
			resourceLoaderOptions: {
				extensionFactories: [
					(volt: ExtensionAPI) => {
						volt.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							streamSimple: faux.streamSimple,
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
						extensionFactory(volt);
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: faux.getModel(),
			})),
			services,
			diagnostics: services.diagnostics,
		};
	};
	const sessionManager = await SessionManager.create(tempDir);
	const { host, conversation } = await openTestHost(createRuntime, {
		cwd: sessionManager.getCwd(),
		agentDir: tempDir,
		sessionManager,
		...(options.extensionMode === undefined ? {} : { extensionMode: options.extensionMode }),
	});
	return {
		host,
		conversation,
		tempDir,
		async dispose() {
			try {
				await host.dispose();
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		},
	};
}
