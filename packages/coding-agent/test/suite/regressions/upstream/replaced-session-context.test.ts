// Upstream Pi regression: https://github.com/earendil-works/pi/issues/2860

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxProvider, fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../../../src/core/agent-session-services.ts";
import { AuthStorage } from "../../../../src/core/auth-storage.ts";
import type { ConversationFactory } from "../../../../src/core/host/hosted-conversation.ts";
import { SessionManager, type SessionReference } from "../../../../src/core/session-manager.ts";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionFactory } from "../../../../src/index.ts";
import { connectTestClient, openTestHost, type TestClient } from "../../../utilities/host-client.ts";
import { testExtension } from "../../../utilities.ts";

function getText(message: AgentSession["messages"][number]): string {
	if (!("content" in message)) {
		return "";
	}
	return typeof message.content === "string"
		? message.content
		: message.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join("");
}

describe("regression #2860: replaced session callbacks", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeForTest(extensionFactory: ExtensionFactory, responses: string[]) {
		const tempDir = join(tmpdir(), `volt-2860-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = createFauxProvider({
			models: [{ id: "faux-1", reasoning: false }],
		});
		faux.setResponses(responses.map((response) => fauxAssistantMessage(response)));

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const createRuntime: ConversationFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: tempDir,
				authStorage,
				resourceLoaderOptions: {
					extensionFactories: [
						testExtension(
							"test-extension-1",
							(volt: ExtensionAPI) => {
								volt.registerProvider(faux.getModel().provider, {
									baseUrl: faux.getModel().baseUrl,
									apiKey: "faux-key",
									api: faux.api,
									streamSimple: faux.streamSimple,
									models: faux.models.map((registeredModel) => ({
										id: registeredModel.id,
										name: registeredModel.name,
										api: registeredModel.api,
										reasoning: registeredModel.reasoning,
										input: registeredModel.input,
										cost: registeredModel.cost,
										contextWindow: registeredModel.contextWindow,
										maxTokens: registeredModel.maxTokens,
									})),
								});
								extensionFactory(volt);
							},
							["providers"],
						),
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

		const { host, conversation } = await openTestHost(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: await SessionManager.create(tempDir),
		});

		// The host attaches the client's surface on every conversation it moves to.
		const runtime: TestClient = await connectTestClient(host, conversation, {
			surface: {
				commandContextActions: {
					waitForIdle: () => runtime.session.waitForIdle(),
					newSession: async (options) => runtime.newSession(options),
					fork: async (entryId, options) => {
						const result = await runtime.fork(entryId, options);
						return result.cancelled
							? result
							: { cancelled: false, sessionId: result.sessionId, seeded: result.seeded };
					},
					navigateTree: async (targetId, options) => {
						const result = await runtime.session.navigateTree(targetId, {
							summarize: options?.summarize,
							customInstructions: options?.customInstructions,
							replaceInstructions: options?.replaceInstructions,
							label: options?.label,
						});
						return { cancelled: result.cancelled };
					},
					switchSession: async (sessionRef, options) => runtime.switchSession(sessionRef, options),
					reload: async () => {
						await runtime.session.reload();
					},
				},
			},
		});

		cleanups.push(async () => {
			await host.dispose();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return { runtime, faux };
	}

	it("attaches the client before withSession, targets the new session, and invalidates stale volt/ctx", async () => {
		const events: string[] = [];
		let oldCtx: ExtensionCommandContext | undefined;
		let oldVolt: ExtensionAPI | undefined;
		let oldSessionRef: SessionReference | undefined;
		let staleCtxThrows = false;
		let staleVoltThrows = false;
		let replacementSessionRef: SessionReference | undefined;
		let instanceId = 0;
		const { runtime } = await createRuntimeForTest(
			(volt) => {
				const currentInstance = ++instanceId;
				volt.on("session_start", () => {
					events.push(`start:${currentInstance}`);
				});
				volt.on("session_shutdown", () => {
					events.push(`shutdown:${currentInstance}`);
				});
				volt.registerCommand("repro", {
					description: "repro",
					handler: async (_args, ctx) => {
						oldCtx = ctx;
						oldVolt = volt;
						oldSessionRef = ctx.sessionManager.getSessionRef();
						await ctx.newSession({
							parentSessionRef: oldSessionRef,
							withSession: async (replacedCtx) => {
								events.push(`with:${currentInstance}`);
								replacementSessionRef = replacedCtx.sessionManager.getSessionRef();
								try {
									oldCtx?.sessionManager.getSessionRef();
								} catch {
									staleCtxThrows = true;
								}
								try {
									oldVolt?.sendUserMessage("stale message");
								} catch {
									staleVoltThrows = true;
								}
								await replacedCtx.sendUserMessage("Hello from the new session!");
							},
						});
					},
				});
			},
			["hello reply"],
		);

		expect(events).toEqual(["start:1"]);

		await runtime.session.prompt("/repro");

		// The new session starts before the old one shuts down; withSession runs after both.
		expect(events).toEqual(["start:1", "start:2", "shutdown:1", "with:1"]);
		expect(replacementSessionRef).toBeDefined();
		expect(replacementSessionRef).not.toEqual(oldSessionRef);
		expect(staleCtxThrows).toBe(true);
		expect(staleVoltThrows).toBe(true);
		expect(runtime.session.messages.map((message) => `${message.role}:${getText(message)}`)).toEqual([
			"user:Hello from the new session!",
			"assistant:hello reply",
		]);
	});

	it("supports withSession for fork", async () => {
		const { runtime } = await createRuntimeForTest(
			(volt) => {
				volt.registerCommand("fork-it", {
					description: "fork-it",
					handler: async (_args, ctx) => {
						const leafId = ctx.sessionManager.getLeafId();
						if (!leafId) {
							throw new Error("Missing leaf id");
						}
						await ctx.fork(leafId, {
							position: "at",
							withSession: async (replacedCtx) => {
								await replacedCtx.sendUserMessage("fork callback message");
							},
						});
					},
				});
			},
			["seed reply", "fork reply"],
		);

		await runtime.session.prompt("seed");
		await runtime.session.prompt("/fork-it");

		expect(runtime.session.messages.map((message) => `${message.role}:${getText(message)}`)).toEqual([
			"user:seed",
			"assistant:seed reply",
			"user:fork callback message",
			"assistant:fork reply",
		]);
	});

	it("supports withSession for switchSession", async () => {
		let targetSessionRef: SessionReference | undefined;
		const { runtime } = await createRuntimeForTest(
			(volt) => {
				volt.registerCommand("switch-it", {
					description: "switch-it",
					handler: async (_args, ctx) => {
						if (!targetSessionRef) throw new Error("Missing target session reference");
						await ctx.switchSession(targetSessionRef, {
							withSession: async (replacedCtx) => {
								await replacedCtx.sendUserMessage("switch callback message");
							},
						});
					},
				});
			},
			["root reply", "target reply", "switch reply"],
		);

		await runtime.session.prompt("root");
		const originalSessionRef = runtime.session.sessionRef;
		const newSessionResult = await runtime.newSession();
		expect(newSessionResult.cancelled).toBe(false);
		await runtime.session.prompt("target");
		targetSessionRef = runtime.session.sessionRef;
		await runtime.switchSession(originalSessionRef!);

		await runtime.session.prompt("/switch-it");

		expect(runtime.session.sessionRef).toEqual(targetSessionRef);
		expect(runtime.session.messages.map((message) => `${message.role}:${getText(message)}`)).toEqual([
			"user:target",
			"assistant:target reply",
			"user:switch callback message",
			"assistant:switch reply",
		]);
	});
});
