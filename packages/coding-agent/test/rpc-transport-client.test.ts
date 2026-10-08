/**
 * The in-process loopback transport, and a protocol 1 client of an in-process
 * host (docs/rpc.md): the model catalog and model intents, the run phase,
 * built-in and dynamic intents and their completions, host requests asked
 * while extensions bind, startup failures, and anchoring. A paired device sees
 * the same dynamic intents on the remote profile, limited to remote-safe ones.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxProvider, type FauxResponseFactory, fauxAssistantMessage } from "@hansjm10/volt-ai";
import { type HostFrame, type IntentDescriptor, REMOTE_CAPABILITIES, type RemoteGrant } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, test, vi } from "vitest";
import { createLoopbackClient, ProtocolClient } from "../src/client/protocol-client.ts";
import { githubCliCodeHostProvider } from "../src/core/code-host/index.ts";
import type { HostedConversation } from "../src/core/host/hosted-conversation.ts";
import { localProfile } from "../src/core/protocol/profiles.ts";
import { serveConnection } from "../src/core/protocol/server/connection.ts";
import { createLoopbackRpcTransportPair } from "../src/core/protocol/transport/index.ts";
import { serveIrohRemoteConnection } from "../src/core/remote/iroh/connection.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createHostHarness, type HostHarness, type HostHarnessOptions } from "./suite/host-harness.ts";
import { createIrohStreamPair } from "./utilities/iroh-stream-pair.ts";
import { connectRemotePhone } from "./utilities/remote-phone.ts";

const ALL: RemoteGrant = { schemaVersion: 1, revision: 1, capabilities: [...REMOTE_CAPABILITIES] };

describe("loopback RPC transport", () => {
	test("buffers writes until a peer line handler attaches and preserves JSON string separators", () => {
		const pair = createLoopbackRpcTransportPair();
		const receivedLines: string[] = [];

		pair.client.write({ text: "a b c" });
		pair.server.onLine((line) => {
			receivedLines.push(line);
		});

		expect(receivedLines).toEqual([JSON.stringify({ text: "a b c" })]);
	});

	test("closing one endpoint notifies the peer input", () => {
		const pair = createLoopbackRpcTransportPair();
		const closeHandler = vi.fn();
		pair.server.onClose?.(closeHandler);

		pair.client.close();

		expect(closeHandler).toHaveBeenCalledOnce();
	});
});

/** A turn response that waits until released, or until the run is aborted. */
function gatedResponse(text: string): { response: FauxResponseFactory; release: () => void } {
	const gate = Promise.withResolvers<void>();
	return {
		response: async (_context, options) => {
			options?.signal?.addEventListener("abort", () => gate.resolve(), { once: true });
			await gate.promise;
			return fauxAssistantMessage(text);
		},
		release: () => gate.resolve(),
	};
}

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "ignore" });
}

function userTexts(client: ProtocolClient): Array<string | undefined> {
	return client.state.entries.flatMap((entry) =>
		entry.type === "message" && entry.view?.role === "user" ? [entry.view.text] : [],
	);
}

function hostRequestIdOf(frame: HostFrame): string | undefined {
	if (frame.type !== "live") return undefined;
	for (const item of frame.items) {
		if (item.type === "set" && item.value.kind === "host_request") return item.value.requestId;
	}
	return undefined;
}

describe("protocol client of an in-process host", () => {
	const cleanups: Array<() => Promise<void> | void> = [];
	afterEach(async () => {
		vi.restoreAllMocks();
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function setup(
		options: HostHarnessOptions = {},
	): Promise<{ harness: HostHarness; conversation: HostedConversation }> {
		const harness = await createHostHarness(options);
		cleanups.push(() => harness.cleanup());
		return { harness, conversation: await harness.openStartup() };
	}

	async function connect(
		harness: HostHarness,
		conversation: HostedConversation,
		options: Parameters<typeof createLoopbackClient>[2] = {},
	): Promise<ProtocolClient> {
		const client = await createLoopbackClient(harness.host, conversation, options);
		cleanups.push(() => client.stop());
		return client;
	}

	function tempDir(prefix: string): string {
		const dir = mkdtempSync(join(tmpdir(), prefix));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		return dir;
	}

	it("serves the model catalog and switches the conversation's model and thinking level", async () => {
		const second = createFauxProvider({ provider: "faux-b", models: [{ id: "faux-2", reasoning: true }] });
		const { harness, conversation } = await setup({
			extension: (volt) => {
				volt.registerProvider("faux-b", {
					baseUrl: second.getModel().baseUrl,
					apiKey: "faux-key",
					api: second.api,
					streamSimple: second.streamSimple,
					models: second.models.map((model) => ({
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
			},
		});
		const client = await connect(harness, conversation);

		const catalog = await client.query("models");
		expect(catalog.models.map((model) => `${model.provider}/${model.id}`)).toEqual(
			expect.arrayContaining([`${harness.faux.getModel().provider}/faux-1`, "faux-b/faux-2"]),
		);

		await client.intent("set_model", { provider: "faux-b", modelId: "faux-2" });
		await vi.waitFor(() => expect(client.state.model).toEqual({ provider: "faux-b", modelId: "faux-2" }));
		expect(conversation.session.model?.id).toBe("faux-2");
		await expect(client.intent("set_model", { provider: "faux-b", modelId: "missing" })).rejects.toMatchObject({
			reason: { code: "failed", message: "Model not found: faux-b/missing" },
		});

		await client.intent("set_thinking_level", { level: "low" });
		await vi.waitFor(() => expect(client.state.thinkingLevel).toBe("low"));
		expect(conversation.session.thinkingLevel).toBe("low");
	});

	it("carries the active run's start and a compaction's reason in the live phase", async () => {
		const compactionGate = Promise.withResolvers<void>();
		const { harness, conversation } = await setup({
			extension: (volt) => {
				volt.on("session_before_compact", async (event) => {
					await compactionGate.promise;
					return {
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: 999,
						},
					};
				});
			},
		});
		const turn = gatedResponse("streamed");
		harness.faux.setResponses([turn.response, fauxAssistantMessage("two")]);
		const client = await connect(harness, conversation);
		const before = Date.now();

		await client.prompt("first");
		await vi.waitFor(() =>
			expect(client.phase).toMatchObject({ busy: true, operation: "turn", run: { startedAt: expect.any(Number) } }),
		);
		expect(client.phase?.run?.startedAt).toBeGreaterThanOrEqual(before);
		turn.release();
		await client.waitForIdle(10_000);
		expect(client.phase?.run).toBeUndefined();

		await client.promptAndWait("second", { timeoutMs: 10_000 });
		const compacted = client.intent("compact", {});
		await vi.waitFor(() =>
			expect(client.phase).toMatchObject({
				busy: true,
				compaction: { reason: "manual", startedAt: expect.any(Number) },
			}),
		);
		compactionGate.resolve();
		await expect(compacted).resolves.toMatchObject({
			type: "accepted",
			result: { summary: "summary from extension", tokensBefore: 999 },
		});
		await vi.waitFor(() => expect(client.phase?.compaction).toBeUndefined());
	});

	it("cancels a streaming run, and admits a detached review while it streams", async () => {
		const { harness, conversation } = await setup();
		const turn = gatedResponse("never finished");
		harness.faux.setResponses([turn.response]);
		cleanups.push(() => turn.release());
		const client = await connect(harness, conversation);

		const { intents } = await client.query("intents");
		const named = (name: string): IntentDescriptor | undefined => intents.find((intent) => intent.name === name);
		expect(named("abort")).toMatchObject({ label: "Cancel run", source: "builtin", remote: "safe" });
		expect(named("new_session")).toMatchObject({ slash: { name: "clear", example: "/clear" }, remote: "safe" });
		expect(named("set_session_name")).toMatchObject({ slash: { name: "name" }, remote: "unsafe" });
		expect(named("review")).toMatchObject({
			category: "review",
			presentation: { kind: "card", group: "Review" },
			confirm: {},
			remote: "safe",
		});
		expect(Object.keys(named("review")?.input.properties as object)).toEqual([
			"target",
			"base",
			"number",
			"url",
			"ref",
			"engine",
			"engineParams",
			"focus",
			"scope",
			"effort",
			"includeOptional",
			"scopeMode",
			"tools",
		]);

		await client.prompt("long running");
		await vi.waitFor(() => expect(conversation.session.isStreaming).toBe(true));
		// Detached reviews stay available while the agent streams; outside a repository the preflight fails.
		await expect(client.intent("review", { target: "uncommitted" })).rejects.toMatchObject({
			reason: { code: "failed", message: "Not inside a git repository." },
		});
		await expect(client.intent("review", { target: "branch", base: "main" })).rejects.toMatchObject({
			reason: { code: "failed", message: "Not inside a git repository." },
		});
		// A target takes only its own fields, and a commit review needs its ref.
		await expect(client.intent("review", { target: "commit" })).rejects.toMatchObject({
			reason: { code: "invalid_input", message: "A commit review needs a ref" },
		});
		await expect(client.intent("review", { target: "pr", base: "main" })).rejects.toMatchObject({
			reason: { code: "invalid_input", message: "base does not apply to a pr review" },
		});
		await expect(client.intent("review", { target: "branch", ref: "abc" })).rejects.toMatchObject({
			reason: { code: "invalid_input", message: "ref does not apply to a branch review" },
		});
		// A branch review with the uncommitted changes takes a base like a branch review.
		await expect(client.intent("review", { target: "branch_uncommitted", base: "main" })).rejects.toMatchObject({
			reason: { code: "failed", message: "Not inside a git repository." },
		});
		await expect(client.intent("review", { target: "branch_uncommitted", ref: "abc" })).rejects.toMatchObject({
			reason: { code: "invalid_input", message: "ref does not apply to a branch_uncommitted review" },
		});

		await client.intent("abort", {});
		await client.waitForIdle(10_000);
		expect(conversation.session.isStreaming).toBe(false);
	});

	it("lists dynamic intents without host paths and runs them as prompts", async () => {
		const resources = tempDir("volt-intent-resources-");
		mkdirSync(join(resources, "prompts"));
		writeFileSync(
			join(resources, "prompts", "fix-tests.md"),
			`---\ndescription: Fix tests using ${resources}/logs/failure.log\nargument-hint: paste failing test output\n---\nFix $ARGUMENTS\n`,
		);
		mkdirSync(join(resources, "skills", "debugger"), { recursive: true });
		writeFileSync(
			join(resources, "skills", "debugger", "SKILL.md"),
			"---\nname: debugger\ndescription: Debug issues\n---\nRead the stack first.\n",
		);
		const deployed: string[] = [];
		const { harness, conversation } = await setup({
			extension: (volt) => {
				volt.on("resources_discover", () => ({
					promptPaths: [join(resources, "prompts", "fix-tests.md")],
					skillPaths: [join(resources, "skills")],
				}));
				volt.registerCommand("deploy", {
					description: `Deploy from ${resources}/services/api`,
					remoteSafe: true,
					getArgumentCompletions: (prefix) => [
						{ value: `${prefix}-prod`, label: "Production", description: "Production target" },
					],
					handler: async (args) => {
						deployed.push(args);
					},
				});
			},
		});
		const client = await connect(harness, conversation);

		const { intents } = await client.query("intents");
		const builtins = intents.filter((intent) => intent.source === "builtin");
		const dynamic = intents.filter((intent) => intent.source !== "builtin");
		expect(builtins.length).toBeGreaterThan(0);
		// Built-in intents first, then extension commands, prompt templates, and skills.
		expect(intents.slice(0, builtins.length)).toEqual(builtins);
		expect(dynamic.map((intent) => intent.name)).toEqual([
			"extension.command.test-extension.deploy",
			expect.stringMatching(/^prompt\.template\.pt_[a-f0-9]{12}_1$/),
			expect.stringMatching(/^skill\.sk_[a-f0-9]{12}_1$/),
		]);
		expect(dynamic.map((intent) => intent.slash?.name)).toEqual(["deploy", "fix-tests", "skill:debugger"]);
		expect(dynamic.map((intent) => intent.category)).toEqual(["extension", "prompt", "skill"]);
		expect(dynamic.map((intent) => intent.presentation?.group)).toEqual(["Extensions", "Prompts", "Skills"]);
		expect(dynamic.every((intent) => intent.enabled && intent.fence === "branch")).toBe(true);
		expect(dynamic[0]?.completions).toEqual(["arguments"]);
		const serialized = JSON.stringify(dynamic);
		expect(serialized).not.toContain(resources);
		expect(serialized).not.toContain("Fix $ARGUMENTS");
		expect(serialized).not.toContain("Read the stack first");
		expect(serialized).toContain("[redacted path]");
		const [deploy, template, skill] = dynamic.map((intent) => intent.name);

		await expect(
			client.query("intent_completions", { intent: deploy!, field: "arguments", prefix: "pr" }),
		).resolves.toEqual({
			completions: [{ value: "pr-prod", label: "Production", description: "Production target" }],
		});
		await expect(client.query("intent_completions", { intent: template!, field: "arguments" })).resolves.toEqual({
			completions: [],
		});

		await client.intent(deploy!, { arguments: "prod" });
		await vi.waitFor(() => expect(deployed).toEqual(["prod"]));
		await client.intent(template!, { arguments: "copy failing output" });
		await client.waitForIdle(10_000);
		await client.intent(skill!, { arguments: "inspect crash" });
		await client.waitForIdle(10_000);

		const texts = userTexts(client);
		expect(texts[0]).toBe("Fix copy failing output");
		expect(texts[1]).toContain('<skill name="debugger"');
		expect(texts[1]).toContain("inspect crash");
		expect(texts).toHaveLength(2);
	});

	it("queues a prompt template sent while the agent streams only when told how", async () => {
		const resources = tempDir("volt-intent-queue-");
		writeFileSync(join(resources, "fix-tests.md"), "---\ndescription: Fix failing tests\n---\nFix $ARGUMENTS\n");
		const { harness, conversation } = await setup({
			extension: (volt) => {
				volt.on("resources_discover", () => ({ promptPaths: [join(resources, "fix-tests.md")] }));
			},
		});
		const turn = gatedResponse("first answer");
		harness.faux.setResponses([turn.response, fauxAssistantMessage("second answer")]);
		cleanups.push(() => turn.release());
		const client = await connect(harness, conversation);
		const { intents } = await client.query("intents");
		const template = intents.find((intent) => intent.source === "prompt")?.name;
		if (!template) throw new Error("Expected the prompt template's intent");

		await client.prompt("first");
		await vi.waitFor(() => expect(conversation.session.isStreaming).toBe(true));
		await expect(client.intent(template, { arguments: "after current turn" })).rejects.toMatchObject({
			reason: {
				code: "busy",
				message: `${template} needs streamingBehavior ('steer' or 'followUp') while the agent is streaming`,
			},
		});
		await client.intent(template, { arguments: "after current turn", streamingBehavior: "followUp" });
		turn.release();
		await client.waitForIdle(10_000);

		expect(userTexts(client)).toEqual(["first", "Fix after current turn"]);
	});

	it("rejects a dynamic intent from a catalog that changed, and runs the new one", async () => {
		let commandName = "deploy";
		const ran: string[] = [];
		const { harness, conversation } = await setup({
			extension: (volt) => {
				const name = commandName;
				volt.registerCommand(name, {
					handler: async (args) => {
						ran.push(`${name} ${args}`);
					},
				});
			},
		});
		const frames: HostFrame[] = [];
		const client = await connect(harness, conversation, { onFrame: (frame) => frames.push(frame) });
		const stale = (await client.query("intents")).intents.find((intent) => intent.source === "extension")?.name;
		if (!stale) throw new Error("Expected the extension command's intent");

		commandName = "release";
		await conversation.session.reload();
		await vi.waitFor(() => expect(frames).toContainEqual({ type: "changed", catalog: "intents" }));

		await expect(client.intent(stale, { arguments: "prod" })).rejects.toMatchObject({
			reason: { code: "unknown_intent" },
		});
		await expect(
			client.query("intent_completions", { intent: stale, field: "arguments", prefix: "prod" }),
		).rejects.toThrow(`Unknown intent: ${stale}`);
		const fresh = (await client.query("intents")).intents.find((intent) => intent.source === "extension");
		expect(fresh?.slash?.name).toBe("release");
		expect(fresh?.name).not.toBe(stale);
		await client.intent(fresh!.name, { arguments: "prod" });
		await vi.waitFor(() => expect(ran).toEqual(["release prod"]));
	});

	it("completes the review base from the workspace's branches", async () => {
		const harness = await createHostHarness();
		cleanups.push(() => harness.cleanup());
		const repo = tempDir("volt-intent-branches-");
		git(repo, "init", "--initial-branch=main");
		git(repo, "config", "user.email", "test@example.com");
		git(repo, "config", "user.name", "Test");
		git(repo, "config", "commit.gpgsign", "false");
		writeFileSync(join(repo, "file.txt"), "one\n");
		git(repo, "add", "file.txt");
		git(repo, "commit", "-m", "initial");
		git(repo, "branch", "feature/login");
		git(repo, "branch", "zeta");
		const openIn = async (cwd: string): Promise<HostedConversation> => {
			const opened = await harness.host.open({
				kind: "adopt",
				sessionManager: await SessionManager.create(cwd, join(harness.tempDir, "sessions")),
			});
			if (opened.cancelled) throw new Error("A startup open cannot be cancelled");
			return opened.conversation;
		};
		const client = await connect(harness, await openIn(repo));

		const complete = (field: string, prefix: string) =>
			client.query("intent_completions", { intent: "review", field, prefix });
		await expect(complete("base", "")).resolves.toEqual({
			completions: [{ value: "main" }, { value: "feature/login" }, { value: "zeta" }],
		});
		await expect(complete("base", "FEAT")).resolves.toEqual({ completions: [{ value: "feature/login" }] });
		// Fields the intent does not complete have no completions.
		await expect(complete("focus", "")).resolves.toEqual({ completions: [] });
		await expect(
			client.query("intent_completions", { intent: "set_session_name", field: "name", prefix: "" }),
		).resolves.toEqual({ completions: [] });

		const visitor = await connect(harness, await openIn(tempDir("volt-intent-no-repo-")));
		await expect(
			visitor.query("intent_completions", { intent: "review", field: "base", prefix: "" }),
		).resolves.toEqual({ completions: [] });
	});

	it("completes the review ref from recent commits and its number and url from the branch's pull request", async () => {
		const harness = await createHostHarness();
		cleanups.push(() => harness.cleanup());
		const repo = tempDir("volt-intent-commits-");
		git(repo, "init", "--initial-branch=main");
		git(repo, "config", "user.email", "test@example.com");
		git(repo, "config", "user.name", "Test");
		git(repo, "config", "commit.gpgsign", "false");
		writeFileSync(join(repo, "file.txt"), "one\n");
		git(repo, "add", "file.txt");
		git(repo, "commit", "-m", "first change");
		writeFileSync(join(repo, "file.txt"), "two\n");
		git(repo, "commit", "-am", "second change");
		const [second, first] = execFileSync("git", ["log", "--pretty=format:%h"], { cwd: repo, encoding: "utf8" }).split(
			"\n",
		);
		const probe = vi.spyOn(githubCliCodeHostProvider, "probeCurrentPullRequest").mockResolvedValue({
			number: 243,
			title: "Compact\nwidth UI",
			url: "https://example.test/pull/243",
		});
		const opened = await harness.host.open({
			kind: "adopt",
			sessionManager: await SessionManager.create(repo, join(harness.tempDir, "sessions")),
		});
		if (opened.cancelled) throw new Error("A startup open cannot be cancelled");
		const client = await connect(harness, opened.conversation);
		const complete = (intent: string, field: string, prefix: string) =>
			client.query("intent_completions", { intent, field, prefix });

		await expect(complete("review", "ref", "")).resolves.toEqual({
			completions: [
				{ value: second, label: "second change", description: expect.any(String) },
				{ value: first, label: "first change", description: expect.any(String) },
			],
		});
		await expect(complete("review", "ref", first!.toUpperCase())).resolves.toMatchObject({
			completions: [{ value: first }],
		});
		await expect(complete("review", "number", "")).resolves.toEqual({
			completions: [{ value: "243", label: "#243 Compact width UI", description: "Current branch" }],
		});
		await expect(complete("review", "number", "24")).resolves.toMatchObject({ completions: [{ value: "243" }] });
		await expect(complete("review", "number", "9")).resolves.toEqual({ completions: [] });
		// The url pins the pull request a local client picked.
		await expect(complete("review", "url", "")).resolves.toEqual({
			completions: [
				{ value: "https://example.test/pull/243", label: "#243 — Compact width UI", description: "Current branch" },
			],
		});
		// Completing as the user types probes the code host once, not per keystroke.
		expect(probe).toHaveBeenCalledTimes(1);
		const { intents } = await client.query("intents");
		expect(intents.find((intent) => intent.name === "review")?.completions).toEqual(["base", "number", "url", "ref"]);
	});

	it("asks the attaching client a dialog an extension opens from session_start before the client is ready", async () => {
		const answers: boolean[] = [];
		const { harness, conversation } = await setup({
			extension: (volt) => {
				volt.on("session_start", async (_event, ctx) => {
					answers.push(await ctx.ui.confirm("Startup", "Continue?"));
				});
			},
		});
		const asked: string[] = [];
		const client = await connect(harness, conversation, {
			hostRequests: ["confirm"],
			onFrame: (frame, pending) => {
				const requestId = hostRequestIdOf(frame);
				if (requestId === undefined || asked.includes(requestId)) return;
				asked.push(requestId);
				pending.answer(requestId, { confirmed: true });
			},
		});

		expect(asked).toHaveLength(1);
		expect(answers).toEqual([true]);
		expect(client.conversation).toBe(conversation.id);
		expect(conversation.liveState.pendingRequests()).toEqual([]);
	});

	it("ends a connection whose client leaves while a startup dialog waits for it", async () => {
		const answers: boolean[] = [];
		const { harness, conversation } = await setup({
			extension: (volt) => {
				volt.on("session_start", async (_event, ctx) => {
					answers.push(await ctx.ui.confirm("Startup", "Continue?"));
				});
			},
		});
		const pair = createLoopbackRpcTransportPair();
		const connection = serveConnection(pair.server, localProfile, { host: harness.host, conversation });
		const asked = Promise.withResolvers<void>();
		const client = new ProtocolClient({
			hostRequests: ["confirm"],
			onFrame: (frame) => {
				if (hostRequestIdOf(frame) !== undefined) asked.resolve();
			},
		});
		void client.connect(pair.client).catch(() => undefined);
		await asked.promise;

		await client.stop();
		await connection.closed;
		await vi.waitFor(() => expect(answers).toEqual([false]));
		// The client anchored the conversation.
		expect(conversation.closed).toBe(true);
	});

	it("fails readiness with the bind error and closes the conversation the client anchored", async () => {
		const { harness, conversation } = await setup();
		const bindError = new Error("bind failed");
		vi.spyOn(conversation.session, "attachExtensionClient").mockImplementation(() => ({
			ready: Promise.reject(bindError),
			detach: () => {},
		}));
		const pair = createLoopbackRpcTransportPair();
		const connection = serveConnection(pair.server, localProfile, { host: harness.host, conversation });
		const client = new ProtocolClient();
		const connecting = client.connect(pair.client);

		await expect(connection.ready).rejects.toBe(bindError);
		await expect(connection.closed).rejects.toBe(bindError);
		await expect(connecting).rejects.toThrow();
		expect(conversation.closed).toBe(true);
		await client.stop();
	});

	it("closes the conversation an anchoring client stops, and leaves it open for one that does not anchor", async () => {
		const { harness, conversation } = await setup({ whenUnattached: "keep" });
		const anchored = await createLoopbackClient(harness.host, conversation);
		await anchored.stop();
		expect(conversation.closed).toBe(true);

		const shared = await harness.openStartup();
		const visitor = await createLoopbackClient(harness.host, shared, { anchor: false });
		await visitor.stop();
		expect(shared.closed).toBe(false);
	});

	it("shows a phone only the remote-safe dynamic intents, without host paths, and the model catalog intact", async () => {
		const deployed: string[] = [];
		const { harness, conversation } = await setup({
			whenUnattached: "keep",
			extension: (volt) => {
				volt.registerCommand("deploy", {
					description: "Deploy the service",
					remoteSafe: true,
					handler: async (args) => {
						deployed.push(args);
					},
				});
				volt.registerCommand("unsafe", {
					description: `Unsafe side effect in ${tmpdir()}`,
					handler: async () => {
						throw new Error("unsafe must not run remotely");
					},
				});
			},
		});
		const local = await connect(harness, conversation, { anchor: false });
		const pair = createIrohStreamPair();
		const connection = serveIrohRemoteConnection({
			host: harness.host,
			conversation,
			stream: pair.host,
			grant: ALL,
			redaction: { workspacePath: conversation.cwd },
			redirect: {},
		});
		const phone = connectRemotePhone(pair.phone);
		cleanups.push(async () => {
			await phone.close();
			await connection.close().catch(() => undefined);
		});
		await phone.hello();
		await phone.subscribe(conversation.id);

		const listed = await phone.query("intents");
		if (listed.type !== "result") throw new Error(`Expected the intents, got ${JSON.stringify(listed)}`);
		const { intents } = listed.data as { intents: IntentDescriptor[] };
		expect(intents.every((intent) => intent.remote === "safe")).toBe(true);
		expect(intents.filter((intent) => intent.source === "extension").map((intent) => intent.slash?.name)).toEqual([
			"deploy",
		]);
		expect(JSON.stringify(listed)).not.toContain(conversation.cwd);
		const localIntents = (await local.query("intents")).intents;
		expect(localIntents.filter((intent) => intent.source === "extension")).toHaveLength(2);
		const deploy = intents.find((intent) => intent.source === "extension")!.name;

		await expect(phone.intent("prompt", { message: "/unsafe now" })).resolves.toMatchObject({
			type: "rejected",
			reason: { code: "not_allowed", message: "Extension command is not available over remote host: /unsafe" },
		});
		const unsafe = localIntents.find((intent) => intent.slash?.name === "unsafe")!.name;
		await expect(phone.intent(unsafe, {})).resolves.toMatchObject({
			type: "rejected",
			reason: { code: "not_allowed" },
		});
		await expect(phone.intent(deploy, { arguments: "prod" })).resolves.toMatchObject({ type: "accepted" });
		await vi.waitFor(() => expect(deployed).toEqual(["prod"]));

		// The loopback carries values in process; the phone's arrive as JSON.
		const catalog: unknown = JSON.parse(JSON.stringify(await local.query("models")));
		await expect(phone.query("models")).resolves.toMatchObject({ type: "result", data: catalog });
	});
});
