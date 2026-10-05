/**
 * The runtime extension toggle (RFC §8.2): settings decide which extensions
 * run (`extensions.<id>.enabled`), and the `set_extension_enabled` intent
 * starts or stops one in every open conversation without a reload. Disabling
 * removes everything the extension contributed (hooks, tools, commands,
 * intents, shortcuts, completion providers, UI, dialogs, event-bus
 * listeners, work), its tools at the next turn boundary; enabling runs a new
 * instance. Enabling asks the invoking local client to acknowledge
 * permissions; a remote client is refused unless they are acknowledged.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import type { ExtensionSummary, LiveItem, RemoteCapability } from "@hansjm10/volt-protocol";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionManifest } from "../../src/core/extensions/manifest.ts";
import { ExtensionPermissionStore, permissionSubject } from "../../src/core/extensions/permissions.ts";
import type { ExtensionAPI, ExtensionContext, ExtensionDefinition } from "../../src/core/extensions/types.ts";
import type { HostedConversation } from "../../src/core/host/hosted-conversation.ts";
import type { LiveClient } from "../../src/core/host/live-state.ts";
import {
	type IntentContext,
	type IntentProfile,
	intentRegistry,
	LOCAL_INTENT_PROFILE,
} from "../../src/core/protocol/intents/index.ts";
import { localProfile } from "../../src/core/protocol/profiles.ts";
import { conversationProjectionSource, projectEntry } from "../../src/core/protocol/projection/entries.ts";
import { queryRegistry } from "../../src/core/protocol/queries/index.ts";
import { createHostHarness, type HostHarness } from "./host-harness.ts";

const remote = (...capabilities: RemoteCapability[]): IntentProfile => ({
	name: "remote",
	grant: { schemaVersion: 1, revision: 1, capabilities },
});

/** A live view of one client: what it was sent, and how it answers approvals. */
function liveClient(answer?: (requestId: string, kind: string) => void): LiveClient & { items: LiveItem[] } {
	const items: LiveItem[] = [];
	return {
		items,
		acceptsHostRequest: () => true,
		apply: (update) => {
			items.push(...update.items);
			for (const item of update.items) {
				if (item.type === "set" && item.value.kind === "host_request") {
					const { requestId, request } = item.value;
					queueMicrotask(() => answer?.(requestId, request.kind));
				}
			}
		},
	};
}

/** One instance of a test extension, as its factory and handlers saw it. */
interface Instance {
	readonly volt: ExtensionAPI;
	readonly events: string[];
	ctx?: ExtensionContext;
	dialog?: Promise<boolean>;
}

describe("extension runtime toggle", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		vi.useRealTimers();
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function setup(
		extensions: ExtensionDefinition[],
		options: { bus?: (volt: ExtensionAPI) => void; settings?: unknown } = {},
	): Promise<HostHarness> {
		const harness = await createHostHarness({
			whenUnattached: "keep",
			extensions,
			...(options.bus === undefined ? {} : { extension: options.bus }),
		});
		cleanups.push(() => harness.cleanup());
		if (options.settings !== undefined) {
			writeFileSync(join(harness.tempDir, "settings.json"), JSON.stringify(options.settings));
		}
		return harness;
	}

	async function open(
		harness: HostHarness,
		clientId: string,
		live = liveClient(),
	): Promise<{ conversation: HostedConversation; context(profile?: IntentProfile): IntentContext }> {
		const conversation = await harness.openStartup();
		const client = harness.client(clientId, { live });
		await harness.host.attach(client, conversation);
		return {
			conversation,
			context: (profile = LOCAL_INTENT_PROFILE) => ({
				target: { session: conversation.session, conversation, host: harness.host, client },
				services: {},
				profile,
			}),
		};
	}

	async function summary(context: IntentContext, id: string): Promise<ExtensionSummary | undefined> {
		const { extensions } = await queryRegistry.run(context, "extensions", {});
		return extensions.find((extension) => extension.id === id);
	}

	/** An extension that contributes one of everything and records what it hears. */
	function contributing(instances: Instance[], manifest: Partial<ExtensionManifest> = {}): ExtensionDefinition {
		return {
			manifest: { id: "toggled", displayName: "Toggled", description: "Runs and stops", ...manifest },
			factory: (volt) => {
				const instance: Instance = { volt, events: [] };
				instances.push(instance);
				volt.registerTool({
					name: "toggled_tool",
					label: "Toggled tool",
					description: "Answers ok",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
				});
				volt.registerCommand("toggled-cmd", { description: "A command", handler: async () => {} });
				volt.registerIntent("ping", { label: "Ping", handler: () => {} });
				volt.registerShortcut("ctrl+alt+t", { intent: "ping" });
				volt.registerCompletionProvider("tags", { trigger: "#", complete: () => [{ value: "#tag" }] });
				volt.registerWorkKind("job");
				volt.on("activate", (event) => {
					instance.events.push(`activate:${event.reason}`);
				});
				volt.on("deactivate", (event) => {
					instance.events.push(`deactivate:${event.reason}`);
				});
				volt.on("session_start", (event, ctx) => {
					instance.events.push(`session_start:${event.reason}`);
					instance.ctx = ctx;
					ctx.ui.setStatus("state", "on");
					ctx.ui.setPanel("panel", { node: { type: "text", text: "a panel" } });
					ctx.ui.setTitle("toggled title");
					instance.dialog = ctx.ui.confirm("Keep going?", "The extension asks");
				});
				volt.on("session_shutdown", (event) => {
					instance.events.push(`session_shutdown:${event.reason}`);
				});
				volt.on("turn_start", () => {
					instance.events.push("turn_start");
				});
				volt.events.on("ping", () => {
					instance.events.push("bus");
				});
			},
		};
	}

	it("stops an extension settings disable, removing what it contributed, and runs a new instance once enabled", async () => {
		const instances: Instance[] = [];
		let bus: ExtensionAPI | undefined;
		const harness = await setup([contributing(instances)], {
			bus: (volt) => {
				bus = volt;
			},
		});
		const { conversation, context } = await open(harness, "tui");
		const session = conversation.session;
		const registry = session.extensionRegistry;
		expect(instances).toHaveLength(1);
		const [first] = instances;
		expect(first?.events).toEqual(["activate:startup", "session_start:startup"]);
		expect(await summary(context(), "toggled")).toEqual({
			id: "toggled",
			displayName: "Toggled",
			description: "Runs and stops",
			version: "local",
			scope: "temporary",
			enabled: true,
			state: "active",
			permissions: [],
			permissionsAcknowledged: true,
			hasSettings: false,
		});
		expect(session.getActiveToolNames()).toContain("toggled_tool");
		expect(conversation.liveState.get("ext_status/toggled/state")).toBeDefined();

		// Work the extension runs keeps the conversation active until it is cancelled.
		const { workId } = await (first?.ctx as ExtensionContext).startWork("job", { title: "A job" }, async (work) => {
			await new Promise((resolve) => work.signal.addEventListener("abort", resolve, { once: true }));
			return { outcome: "cancelled" };
		});
		expect(conversation.isActive()).toBe(true);

		await intentRegistry.invoke(context(), "set_extension_enabled", {
			id: "toggled",
			enabled: false,
			scope: "global",
		});
		await registry.settled();

		expect(first?.events.slice(-2)).toEqual(["session_shutdown:disable", "deactivate:disable"]);
		expect((await summary(context(), "toggled"))?.state).toBe("disabled");
		expect(session.settingsManager.getStoredExtensionEnabled("toggled", "global")).toBe(false);
		// Its UI, dialog, and work are gone.
		expect(
			conversation.liveState
				.entries()
				.filter(([key]) => key.startsWith("ext_status/toggled/") || key.startsWith("ext_panel/toggled/")),
		).toEqual([]);
		expect(conversation.liveState.get("ext_title")).toBeUndefined();
		await expect(first?.dialog).resolves.toBe(false);
		expect(conversation.work.get(workId)).toMatchObject({ outcome: "cancelled" });
		expect(conversation.isActive()).toBe(false);
		// Its tools, commands, intents, shortcuts, completion providers, and kinds are gone.
		const runner = session.extensionRunner;
		expect(session.getActiveToolNames()).not.toContain("toggled_tool");
		expect(session.getAllTools().map((tool) => tool.name)).not.toContain("toggled_tool");
		expect(runner.getRegisteredCommands().map((command) => command.name)).not.toContain("toggled-cmd");
		expect(runner.getRegisteredIntents()).toEqual([]);
		expect(runner.getCompletionProviders()).toEqual([]);
		expect([...runner.getShortcuts({}).values()].map((shortcut) => shortcut.extensionId)).not.toContain("toggled");
		expect(runner.getWorkKinds()).toEqual([]);
		await expect(intentRegistry.invokeFrame(context(), "extension.intent.toggled.ping", {})).rejects.toMatchObject({
			code: "unknown_intent",
		});
		// Its hooks and event-bus listeners never run again, and its captured API and contexts throw.
		bus?.events.emit("ping", {});
		await session.prompt("hello");
		expect(first?.events.slice(-2)).toEqual(["session_shutdown:disable", "deactivate:disable"]);
		expect(() => first?.volt.getActiveTools()).toThrow(/disabled/);
		expect(() => first?.ctx?.cwd).toThrow(/disabled/);
		expect(() => first?.ctx?.ui).toThrow(/disabled/);

		await intentRegistry.invoke(context(), "set_extension_enabled", {
			id: "toggled",
			enabled: true,
			scope: "global",
		});
		expect(instances).toHaveLength(2);
		const second = instances[1];
		expect(second?.events).toEqual(["activate:enable", "session_start:enable"]);
		expect((await summary(context(), "toggled"))?.state).toBe("active");
		expect(session.getActiveToolNames()).toContain("toggled_tool");
		expect(runner.getRegisteredIntents().map((intent) => intent.intent)).toEqual(["extension.intent.toggled.ping"]);
		expect(conversation.liveState.get("ext_status/toggled/state")).toBeDefined();
		bus?.events.emit("ping", {});
		expect(second?.events).toContain("bus");
		// The first instance stays retired.
		expect(() => first?.ctx?.cwd).toThrow(/disabled/);
	});

	it("presents with an extension's presenters only while it runs: disabled, its calls present generically", async () => {
		const present = vi.fn(() => ({ title: "presented by the extension" }));
		const presentMessage = vi.fn(() => ({ body: [{ type: "text" as const, text: "presented note" }] }));
		const harness = await setup([
			{
				manifest: { id: "presenting", displayName: "Presenting" },
				factory: (volt) => {
					volt.registerTool({
						name: "presented_tool",
						label: "Presented tool",
						description: "Answers ok",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
						present,
					});
					volt.registerMessagePresenter("presented-note", presentMessage);
				},
			},
		]);
		const { conversation, context } = await open(harness, "tui");
		const session = conversation.session;
		const writer = session.sessionWriter;
		const model = session.model;
		if (!model) throw new Error("Expected a model");
		await writer.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "presented_tool", arguments: {} }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		});
		await writer.appendMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "presented_tool",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: Date.now(),
		});
		await writer.appendCustomMessageEntry("presented-note", "plain note", true, undefined);
		const views = () =>
			session.sessionManager
				.getEntries()
				.flatMap((entry) => {
					const committed = session.sessionManager.getCommittedEntry(entry.id);
					const projected = committed
						? projectEntry(committed, conversationProjectionSource(session), localProfile)
						: undefined;
					return projected && "view" in projected && projected.view ? [projected.view] : [];
				})
				.filter((view) => view.role === "tool" || view.text === "plain note");
		expect(views().map((view) => view.presentation)).toEqual([
			{ title: "presented by the extension" },
			{ body: [{ type: "text", text: "presented note" }] },
		]);
		const generation = session.presenters.generation;

		await intentRegistry.invoke(context(), "set_extension_enabled", {
			id: "presenting",
			enabled: false,
			scope: "global",
		});
		await session.extensionRegistry.settled();
		expect(session.presenters.generation).toBeGreaterThan(generation);
		present.mockClear();
		presentMessage.mockClear();
		// The disabled extension's code no longer runs: its call is generic, its message is text.
		expect(views().map((view) => view.presentation)).toEqual([
			expect.objectContaining({ title: "presented_tool" }),
			undefined,
		]);
		expect(present).not.toHaveBeenCalled();
		expect(presentMessage).not.toHaveBeenCalled();

		await intentRegistry.invoke(context(), "set_extension_enabled", {
			id: "presenting",
			enabled: true,
			scope: "global",
		});
		await session.extensionRegistry.settled();
		expect(views()[0]?.presentation).toEqual({ title: "presented by the extension" });
	});

	it("offers an extension's tools until the turn boundary and waits for its running tool call", async () => {
		const release = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const seen: string[] = [];
		const offered: string[][] = [];
		const harness = await setup([
			{
				manifest: { id: "slow", displayName: "Slow", permissions: ["providers"] },
				factory: (volt) => {
					volt.registerTool({
						name: "slow_tool",
						label: "Slow tool",
						description: "Takes its time",
						parameters: Type.Object({}),
						execute: async (_id, _params, _signal, _onUpdate, ctx) => {
							// Taken before the extension stops.
							const setStatus = ctx.ui.setStatus;
							started.resolve();
							await release.promise;
							// Its context works until the call settles; it shows nothing more and registers nothing more.
							seen.push(ctx.cwd);
							setStatus("late", "shown after disable");
							ctx.ui.setPanel("late", { node: { type: "text", text: "late" } });
							for (const late of [
								() => volt.registerCommand("late-cmd", { handler: async () => {} }),
								() => volt.sendUserMessage("a message from a disabled extension"),
								() =>
									ctx.modelRegistry.registerProvider("late-provider", {
										baseUrl: "https://late.example.test",
									}),
							]) {
								try {
									late();
								} catch (error) {
									seen.push(error instanceof Error ? error.message : String(error));
								}
							}
							return { content: [{ type: "text", text: "slow done" }], details: undefined };
						},
					});
				},
			},
		]);
		const { conversation, context } = await open(harness, "tui");
		const session = conversation.session;
		harness.faux.setResponses([
			(request) => {
				offered.push((request.tools ?? []).map((tool) => tool.name));
				return fauxAssistantMessage([fauxToolCall("slow_tool", {})], { stopReason: "toolUse" });
			},
			(request) => {
				offered.push((request.tools ?? []).map((tool) => tool.name));
				return fauxAssistantMessage("done");
			},
		]);
		const prompt = session.prompt("go");
		await started.promise;

		// Disabling while the turn runs: the hooks go now, the tool at the next request.
		await intentRegistry.invoke(context(), "set_extension_enabled", { id: "slow", enabled: false, scope: "global" });
		expect(session.extensionRegistry.get("slow")?.state).toBe("deactivating");
		expect(session.getActiveToolNames()).not.toContain("slow_tool");

		release.resolve();
		await prompt;
		await session.extensionRegistry.settled();
		expect(seen).toEqual([
			conversation.cwd,
			"Extension slow was disabled",
			"Extension slow was disabled",
			"Extension slow was disabled",
		]);
		expect(conversation.liveState.entries().filter(([key]) => key.includes("/slow/"))).toEqual([]);
		expect(offered[0]).toContain("slow_tool");
		expect(offered[1]).not.toContain("slow_tool");
		expect(session.extensionRegistry.get("slow")?.state).toBe("disabled");
	});

	it("enables an extension with unacknowledged permissions only after the invoking local client acknowledges them", async () => {
		const harness = await setup([
			{
				manifest: { id: "privileged", displayName: "Privileged", permissions: ["exec"] },
				factory: () => {},
			},
		]);
		let decision: "approved" | "denied" = "denied";
		const asked: string[] = [];
		let tui: HostedConversation | undefined;
		const tuiLive = liveClient((requestId, kind) => {
			asked.push(kind);
			tui?.liveState.answer(requestId, { decision }, "tui");
		});
		const { conversation, context } = await open(harness, "tui", tuiLive);
		tui = conversation;
		// Another client of the conversation never sees the request.
		const phone = liveClient();
		const detachPhone = conversation.liveState.attach("phone", phone);
		cleanups.push(async () => detachPhone());
		const store = new ExtensionPermissionStore(harness.tempDir);
		const registry = conversation.session.extensionRegistry;

		// Startup runs it without asking.
		expect(await summary(context(), "privileged")).toMatchObject({
			state: "active",
			permissions: ["exec"],
			permissionsAcknowledged: false,
		});

		// A remote client needs host management, and may disable it.
		await expect(
			intentRegistry.invokeFrame(
				context(remote("conversation.observe.v1", "conversation.control.v1")),
				"set_extension_enabled",
				{
					id: "privileged",
					enabled: false,
					scope: "global",
				},
			),
		).rejects.toMatchObject({ code: "not_allowed", requiredCapability: "host.manage.v1" });
		const manager = remote("conversation.observe.v1", "conversation.control.v1", "host.manage.v1");
		await intentRegistry.invokeFrame(context(manager), "set_extension_enabled", {
			id: "privileged",
			enabled: false,
			scope: "global",
		});
		await registry.settled();
		expect(registry.get("privileged")?.state).toBe("disabled");

		// It may not enable it while its permissions are unacknowledged.
		await expect(
			intentRegistry.invokeFrame(context(manager), "set_extension_enabled", {
				id: "privileged",
				enabled: true,
				scope: "global",
			}),
		).rejects.toMatchObject({ code: "not_allowed", message: expect.stringContaining("not acknowledged") });
		expect(asked).toEqual([]);
		expect(registry.get("privileged")?.state).toBe("disabled");
		expect(conversation.session.settingsManager.getExtensionEnabled("privileged")).toBe(false);

		// A local client is asked; declining keeps it disabled.
		await expect(
			intentRegistry.invoke(context(), "set_extension_enabled", {
				id: "privileged",
				enabled: true,
				scope: "global",
			}),
		).rejects.toMatchObject({ code: "not_allowed" });
		expect(asked).toEqual(["approval"]);
		expect(registry.get("privileged")?.state).toBe("disabled");
		const subject = permissionSubject({
			id: "privileged",
			fingerprint: "sdk:privileged",
			manifest: { permissions: ["exec"] },
		});
		expect(store.isAcknowledged(subject)).toBe(false);

		decision = "approved";
		await intentRegistry.invoke(context(), "set_extension_enabled", {
			id: "privileged",
			enabled: true,
			scope: "global",
		});
		expect(asked).toEqual(["approval", "approval"]);
		expect(registry.get("privileged")?.state).toBe("active");
		expect(store.isAcknowledged(subject)).toBe(true);
		expect((await summary(context(), "privileged"))?.permissionsAcknowledged).toBe(true);
		expect(phone.items.some((item) => item.type === "set" && item.value.kind === "host_request")).toBe(false);

		// Acknowledged, a remote client with host management may enable it again.
		await intentRegistry.invokeFrame(context(manager), "set_extension_enabled", {
			id: "privileged",
			enabled: false,
			scope: "global",
		});
		await registry.settled();
		await intentRegistry.invokeFrame(context(manager), "set_extension_enabled", {
			id: "privileged",
			enabled: true,
			scope: "global",
		});
		expect(registry.get("privileged")?.state).toBe("active");
		expect(asked).toHaveLength(2);
	});

	it("unregisters the providers an extension registered through its context, keeping the others'", async () => {
		const harness = await setup([
			{
				manifest: { id: "provider-ext", displayName: "Provider", permissions: ["providers"] },
				factory: (volt) => {
					volt.on("session_start", (_event, ctx) => {
						ctx.modelRegistry.registerProvider("ext-provider", {
							baseUrl: "https://ext.example.test",
							apiKey: "ext-key",
							api: "openai-completions",
							models: [
								{
									id: "ext-model",
									name: "Ext model",
									reasoning: false,
									input: ["text"],
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
									contextWindow: 1000,
									maxTokens: 100,
								},
							],
						});
						ctx.modelRegistry.client.registerOAuthProvider({
							id: "ext-oauth",
							name: "Ext OAuth",
							login: async () => ({ access: "a", refresh: "r", expires: 0 }),
							refreshToken: async (credentials) => credentials,
							getApiKey: () => "k",
						});
					});
				},
			},
		]);
		const { conversation, context } = await open(harness, "tui");
		const registry = conversation.session.modelRegistry;
		expect(registry.find("ext-provider", "ext-model")).toBeDefined();
		expect(registry.client.getOAuthProvider("ext-oauth")).toBeDefined();
		await intentRegistry.invoke(context(), "set_extension_enabled", {
			id: "provider-ext",
			enabled: false,
			scope: "global",
		});
		await conversation.session.extensionRegistry.settled();
		expect(registry.find("ext-provider", "ext-model")).toBeUndefined();
		expect(registry.client.getOAuthProvider("ext-oauth")).toBeUndefined();
		// The recording extension's provider stays.
		expect(registry.find(harness.faux.getModel().provider, harness.faux.getModel().id)).toBeDefined();
	});

	it("stores project choices only for a trusted project, and knows only the conversation's extensions", async () => {
		const harness = await setup([{ manifest: { id: "plain", displayName: "Plain" }, factory: () => {} }]);
		const { conversation, context } = await open(harness, "tui");
		await expect(
			intentRegistry.invoke(context(), "set_extension_enabled", { id: "missing", enabled: false, scope: "global" }),
		).rejects.toMatchObject({ code: "invalid_input" });
		await intentRegistry.invoke(context(), "set_extension_enabled", {
			id: "plain",
			enabled: false,
			scope: "project",
		});
		await conversation.session.extensionRegistry.settled();
		expect(conversation.session.settingsManager.getStoredExtensionEnabled("plain", "project")).toBe(false);
		expect(conversation.session.extensionRegistry.get("plain")?.state).toBe("disabled");
		conversation.session.settingsManager.setProjectTrusted(false);
		await expect(
			intentRegistry.invoke(context(), "set_extension_enabled", { id: "plain", enabled: true, scope: "project" }),
		).rejects.toMatchObject({ code: "not_allowed" });
	});

	it("starts and stops the extension in every open conversation", async () => {
		const instances: Instance[] = [];
		const harness = await setup([contributing(instances)]);
		const first = await open(harness, "tui");
		const second = await open(harness, "phone");
		expect(instances).toHaveLength(2);
		await intentRegistry.invoke(first.context(), "set_extension_enabled", {
			id: "toggled",
			enabled: false,
			scope: "global",
		});
		await vi.waitFor(() =>
			expect(second.conversation.session.extensionRegistry.get("toggled")?.state).toBe("disabled"),
		);
		await first.conversation.session.extensionRegistry.settled();
		expect(instances.map((instance) => instance.events.at(-1))).toEqual(["deactivate:disable", "deactivate:disable"]);
		await intentRegistry.invoke(second.context(), "set_extension_enabled", {
			id: "toggled",
			enabled: true,
			scope: "global",
		});
		await vi.waitFor(() => expect(first.conversation.session.extensionRegistry.get("toggled")?.state).toBe("active"));
		expect(instances).toHaveLength(4);
	});

	it("never runs an extension settings disable at startup, and runs it once enabled", async () => {
		const instances: Instance[] = [];
		const harness = await setup([contributing(instances)], {
			settings: { extensions: { toggled: { enabled: false } } },
		});
		const { conversation, context } = await open(harness, "tui");
		expect(instances).toEqual([]);
		expect(await summary(context(), "toggled")).toMatchObject({ state: "disabled", enabled: false });
		expect(conversation.session.getActiveToolNames()).not.toContain("toggled_tool");
		await intentRegistry.invoke(context(), "set_extension_enabled", {
			id: "toggled",
			enabled: true,
			scope: "global",
		});
		expect(instances).toHaveLength(1);
		expect(instances[0]?.events).toEqual(["activate:enable", "session_start:enable"]);
		expect(conversation.session.getActiveToolNames()).toContain("toggled_tool");
	});

	it("picks up an extension installed or removed since without a reload", async () => {
		const harness = await setup([]);
		const { conversation, context } = await open(harness, "tui");
		const session = conversation.session;
		const dir = join(harness.tempDir, "extensions");
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "late.ts");
		writeFileSync(
			file,
			'export const manifest = { id: "late", displayName: "Late" };\nexport default function (volt) {\n\tvolt.registerCommand("late-cmd", { handler: async () => {} });\n}\n',
		);
		await session.rescanExtensions();
		expect(await summary(context(), "late")).toMatchObject({ state: "active", scope: "user" });
		expect(session.extensionRunner.getRegisteredCommands().map((command) => command.name)).toContain("late-cmd");

		rmSync(file);
		await session.rescanExtensions();
		await session.extensionRegistry.settled();
		expect(await summary(context(), "late")).toBeUndefined();
		expect(session.extensionRunner.getRegisteredCommands().map((command) => command.name)).not.toContain("late-cmd");
	});

	it("lists an extension that failed to load, and tries it again when enabled", async () => {
		let fail = true;
		const harness = await setup([
			{
				manifest: { id: "flaky", displayName: "Flaky" },
				factory: (volt) => {
					volt.registerCommand("flaky-cmd", { handler: async () => {} });
					if (fail) throw new Error("not today");
				},
			},
		]);
		const { conversation, context } = await open(harness, "tui");
		expect(await summary(context(), "flaky")).toMatchObject({
			state: "failed",
			enabled: true,
			error: expect.stringContaining("not today"),
		});
		expect(conversation.session.extensionRunner.getRegisteredCommands()).toEqual([]);
		fail = false;
		await intentRegistry.invoke(context(), "set_extension_enabled", { id: "flaky", enabled: true, scope: "global" });
		expect(await summary(context(), "flaky")).toMatchObject({ state: "active" });
		expect(conversation.session.extensionRunner.getRegisteredCommands().map((command) => command.name)).toEqual([
			"flaky-cmd",
		]);
	});
});
