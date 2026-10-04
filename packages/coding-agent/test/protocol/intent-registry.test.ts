import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import type { AgentSessionServices } from "../../src/core/agent-session-services.ts";
import {
	type IntentContext,
	IntentRejectedError,
	type IntentTarget,
	intentRegistry,
	LOCAL_INTENT_PROFILE,
	listDynamicIntents,
} from "../../src/core/protocol/intents/index.ts";
import { QueryRejectedError, queryRegistry } from "../../src/core/protocol/queries/index.ts";
import { createIrohRemoteRpcGrant } from "../../src/core/remote/iroh/access-grant.ts";
import { REVIEW_DISCUSSION_SOURCE_ACTION_MESSAGE } from "../../src/core/review-discussion-policy.ts";
import { getUiActionCompletions } from "../../src/core/rpc/ui-actions.ts";
import { INTENT_SLASH_COMMANDS } from "../../src/core/slash-commands.ts";
import { createHarness, type Harness } from "../suite/harness.ts";
import { adoptTestSession, connectTestClient, type TestClient } from "../utilities/host-client.ts";

const harnesses: Harness[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
	for (const client of clients.splice(0)) await client.dispose();
	for (const harness of harnesses.splice(0)) await harness.cleanupAsync();
});

function services(harness: Harness): AgentSessionServices {
	return {
		cwd: harness.tempDir,
		projectCwd: harness.tempDir,
		lexicalProjectCwd: harness.tempDir,
		agentDir: harness.tempDir,
		authStorage: harness.authStorage,
		settingsManager: harness.settingsManager,
		modelRegistry: harness.session.modelRegistry,
		resourceLoader: harness.session.resourceLoader,
		gitContextProvider: harness.session.gitContextProvider,
		releaseGitContextProvider: () => {},
		diagnostics: [],
	};
}

/** A hosted harness session and an in-place client on it. */
async function hostedClient(): Promise<TestClient> {
	const options = { settings: { lsp: { enabled: false }, compaction: { enabled: false } } };
	const harness = await createHarness(options);
	harnesses.push(harness);
	const hosted = adoptTestSession(harness.session, services(harness), async ({ sessionManager }) => {
		const next = await createHarness({ ...options, sessionManager });
		harnesses.push(next);
		return {
			session: next.session,
			services: services(next),
			diagnostics: [],
			extensionsResult: next.session.resourceLoader.getExtensions(),
		};
	});
	const client = await connectTestClient(hosted.host, hosted.conversation);
	clients.push(client);
	return client;
}

function contextOf(client: TestClient, extra: Partial<IntentContext> = {}): IntentContext {
	return {
		target: { session: client.session, conversation: client.conversation, host: client.host, client: client.client },
		services: {},
		profile: LOCAL_INTENT_PROFILE,
		...extra,
	};
}

/** A target whose session reads only the state admission looks at. */
function fakeTarget(state: Partial<AgentSession> = {}): IntentTarget {
	return {
		session: {
			isStreaming: false,
			isCompacting: false,
			conversationGenerationRevision: 0,
			extensionRunner: { getRegisteredCommands: () => [] },
			promptTemplates: [],
			resourceLoader: { getSkills: () => ({ skills: [], diagnostics: [] }) },
			...state,
		},
	} as unknown as IntentTarget;
}

function rejection(run: () => unknown): IntentRejectedError {
	try {
		run();
	} catch (error) {
		if (error instanceof IntentRejectedError) return error;
		throw error;
	}
	throw new Error("Expected the intent to be rejected");
}

const remote = (...capabilities: Parameters<typeof createIrohRemoteRpcGrant>[0]): IntentContext["profile"] => ({
	name: "remote",
	grant: createIrohRemoteRpcGrant(capabilities),
});

describe("intent admission", () => {
	it("rejects names that are neither built in nor in the conversation's catalog", () => {
		expect(
			rejection(() => intentRegistry.prepareFrame({ services: {}, profile: LOCAL_INTENT_PROFILE }, "nope", {})),
		).toMatchObject({ code: "unknown_intent" });
		expect(
			rejection(() =>
				intentRegistry.prepareFrame(
					{ target: fakeTarget(), services: {}, profile: LOCAL_INTENT_PROFILE },
					"extension.command.ec_unknown_1",
					{},
				),
			),
		).toMatchObject({ code: "unknown_intent" });
	});

	it("admits a remote profile only to remote-safe intents within its grant, naming the first missing capability", () => {
		const target = fakeTarget();
		expect(
			rejection(() =>
				intentRegistry.prepareFrame({ target, services: {}, profile: remote() }, "bash", { command: "ls" }),
			),
		).toMatchObject({ code: "not_allowed", message: "Intent not available over remote host: bash" });
		const missing = rejection(() =>
			intentRegistry.prepareFrame({ target, services: {}, profile: remote("conversation.observe.v1") }, "abort", {}),
		);
		expect(missing).toMatchObject({ code: "not_allowed", requiredCapability: "conversation.control.v1" });
		expect(
			rejection(() =>
				intentRegistry.prepareFrame(
					{ target, services: {}, profile: remote("model.select.v1") },
					"set_default_model",
					{
						provider: "p",
						modelId: "m",
					},
				),
			),
		).toMatchObject({ code: "not_allowed", requiredCapability: "host.manage.v1" });
		expect(
			intentRegistry.prepareFrame({ target, services: {}, profile: remote("conversation.control.v1") }, "abort", {}),
		).toHaveProperty("run");
	});

	it("rejects input that fails the intent's schema", () => {
		const error = rejection(() =>
			intentRegistry.prepareFrame(
				{ target: fakeTarget(), services: {}, profile: LOCAL_INTENT_PROFILE },
				"set_agent_mode",
				{
					mode: "review",
				},
			),
		);
		expect(error.code).toBe("invalid_input");
		expect(error.message).toContain('"mode"');
		expect(
			rejection(() =>
				intentRegistry.prepareFrame(
					{ target: fakeTarget(), services: {}, profile: LOCAL_INTENT_PROFILE },
					"abort",
					{
						extra: true,
					},
				),
			),
		).toMatchObject({ code: "invalid_input" });
	});

	it("needs a conversation for conversation-scope intents and admits host intents without one", () => {
		expect(
			rejection(() => intentRegistry.prepareFrame({ services: {}, profile: LOCAL_INTENT_PROFILE }, "abort", {})),
		).toMatchObject({ code: "unavailable" });
		expect(
			rejection(() =>
				intentRegistry.prepareFrame({ services: {}, profile: LOCAL_INTENT_PROFILE }, "set_keep_awake", {
					enabled: true,
				}),
			),
		).toMatchObject({ code: "unavailable", message: "unsupported_remote_command" });
		const keepAwake = {
			status: () => ({ enabled: true, state: "active" as const }),
			setEnabled: () => keepAwake.status(),
		};
		expect(
			intentRegistry.prepareFrame({ services: { keepAwake }, profile: LOCAL_INTENT_PROFILE }, "set_keep_awake", {
				enabled: true,
			}),
		).toHaveProperty("run");
	});

	it("rejects a branch-fenced intent stale once the branch switched after the client's position", () => {
		const ctx: IntentContext = {
			target: fakeTarget({ conversationGenerationRevision: 7 } as Partial<AgentSession>),
			services: {},
			profile: LOCAL_INTENT_PROFILE,
		};
		expect(
			rejection(() => intentRegistry.prepareFrame(ctx, "set_agent_mode", { mode: "plan" }, { expectedOrdinal: 6 })),
		).toMatchObject({ code: "stale", ordinal: 7 });
		expect(
			intentRegistry.prepareFrame(ctx, "set_agent_mode", { mode: "plan" }, { expectedOrdinal: 7 }),
		).toHaveProperty("run");
		// Unfenced intents ignore the position.
		expect(
			intentRegistry.prepareFrame(ctx, "review_cancel_workflow", { workflowId: "w" }, { expectedOrdinal: 1 }),
		).toHaveProperty("run");
	});

	it("leaves source-owned lifecycle operations to a review discussion's source", () => {
		const ctx: IntentContext = {
			target: fakeTarget({ isReviewDiscussion: true } as Partial<AgentSession>),
			services: {},
			profile: LOCAL_INTENT_PROFILE,
		};
		expect(rejection(() => intentRegistry.prepareFrame(ctx, "new_session", {}))).toMatchObject({
			code: "unavailable",
			message: REVIEW_DISCUSSION_SOURCE_ACTION_MESSAGE,
		});
		const plan = { planId: "p", expectedRevision: 1 };
		expect(
			rejection(() => intentRegistry.prepareFrame(ctx, "plan_execute", { ...plan, strategy: "new_session" })),
		).toMatchObject({ code: "unavailable" });
		expect(intentRegistry.prepareFrame(ctx, "plan_execute", { ...plan, strategy: "retain_context" })).toHaveProperty(
			"run",
		);
		expect(intentRegistry.prepareFrame(ctx, "set_agent_mode", { mode: "plan" })).toHaveProperty("run");
	});

	it("applies the intent's availability to the invocation's input", () => {
		const ctx: IntentContext = {
			target: fakeTarget({ isStreaming: true } as Partial<AgentSession>),
			services: {},
			profile: LOCAL_INTENT_PROFILE,
		};
		expect(rejection(() => intentRegistry.prepareFrame(ctx, "set_fast_mode", { enabled: true }))).toMatchObject({
			code: "unavailable",
			message: "Fast mode is not available while the agent is streaming",
		});
	});
});

describe("intent completions", () => {
	it("complete remote-safe intents on an observe-only grant, as the completion query requires", async () => {
		const ctx: IntentContext = {
			target: fakeTarget({
				sessionManager: { getCwd: () => "/nonexistent-volt-repo" },
			} as unknown as Partial<AgentSession>),
			services: {},
			profile: remote("conversation.observe.v1"),
		};
		await expect(intentRegistry.complete(ctx, "review_branch", "base", "")).resolves.toEqual([]);
		await expect(intentRegistry.complete(ctx, "review_branch", "focus", "")).resolves.toEqual([]);
		await expect(intentRegistry.complete(ctx, "bash", "command", "")).rejects.toMatchObject({
			code: "not_allowed",
		});
		// The UI action wire completes through the same intent.
		await expect(
			getUiActionCompletions(ctx, { action: "review.branch", argument: "base", prefix: "" }),
		).resolves.toEqual([]);
	});
});

describe("dynamic intents", () => {
	it("keep a remote prompt template from reaching an extension command that is not remote-safe", () => {
		const deploy = { invocationName: "deploy", name: "deploy", remoteSafe: false, sourceInfo: { scope: "project" } };
		const target = fakeTarget({
			isStreaming: false,
			extensionRunner: {
				getRegisteredCommands: () => [deploy],
				getCommand: (name: string) => (name === "deploy" ? deploy : undefined),
			},
			promptTemplates: [{ name: "deploy", content: "Ship it", sourceInfo: { scope: "user" } }],
		} as unknown as Partial<AgentSession>);
		const template = listDynamicIntents(target.session).find((intent) => intent.source === "prompt");
		expect(template?.remote).toBe("safe");
		const remoteCtx: IntentContext = { target, services: {}, profile: remote("conversation.control.v1") };
		expect(rejection(() => intentRegistry.prepareFrame(remoteCtx, template!.name, {}))).toMatchObject({
			code: "not_allowed",
			message: "Extension command is not available over remote host: /deploy",
		});
		expect(
			intentRegistry.prepareFrame({ ...remoteCtx, profile: LOCAL_INTENT_PROFILE }, template!.name, {}),
		).toHaveProperty("run");
	});
});

describe("intent runs", () => {
	it("answers the ordinals committed while it ran, and the conversation a structural intent moved to", async () => {
		const client = await hostedClient();
		const before = client.session.sessionManager.getOrdinal();
		const renamed = await intentRegistry.invoke(contextOf(client), "set_session_name", { name: "  Named  " });
		expect(renamed.outcome).toBe("Named");
		expect(renamed.ordinals.length).toBeGreaterThan(0);
		expect(renamed.ordinals[0]).toBe(before + 1);
		expect(client.session.sessionManager.getSessionName()).toBe("Named");

		const source = client.session.sessionId;
		const moved = await intentRegistry.invoke(contextOf(client), "new_session", {});
		expect(moved.outcome.cancelled).toBe(false);
		expect(moved.conversation).toBe(client.session.sessionId);
		expect(moved.conversation).not.toBe(source);
		expect(moved.ordinals).toEqual([]);
	});

	it("answers an intent's output as its result", async () => {
		const client = await hostedClient();
		const exported = await intentRegistry.invoke(contextOf(client), "set_agent_mode", { mode: "plan" });
		expect(exported.outcome.mode).toBe("plan");
		expect(exported.result).toBeUndefined();
		const plan = await queryRegistry.run(contextOf(client), "settings", {});
		expect(plan).toEqual({
			steeringMode: client.session.steeringMode,
			followUpMode: client.session.followUpMode,
			autoCompaction: false,
			autoRetry: client.session.autoRetryEnabled,
		});
	});

	it("takes an input intent's clientMessageId from its intent id", async () => {
		const client = await hostedClient();
		await expect(intentRegistry.invoke(contextOf(client), "follow_up", { message: "later" })).rejects.toMatchObject({
			code: "invalid_input",
		});
	});
});

describe("intent descriptors", () => {
	it("describes built-in intents with their schema, remote safety, requirements, and availability", async () => {
		const client = await hostedClient();
		const view = { state: { isStreaming: false, isCompacting: false }, services: {}, profile: LOCAL_INTENT_PROFILE };
		const descriptors = intentRegistry.descriptors(view, contextOf(client).target);
		const fast = descriptors.find((descriptor) => descriptor.name === "set_fast_mode");
		expect(fast).toMatchObject({
			label: "Fast mode",
			category: "model",
			scope: "conversation",
			fence: "branch",
			remote: "safe",
			requires: ["conversation.control.v1"],
			whileBusy: "reject",
			slash: { name: "fast", example: "/fast [on|off]" },
			source: "builtin",
			input: { type: "object" },
			state: { type: "boolean", value: false },
		});
		expect(descriptors.find((descriptor) => descriptor.name === "bash")?.remote).toBe("unsafe");
		const remoteNames = intentRegistry
			.descriptors({ ...view, profile: remote("conversation.observe.v1") })
			.map((descriptor) => descriptor.name);
		expect(remoteNames).not.toContain("bash");
		expect(remoteNames).toContain("prompt");
		expect(remoteNames.every((name) => intentRegistry.get(name as "prompt").remote === "safe")).toBe(true);
	});

	it("resolves the slash aliases that invoke one intent, and the slash commands the TUI lists for them", () => {
		expect(intentRegistry.resolveSlash("clear")).toBe("new_session");
		expect(intentRegistry.resolveSlash("/name")).toBe("set_session_name");
		expect(intentRegistry.resolveSlash("fast")).toBe("set_fast_mode");
		expect(intentRegistry.resolveSlash("compact")).toBe("compact");
		expect(intentRegistry.resolveSlash("review")).toBeUndefined();
		expect([...INTENT_SLASH_COMMANDS].sort((a, b) => a.name.localeCompare(b.name))).toEqual(
			intentRegistry.slashCommands().sort((a, b) => a.name.localeCompare(b.name)),
		);
	});

	it("requires the selection and host management to persist a default", () => {
		expect(intentRegistry.get("set_default_model").requires).toEqual(["model.select.v1", "host.manage.v1"]);
		expect(intentRegistry.get("set_default_thinking_level").requires).toEqual(["model.select.v1", "host.manage.v1"]);
		expect(intentRegistry.get("set_model").requires).toEqual(["model.select.v1"]);
		expect(intentRegistry.get("mcp.auth_start_device").remote).toBe("safe");
		expect(intentRegistry.get("mcp.auth_start_browser").remote).toBe("unsafe");
	});
});

describe("query admission", () => {
	it("rejects unknown queries, profiles that may not run them, and invalid parameters", async () => {
		const ctx = { services: {}, profile: LOCAL_INTENT_PROFILE };
		await expect(queryRegistry.runFrame(ctx, "history", {})).rejects.toMatchObject({ code: "unknown_query" });
		await expect(
			queryRegistry.runFrame({ ...ctx, profile: remote() }, "subagent_definitions", {}),
		).rejects.toMatchObject({ code: "not_allowed" });
		await expect(queryRegistry.runFrame({ ...ctx, profile: remote() }, "models", {})).rejects.toMatchObject({
			code: "not_allowed",
			requiredCapability: "model.select.v1",
		});
		await expect(queryRegistry.runFrame(ctx, "mcp.server", {})).rejects.toBeInstanceOf(QueryRejectedError);
		await expect(queryRegistry.runFrame(ctx, "job_output", { jobId: "j" })).rejects.toMatchObject({
			code: "unavailable",
		});
		await expect(queryRegistry.runFrame(ctx, "mcp.capabilities", {})).resolves.toMatchObject({ protocolVersion: 1 });
	});

	it("lists a conversation's intents for its client's profile", async () => {
		const client = await hostedClient();
		const local = await queryRegistry.run(contextOf(client), "intents", {});
		const remoteIntents = await queryRegistry.run(
			contextOf(client, { profile: remote("conversation.observe.v1") }),
			"intents",
			{},
		);
		expect(local.intents.length).toBeGreaterThan(remoteIntents.intents.length);
		expect(remoteIntents.intents.every((descriptor) => descriptor.remote === "safe")).toBe(true);
	});
});
