/**
 * Extension intents, shortcuts, and completion providers (RFC §8.3):
 * `volt.registerIntent` intents run through the intent registry with input
 * checked against their schema, remote clients reach only those that opted
 * in; shortcuts bind only the extension's own intents and commands; and the
 * `editor_completions` query asks the completion providers within its bounds.
 */

import { EDITOR_COMPLETION_TEXT_MAX_CHARS, type HostFrame, type RemoteCapability } from "@hansjm10/volt-protocol";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionError } from "../../src/core/extensions/index.ts";
import {
	type IntentContext,
	type IntentProfile,
	intentRegistry,
	LOCAL_INTENT_PROFILE,
} from "../../src/core/protocol/intents/index.ts";
import { localProfile, type Profile, remoteProfile } from "../../src/core/protocol/profiles.ts";
import { queryRegistry } from "../../src/core/protocol/queries/index.ts";
import { serveConnection } from "../../src/core/protocol/server/connection.ts";
import { createLoopbackRpcTransportPair } from "../../src/core/protocol/transport/index.ts";
import { connectTestClient, type TestClient } from "../utilities/host-client.ts";
import { createExtensionRuntime, type ExtensionRuntime } from "./extension-runtime.ts";

const EXTENSION = "test-extension";

function remote(...capabilities: RemoteCapability[]): IntentProfile {
	return { name: "remote", grant: { schemaVersion: 1, revision: 1, capabilities } };
}

async function setup(factory: (volt: ExtensionAPI) => void) {
	const fixture = await createExtensionRuntime(factory, { extensionMode: "rpc" });
	const errors: ExtensionError[] = [];
	const client = await connectTestClient(fixture.host, fixture.conversation, {
		id: "client",
		surface: { onError: (error) => errors.push(error) },
	});
	const context = (profile: IntentProfile = LOCAL_INTENT_PROFILE): IntentContext => ({
		target: { session: client.session, conversation: client.conversation, host: client.host, client: client.client },
		services: {},
		profile,
	});
	return { fixture, client, errors, context };
}

describe("extension intents", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		vi.useRealTimers();
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	function track(fixture: ExtensionRuntime, client: TestClient): void {
		cleanups.push(async () => {
			await client.dispose();
			await fixture.dispose();
		});
	}

	it("runs a registered intent with checked input in the extension's own context", async () => {
		const runs: Array<{ input: unknown; ctx: ExtensionCommandContext }> = [];
		let name = "";
		const input = Type.Object(
			{
				target: Type.String({ description: "A target such as /home/ada/deploys/prod", pattern: "^[a-z/]+$" }),
				region: Type.Optional(Type.Union([Type.Literal("eu"), Type.Literal("/home/ada/regions/us")])),
				dryRun: Type.Optional(Type.Boolean()),
			},
			{ additionalProperties: false },
		);
		const { fixture, client, errors, context } = await setup((volt) => {
			name = volt.registerIntent("deploy", {
				label: "Deploy",
				description: "Ship the build",
				input,
				handler: async (input, ctx) => {
					runs.push({ input, ctx });
					ctx.ui.setStatus("deploy", `deploying ${input.target}`);
				},
			});
			volt.registerIntent("broken", {
				label: "Broken",
				handler: () => {
					throw new Error("no deploy today");
				},
			});
		});
		track(fixture, client);
		expect(name).toBe(`extension.intent.${EXTENSION}.deploy`);

		await intentRegistry.invokeFrame(context(), name, { target: "prod" });
		expect(runs.map((run) => run.input)).toEqual([{ target: "prod" }]);
		// The registered schema is the extension's copy: changing the original afterwards changes nothing.
		(input.properties as Record<string, unknown>).extra = Type.String();
		await expect(intentRegistry.invokeFrame(context(), name, { target: "prod", extra: "x" })).rejects.toMatchObject({
			code: "invalid_input",
		});
		expect(fixture.conversation.liveState.get(`ext_status/${EXTENSION}/deploy`)).toMatchObject({
			text: "deploying prod",
		});

		await expect(intentRegistry.invokeFrame(context(), name, { target: 3 })).rejects.toMatchObject({
			code: "invalid_input",
		});
		await expect(intentRegistry.invokeFrame(context(), name, { target: "prod", extra: 1 })).rejects.toMatchObject({
			code: "invalid_input",
		});
		await expect(
			intentRegistry.invokeFrame(context(), `extension.intent.${EXTENSION}.missing`, {}),
		).rejects.toMatchObject({ code: "unknown_intent" });
		await expect(
			intentRegistry.invokeFrame(context(), `extension.intent.${EXTENSION}.broken`, {}),
		).rejects.toMatchObject({ code: "failed", message: "no deploy today" });
		expect(errors).toContainEqual(expect.objectContaining({ extensionId: EXTENSION, event: "intent" }));
		expect(runs).toHaveLength(1);

		const descriptor = intentRegistry
			.descriptors(
				{ state: { isStreaming: false, isCompacting: false }, services: {}, profile: LOCAL_INTENT_PROFILE },
				context().target,
			)
			.find((intent) => intent.name === name);
		expect(descriptor).toMatchObject({
			label: "Deploy",
			description: "Ship the build",
			source: "extension",
			sourceLabel: EXTENSION,
			remote: "unsafe",
			requires: ["conversation.control.v1"],
			input: { type: "object", required: ["target"] },
			enabled: true,
		});
		// Its text reaches clients with host paths redacted, its patterns as they are.
		expect(JSON.stringify(descriptor?.input)).not.toContain("/home/ada");
		expect(descriptor?.input).toMatchObject({ properties: { target: { pattern: "^[a-z/]+$" } } });
		// Input over the host's bound is refused before the schema tests it.
		await expect(intentRegistry.invokeFrame(context(), name, { target: "a".repeat(70_000) })).rejects.toMatchObject({
			code: "invalid_input",
			message: expect.stringContaining("larger than"),
		});
		expect(descriptor?.input).toMatchObject({
			properties: { target: { description: "A target such as [redacted path]" } },
		});
	});

	it("admits remote clients only to intents that opted in, with the capabilities they need", async () => {
		const ran: string[] = [];
		const { fixture, client, context } = await setup((volt) => {
			volt.registerIntent("local", { label: "Local", handler: () => void ran.push("local") });
			volt.registerIntent("phone", { label: "Phone", remote: true, handler: () => void ran.push("phone") });
			volt.registerIntent("admin", {
				label: "Admin",
				remote: true,
				requires: ["host.manage.v1"],
				handler: () => void ran.push("admin"),
			});
		});
		track(fixture, client);
		const intent = (name: string) => `extension.intent.${EXTENSION}.${name}`;
		const control = remote("conversation.observe.v1", "conversation.control.v1");

		await expect(intentRegistry.invokeFrame(context(control), intent("local"), {})).rejects.toMatchObject({
			code: "not_allowed",
		});
		await expect(
			intentRegistry.invokeFrame(context(remote("conversation.observe.v1")), intent("phone"), {}),
		).rejects.toMatchObject({ code: "not_allowed", requiredCapability: "conversation.control.v1" });
		await intentRegistry.invokeFrame(context(control), intent("phone"), {});
		await expect(intentRegistry.invokeFrame(context(control), intent("admin"), {})).rejects.toMatchObject({
			code: "not_allowed",
			requiredCapability: "host.manage.v1",
		});
		await intentRegistry.invokeFrame(
			context(remote("conversation.control.v1", "host.manage.v1")),
			intent("admin"),
			{},
		);
		expect(ran).toEqual(["phone", "admin"]);

		const names = intentRegistry
			.descriptors(
				{ state: { isStreaming: false, isCompacting: false }, services: {}, profile: control },
				context().target,
			)
			.map((descriptor) => descriptor.name)
			.filter((name) => name.startsWith("extension.intent."));
		expect(names).toEqual([intent("phone"), intent("admin")]);
	});

	it("admits extension intent frames on the wire, unfenced, on the local and remote profiles", async () => {
		const ran: unknown[] = [];
		const { fixture, client } = await setup((volt) => {
			volt.registerIntent("phone", {
				label: "Phone",
				remote: true,
				input: Type.Object({ count: Type.Integer() }),
				handler: (input) => void ran.push(input),
			});
			volt.registerIntent("local", { label: "Local", handler: () => void ran.push("local") });
		});
		track(fixture, client);
		const intent = (name: string) => `extension.intent.${EXTENSION}.${name}`;
		const connect = async (profile: Profile) => {
			const pair = createLoopbackRpcTransportPair();
			const connection = serveConnection(pair.server, profile, {
				host: fixture.host,
				conversation: fixture.conversation,
			});
			const frames: HostFrame[] = [];
			pair.client.onValue?.((value) => {
				frames.push(value as HostFrame);
			});
			cleanups.push(async () => {
				await pair.client.close();
				await connection.closed.catch(() => undefined);
			});
			void pair.client.write({
				type: "hello",
				protocol: 1,
				client: { name: "test", version: "1" },
				accepts: { hostRequests: [] },
			});
			await connection.ready;
			const send = async (frame: Record<string, unknown>): Promise<HostFrame> => {
				void pair.client.write(frame);
				let outcome: HostFrame | undefined;
				await vi.waitFor(() => {
					outcome = frames.find(
						(candidate) =>
							(candidate.type === "accepted" || candidate.type === "rejected" || candidate.type === "fatal") &&
							(candidate.type === "fatal" || candidate.intentId === frame.intentId),
					);
					expect(outcome).toBeDefined();
				});
				return outcome!;
			};
			return send;
		};

		const local = await connect(localProfile);
		await expect(local({ type: intent("phone"), intentId: "l1", input: { count: 2 } })).resolves.toMatchObject({
			type: "accepted",
		});
		await expect(local({ type: intent("phone"), intentId: "l2", input: { count: "2" } })).resolves.toMatchObject({
			type: "rejected",
			reason: { code: "invalid_input" },
		});

		const remote = await connect(
			remoteProfile({
				grant: {
					schemaVersion: 1,
					revision: 1,
					capabilities: ["conversation.observe.v1", "conversation.control.v1"],
				},
				redaction: { workspacePath: fixture.conversation.cwd },
				bound: fixture.conversation.id,
			}),
		);
		// No expectedOrdinal: extension intents are not fenced to the branch.
		await expect(remote({ type: intent("phone"), intentId: "r1", input: { count: 3 } })).resolves.toMatchObject({
			type: "accepted",
		});
		await expect(remote({ type: intent("local"), intentId: "r2" })).resolves.toMatchObject({
			type: "rejected",
			reason: { code: "not_allowed" },
		});
		expect(ran).toEqual([{ count: 2 }, { count: 3 }]);
	});

	it("checks intent, shortcut, and completion provider registrations", async () => {
		const failures: string[] = [];
		const attempt = (run: () => unknown): void => {
			try {
				run();
			} catch (error) {
				failures.push(error instanceof Error ? error.message : String(error));
			}
		};
		const { fixture, client } = await setup((volt) => {
			attempt(() => volt.registerIntent("bad name", { label: "x", handler: () => {} }));
			attempt(() => volt.registerIntent("ok", { label: "", handler: () => {} }));
			attempt(() => volt.registerIntent("ok", { label: "x", input: Type.String() as never, handler: () => {} }));
			attempt(() =>
				volt.registerIntent("ok", { label: "x", requires: ["root.v1" as RemoteCapability], handler: () => {} }),
			);
			attempt(() =>
				volt.registerIntent("ok", {
					label: "x",
					input: Type.Object({ s: Type.String({ pattern: "(a+)+$" }) }),
					handler: () => {},
				}),
			);
			attempt(() =>
				volt.registerIntent("ok", {
					label: "x",
					input: Type.Object({ s: Type.String({ pattern: "a+b" }) }),
					handler: () => {},
				}),
			);
			attempt(() =>
				volt.registerIntent("ok", {
					label: "x",
					input: { type: "object", properties: {}, patternProperties: { "^x": {} } } as never,
					handler: () => {},
				}),
			);
			attempt(() =>
				volt.registerIntent("ok", {
					label: "x",
					input: Type.Object({ s: Type.String({ description: "d".repeat(5_000) }) }),
					handler: () => {},
				}),
			);
			const own = volt.registerIntent("ok", { label: "Ok", handler: () => {} });
			attempt(() => volt.registerIntent("ok", { label: "Ok", handler: () => {} }));
			volt.registerShortcut("ctrl+shift+o", { intent: own });
			volt.registerShortcut("ctrl+shift+k", { intent: "ok" });
			volt.registerShortcut("ctrl+shift+j", { intent: `extension.command.${EXTENSION}.ship` });
			attempt(() => volt.registerShortcut("ctrl+shift+l", { intent: "extension.intent.other.ok" }));
			attempt(() => volt.registerShortcut("ctrl+shift+m", { intent: "extension.command.other.ship" }));
			attempt(() => volt.registerCompletionProvider("issues", { trigger: "# ", complete: () => [] }));
			attempt(() => volt.registerCompletionProvider("issues", { trigger: "", complete: () => [] }));
			volt.registerCompletionProvider("issues", { trigger: "#", complete: () => [] });
			attempt(() => volt.registerCompletionProvider("issues", { trigger: "@", complete: () => [] }));
		});
		track(fixture, client);
		expect(failures).toEqual([
			expect.stringContaining("Invalid intent name"),
			expect.stringContaining("label must be"),
			expect.stringContaining("TypeBox object schema"),
			expect.stringContaining("remote capabilities"),
			expect.stringContaining("must not repeat a repeating group"),
			expect.stringContaining("must be anchored"),
			expect.stringContaining("patternProperties"),
			expect.stringContaining("larger than"),
			"Intent ok is already registered",
			expect.stringContaining("only its own intents and commands"),
			expect.stringContaining("only its own intents and commands"),
			expect.stringContaining("without whitespace"),
			expect.stringContaining("without whitespace"),
			"Completion provider issues is already registered",
		]);
		const runner = client.session.extensionRunner;
		const shortcuts = runner.getExtensions().flatMap((extension) => [...extension.shortcuts.values()]);
		expect(shortcuts.map((shortcut) => [shortcut.shortcut, shortcut.intent])).toEqual([
			["ctrl+shift+o", `extension.intent.${EXTENSION}.ok`],
			["ctrl+shift+k", `extension.intent.${EXTENSION}.ok`],
			["ctrl+shift+j", `extension.command.${EXTENSION}.ship`],
		]);
	});

	it("completes the editor's token from the providers its trigger names, within the query's bounds", async () => {
		const asked: Array<{ prefix: string; query: string; cursor: number }> = [];
		let hang = false;
		const { fixture, client, errors, context } = await setup((volt) => {
			volt.registerCompletionProvider("broken", {
				trigger: "#",
				complete: () => {
					throw new Error("offline");
				},
			});
			volt.registerCompletionProvider("issues", {
				trigger: "#",
				remote: true,
				complete: ({ prefix, query, cursor, signal }) => {
					asked.push({ prefix, query, cursor });
					if (hang) return new Promise((resolve) => signal.addEventListener("abort", () => resolve(undefined)));
					return Array.from({ length: 80 }, (_, index) => ({
						value: `#${index}`,
						label: `\u001b[1m#${index}\u001b[0m`,
						description: "d".repeat(2 * EDITOR_COMPLETION_TEXT_MAX_CHARS),
					}));
				},
			});
			volt.registerCompletionProvider("people", { trigger: "@", complete: () => [{ value: "@ada" }] });
		});
		track(fixture, client);

		const answer = await queryRegistry.run(context(), "editor_completions", { text: "fix #4 now", cursor: 6 });
		expect(answer.prefix).toBe("#4");
		expect(answer.items).toHaveLength(50);
		expect(answer.items[0]).toEqual({
			value: "#0",
			label: "#0",
			description: "d".repeat(EDITOR_COMPLETION_TEXT_MAX_CHARS),
		});
		expect(asked).toEqual([{ prefix: "#4", query: "4", cursor: 6 }]);
		expect(errors).toContainEqual(
			expect.objectContaining({ extensionId: EXTENSION, event: "completion", error: "offline" }),
		);

		await expect(queryRegistry.run(context(), "editor_completions", { text: "ping @a", cursor: 7 })).resolves.toEqual(
			{
				prefix: "@a",
				items: [{ value: "@ada" }],
			},
		);
		await expect(queryRegistry.run(context(), "editor_completions", { text: "plain", cursor: 5 })).resolves.toEqual({
			prefix: "plain",
			items: [],
		});
		// A remote client asks only the providers that opted in.
		const phone = context(remote("conversation.control.v1"));
		await expect(queryRegistry.run(phone, "editor_completions", { text: "@a", cursor: 2 })).resolves.toEqual({
			prefix: "@a",
			items: [],
		});
		expect((await queryRegistry.run(phone, "editor_completions", { text: "#1", cursor: 2 })).items).toHaveLength(50);
		await expect(
			queryRegistry.run(context(remote("conversation.observe.v1")), "editor_completions", { text: "#1", cursor: 2 }),
		).rejects.toMatchObject({ code: "not_allowed" });

		// The host waits at most a second for the providers.
		vi.useFakeTimers();
		hang = true;
		const slow = queryRegistry.run(context(), "editor_completions", { text: "#9", cursor: 2 });
		await vi.advanceTimersByTimeAsync(1_000);
		await expect(slow).resolves.toEqual({ prefix: "#9", items: [] });
	});
});
