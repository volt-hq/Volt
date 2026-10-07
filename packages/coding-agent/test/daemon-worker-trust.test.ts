/**
 * The worker decides a TUI-opened conversation's project trust (P7-8b), as
 * the CLI's in-process host did: the user/global extensions' `project_trust`
 * hooks first, then the saved decision, then `defaultProjectTrust`, then the
 * trust prompt, asked of the TUI whose open it is through the daemon.
 * `--approve`/`--no-approve` override it for the startup project, in workers
 * of their own. A decision applies to its project only, and to that TUI's
 * later conversations in the worker, never another TUI's; a prompt nobody
 * answered decides nothing. Only the asked TUI connection answers.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HostPromptRequest, HostResponse } from "@hansjm10/volt-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectThrough } from "../src/client/conversation-connector.ts";
import { openDaemonConversation } from "../src/client/daemon-conversation.ts";
import { createLoopbackClient, ProtocolClient } from "../src/client/protocol-client.ts";
import type { ProjectTrustContext } from "../src/core/extensions/index.ts";
import type { HostClient } from "../src/core/host/targets.ts";
import { projectTrustPath } from "../src/core/project-trust.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";
import type { ControlEvent, WorkerAgentConfig } from "../src/daemon/control-protocol.ts";
import { probeDaemon } from "../src/daemon/spawn.ts";
import { createIrohRemoteAgentRuntime } from "../src/daemon/worker/conversation-factory.ts";
import { getWorktreesRoot } from "../src/daemon/worktree-manager.ts";
import { DaemonConnector, type DaemonConnectorDaemon } from "../src/modes/interactive/daemon-connector.ts";
import { type ProjectTrustHookAnswer, projectTrustHook } from "./fixtures/project-trust-extension.ts";
import { createDaemonHarness, type DaemonHarness } from "./suite/daemon-harness.ts";

const PROJECT_TRUST_EXTENSION_PATH = realpathSync.native(
	fileURLToPath(new URL("./fixtures/project-trust-extension.ts", import.meta.url)),
);
const TRUST_PROMPT = /^Trust project folder\?/;

const cleanups: Array<() => Promise<unknown> | unknown> = [];

beforeEach(() => {
	const hook = projectTrustHook();
	hook.answers.clear();
	hook.calls.splice(0);
});

afterEach(async () => {
	vi.unstubAllEnvs();
	for (const cleanup of cleanups.splice(0).reverse()) await Promise.resolve(cleanup()).catch(() => undefined);
});

async function startHarness(): Promise<DaemonHarness> {
	const harness = await createDaemonHarness({ workerExtensions: [PROJECT_TRUST_EXTENSION_PATH] });
	cleanups.push(() => harness.dispose());
	vi.stubEnv("VOLT_CODING_AGENT_DIR", harness.agentDir);
	return harness;
}

/** Set `defaultProjectTrust` in the harness's global settings. */
function setDefaultProjectTrust(harness: DaemonHarness, value: "ask" | "always" | "never"): void {
	const path = join(harness.agentDir, "settings.json");
	const settings = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	writeFileSync(path, `${JSON.stringify({ ...settings, defaultProjectTrust: value })}\n`);
}

/** A project in the harness's workspace holding what needs trust (its `.volt/settings.json`), and its trust path. */
function project(harness: DaemonHarness, name: string): { readonly cwd: string; readonly trustPath: string } {
	const cwd = join(harness.workspacePath, name);
	mkdirSync(join(cwd, ".volt"), { recursive: true });
	writeFileSync(join(cwd, ".volt", "settings.json"), "{}\n");
	const trustPath = projectTrustPath(harness.agentDir, cwd);
	if (trustPath === undefined) throw new Error("The project has no trust path");
	return { cwd, trustPath };
}

function setHook(trustPath: string, answer: ProjectTrustHookAnswer): void {
	projectTrustHook().answers.set(trustPath, answer);
}

function hookCalls(trustPath: string): number {
	return projectTrustHook().calls.filter((call) => call.cwd === trustPath).length;
}

/** The harness's daemon, reached as the connector reaches one: running already. */
function harnessDaemon(agentDir: string): DaemonConnectorDaemon {
	return {
		ensure: async () => ({ ...(await probeDaemon(agentDir)), spawned: false }),
		probe: (dir) => probeDaemon(dir),
		waitForExit: async () => "exited",
		isServiceProcess: async () => false,
	};
}

/** A TUI in `cwd` started with `config` (its `--approve`/`--no-approve` as `trust`), and the questions it was asked. */
async function startTui(
	harness: DaemonHarness,
	cwd: string,
	answer: (request: HostPromptRequest) => HostResponse | undefined,
	config: WorkerAgentConfig = {},
): Promise<{ client: ProtocolClient; asked: HostPromptRequest[] }> {
	const asked: HostPromptRequest[] = [];
	const tui = new DaemonConnector({
		agentDir: harness.agentDir,
		startup: { target: { kind: "new" }, cwd },
		spawn: { env: {}, config, cwd, persist: true, session: {} },
		daemon: harnessDaemon(harness.agentDir),
	});
	cleanups.push(() => tui.dispose());
	const client = await connectThrough(tui, {
		askHostRequest: async (request) => {
			asked.push(request);
			return answer(request);
		},
	});
	cleanups.push(() => client.stop());
	return { client, asked };
}

async function trusted(client: ProtocolClient): Promise<boolean> {
	return (await client.query("conversation_info")).projectTrusted;
}

/** The answer picking `label` in the trust prompt. */
function pick(label: string): (request: HostPromptRequest) => HostResponse | undefined {
	return (request) => (request.kind === "select" && TRUST_PROMPT.test(request.title) ? { value: label } : undefined);
}

const unanswered = (): undefined => undefined;

/** Resolves once `client` shows a new conversation of its own, after `new_session`. */
async function newSession(client: ProtocolClient): Promise<string> {
	const { conversation } = await client.intent("new_session");
	if (conversation === undefined) throw new Error("The intent moved the client nowhere");
	await vi.waitFor(
		() => {
			expect(client.moving).toBeUndefined();
			expect(client.conversation).toBe(conversation);
		},
		{ timeout: 15_000 },
	);
	await client.caughtUp();
	return conversation;
}

describe("project trust a worker decides for a TUI's conversation", () => {
	it("follows a hook's yes or no first, over the saved decision, and saves only a remembered one", async () => {
		const harness = await startHarness();
		const store = new ProjectTrustStore(harness.agentDir);
		const yes = project(harness, "yes");
		setHook(yes.trustPath, "yes");
		const no = project(harness, "no");
		setHook(no.trustPath, "no");
		store.set(no.trustPath, true);
		const remembered = project(harness, "remembered");
		setHook(remembered.trustPath, "remember");

		const first = await startTui(harness, yes.cwd, unanswered);
		expect(await trusted(first.client)).toBe(true);
		expect(store.get(yes.trustPath)).toBeNull();
		expect(projectTrustHook().calls).toEqual([{ cwd: yes.trustPath, hasUI: true }]);

		const second = await startTui(harness, no.cwd, unanswered);
		expect(await trusted(second.client)).toBe(false);
		// The hook decided: the saved decision stays as it was.
		expect(store.get(no.trustPath)).toBe(true);

		const third = await startTui(harness, remembered.cwd, unanswered);
		expect(await trusted(third.client)).toBe(true);
		expect(store.get(remembered.trustPath)).toBe(true);
		expect([...first.asked, ...second.asked, ...third.asked]).toEqual([]);
	}, 90_000);

	it("falls back from an undecided hook to the saved decision, then defaultProjectTrust", async () => {
		const harness = await startHarness();
		const saved = project(harness, "saved");
		new ProjectTrustStore(harness.agentDir).set(saved.trustPath, true);
		const never = project(harness, "never");

		const first = await startTui(harness, saved.cwd, unanswered);
		expect(await trusted(first.client)).toBe(true);
		expect(hookCalls(saved.trustPath)).toBe(1);

		setDefaultProjectTrust(harness, "never");
		const second = await startTui(harness, never.cwd, unanswered);
		expect(await trusted(second.client)).toBe(false);

		setDefaultProjectTrust(harness, "always");
		const always = project(harness, "always");
		const third = await startTui(harness, always.cwd, unanswered);
		expect(await trusted(third.client)).toBe(true);
		expect([...first.asked, ...second.asked, ...third.asked]).toEqual([]);
	}, 90_000);

	it("asks the TUI the trust prompt, its untrusting answers first, and saves the answer", async () => {
		const harness = await startHarness();
		const asked = project(harness, "asked");
		const { client, asked: questions } = await startTui(harness, asked.cwd, pick("Trust"));
		expect(await trusted(client)).toBe(true);
		expect(questions).toHaveLength(1);
		const [prompt] = questions;
		expect(prompt?.kind === "select" ? prompt.options : []).toEqual([
			"Do not trust (this session only)",
			"Do not trust",
			"Trust",
			`Trust parent folder (${harness.workspacePath})`,
			"Trust (this session only)",
		]);
		expect(new ProjectTrustStore(harness.agentDir).get(asked.trustPath)).toBe(true);
		// The hook ran first, with the TUI to ask.
		expect(projectTrustHook().calls).toEqual([{ cwd: asked.trustPath, hasUI: true }]);
	}, 60_000);

	it("shows a hook's own dialog in the TUI", async () => {
		const harness = await startHarness();
		const confirmed = project(harness, "confirmed");
		setHook(confirmed.trustPath, "confirm");
		const { client, asked } = await startTui(harness, confirmed.cwd, (request) =>
			request.kind === "confirm" ? { confirmed: true } : undefined,
		);
		expect(await trusted(client)).toBe(true);
		expect(asked).toEqual([{ kind: "confirm", title: "Trust this project?", message: confirmed.trustPath }]);
		expect(new ProjectTrustStore(harness.agentDir).get(confirmed.trustPath)).toBeNull();
	}, 60_000);

	it("keeps a session-only answer for that TUI's later conversations of the worker, and asks another TUI again", async () => {
		const harness = await startHarness();
		const shared = project(harness, "shared");
		const first = await startTui(harness, shared.cwd, pick("Trust (this session only)"));
		expect(await trusted(first.client)).toBe(true);
		expect(first.asked).toHaveLength(1);
		expect(new ProjectTrustStore(harness.agentDir).get(shared.trustPath)).toBeNull();

		// The same TUI's next conversation of the project: decided already, as in one process before.
		const next = await newSession(first.client);
		expect(await trusted(first.client)).toBe(true);
		expect(first.asked).toHaveLength(1);
		expect(hookCalls(shared.trustPath)).toBe(1);

		// Another TUI, routed into the same worker: its conversation inherits nothing, and is asked.
		const second = await startTui(harness, shared.cwd, pick("Do not trust (this session only)"));
		expect(await trusted(second.client)).toBe(false);
		expect(second.asked).toHaveLength(1);
		expect(hookCalls(shared.trustPath)).toBe(2);
		const workers = (await harness.status()).workers;
		expect(workers).toHaveLength(1);
		expect(workers[0]?.sessionIds).toEqual(
			expect.arrayContaining([next, first.client.conversation, second.client.conversation]),
		);
	}, 90_000);

	it("leaves a dismissed prompt's project untrusted and unsaved, and asks the next conversation again", async () => {
		const harness = await startHarness();
		const dismissed = project(harness, "dismissed");
		const { client, asked } = await startTui(harness, dismissed.cwd, unanswered);
		expect(await trusted(client)).toBe(false);
		expect(asked).toHaveLength(1);
		expect(new ProjectTrustStore(harness.agentDir).get(dismissed.trustPath)).toBeNull();

		await newSession(client);
		expect(await trusted(client)).toBe(false);
		expect(asked).toHaveLength(2);
	}, 90_000);

	it("closes a question past its timeout, and the TUI drops it for the next one", async () => {
		const harness = await startHarness();
		const brief = project(harness, "brief");
		setHook(brief.trustPath, "confirm-briefly");
		const dropped: AbortSignal[] = [];
		const asked: HostPromptRequest[] = [];
		const tui = new DaemonConnector({
			agentDir: harness.agentDir,
			startup: { target: { kind: "new" }, cwd: brief.cwd },
			spawn: { env: {}, config: {}, cwd: brief.cwd, persist: true, session: {} },
			daemon: harnessDaemon(harness.agentDir),
		});
		cleanups.push(() => tui.dispose());
		const client = await connectThrough(tui, {
			askHostRequest: async (request, signal) => {
				asked.push(request);
				// The hook's confirmation goes unanswered: the worker closes it at its timeout and asks on.
				if (request.kind === "confirm") {
					await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
					dropped.push(signal);
					return undefined;
				}
				return { value: "Trust (this session only)" };
			},
		});
		cleanups.push(() => client.stop());
		expect(await trusted(client)).toBe(true);
		expect(asked.map((request) => request.kind)).toEqual(["confirm", "select"]);
		expect(asked[0]).toMatchObject({ timeoutMs: 300 });
		expect(dropped).toHaveLength(1);
	}, 60_000);

	it("takes --approve and --no-approve over hooks and the saved decision, in workers of their own", async () => {
		const harness = await startHarness();
		const store = new ProjectTrustStore(harness.agentDir);
		const overridden = project(harness, "overridden");
		store.set(overridden.trustPath, true);
		setHook(overridden.trustPath, "yes");

		const refused = await startTui(harness, overridden.cwd, unanswered, { trust: false });
		expect(await trusted(refused.client)).toBe(false);
		const approved = await startTui(harness, overridden.cwd, unanswered, { trust: true });
		expect(await trusted(approved.client)).toBe(true);
		expect(hookCalls(overridden.trustPath)).toBe(0);
		expect([...refused.asked, ...approved.asked]).toEqual([]);

		// A TUI without an override decides for itself, in a worker of its own.
		const deciding = await startTui(harness, overridden.cwd, unanswered);
		expect(await trusted(deciding.client)).toBe(true);
		expect(hookCalls(overridden.trustPath)).toBe(1);
		const workers = (await harness.status()).workers;
		expect(workers).toHaveLength(3);
		expect(new Set(workers.map((worker) => worker.workerId)).size).toBe(3);
	}, 90_000);
});

describe("who answers a worker's question", () => {
	it("takes the answer only from the asked TUI's connection, and opens nothing when that TUI leaves first", async () => {
		const harness = await startHarness();
		const contested = project(harness, "contested");
		const questions: Array<Extract<ControlEvent, { type: "conversation_host_request" }>> = [];
		const opener = await harness.connect("tui", {
			onEvent: (event) => {
				if (event.type === "conversation_host_request") questions.push(event);
			},
		});
		const opening = openDaemonConversation(opener, {
			target: { kind: "new" },
			spawn: { env: {}, config: {}, cwd: contested.cwd, persist: true, session: {} },
			clientKey: "opener",
		});
		void opening.catch(() => undefined);
		await vi.waitFor(() => expect(questions).toHaveLength(1), { timeout: 30_000 });
		const [question] = questions;
		if (question === undefined) throw new Error("No question was asked");
		expect(question.request).toMatchObject({ kind: "select" });

		// Neither another TUI nor a CLI connection answers it.
		const otherQuestions: Array<Extract<ControlEvent, { type: "conversation_host_request" }>> = [];
		const other = await harness.connect("tui", {
			onEvent: (event) => {
				if (event.type === "conversation_host_request") otherQuestions.push(event);
			},
		});
		expect(
			await other.request({
				type: "conversation_host_response",
				requestId: question.requestId,
				response: { value: "Trust" },
			}),
		).toMatchObject({ type: "error", code: "not_found" });
		expect(
			await harness.control.request({
				type: "conversation_host_response",
				requestId: question.requestId,
				response: { value: "Trust" },
			}),
		).toMatchObject({ type: "error", code: "forbidden" });

		// The opener leaves without answering: nothing opens or is saved, and a later open asks again.
		await opener.close();
		await expect(opening).rejects.toThrow();
		await vi.waitFor(async () => expect((await harness.status()).workers).toEqual([]), { timeout: 30_000 });
		expect(new ProjectTrustStore(harness.agentDir).get(contested.trustPath)).toBeNull();
		expect(questions).toHaveLength(1);
		expect(otherQuestions).toEqual([]);
		const sessionId = harness.audit().find((event) => event.type === "worker_spawned")?.details?.sessionId;
		if (typeof sessionId !== "string") throw new Error("No conversation was spawned");
		const reopening = openDaemonConversation(other, {
			target: { kind: "session", sessionId },
			spawn: { env: {}, config: {}, cwd: contested.cwd, persist: true, session: {} },
			clientKey: "other",
		});
		await vi.waitFor(() => expect(otherQuestions).toHaveLength(1), { timeout: 30_000 });
		expect(
			await other.request({
				type: "conversation_host_response",
				requestId: otherQuestions[0]?.requestId ?? "",
				response: { value: "Trust (this session only)" },
			}),
		).toMatchObject({ type: "ok" });
		const reopened = await reopening;
		const viewer = new ProtocolClient({ followMoves: "reconnect" });
		cleanups.push(() => viewer.stop());
		await viewer.connect(reopened.transport);
		expect(await trusted(viewer)).toBe(true);
	}, 90_000);
});

/** A trust context of one asker that answers `answer` to every select, recording the titles. */
function askingContext(cwd: string, answer: string, titles: string[]): ProjectTrustContext {
	return {
		cwd,
		mode: "rpc",
		hasUI: true,
		ui: {
			select: async (title) => {
				titles.push(title);
				return answer;
			},
			confirm: async () => false,
			input: async () => undefined,
			notify: () => {},
		},
	};
}

/** A TUI-opened conversation's host, built by the worker's factory in `cwd`, its opener answering `answer`. */
async function workerRuntime(agentDir: string, cwd: string, answer: string, titles: string[]) {
	const runtime = await createIrohRemoteAgentRuntime({
		agentDir,
		cwd,
		cli: {
			config: {},
			sessionOptions: {},
			trust: { opener: (trustCwd) => askingContext(trustCwd, answer, titles), session: new Map() },
		},
		// A managed checkout that exists needs nothing of the daemon.
		worktreeDaemon: { restore: async () => async () => {} },
	});
	cleanups.push(() => runtime.host.dispose());
	return runtime;
}

describe("project trust in the worker's conversation factory", () => {
	it("asks for a managed worktree whose own checkout holds what needs trust, though its parent holds nothing", async () => {
		const root = realpathSync.native(mkdtempSync(join(tmpdir(), "volt-worktree-trust-")));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const agentDir = join(root, "agent");
		const parent = join(root, "parent");
		mkdirSync(parent, { recursive: true });
		const checkout = join(getWorktreesRoot(agentDir), "--parent--", "fix");
		mkdirSync(join(checkout, ".volt", "extensions"), { recursive: true });
		writeFileSync(join(checkout, ".git"), `gitdir: ${join(parent, ".git", "worktrees", "fix")}\n`);
		expect(projectTrustPath(agentDir, checkout)).toBe(parent);

		const titles: string[] = [];
		const runtime = await workerRuntime(agentDir, checkout, "Do not trust (this session only)", titles);
		// The question names the parent checkout, the project the decision is for.
		expect(titles).toHaveLength(1);
		expect(titles[0]).toContain(parent);
		expect(runtime.conversation.session.settingsManager.isProjectTrusted()).toBe(false);
	}, 30_000);

	it("keeps what a client answered as its move opened a conversation to that conversation", async () => {
		const root = realpathSync.native(mkdtempSync(join(tmpdir(), "volt-group-trust-")));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const agentDir = join(root, "agent");
		const home = join(root, "home");
		mkdirSync(home, { recursive: true });
		const elsewhere = join(root, "elsewhere");
		mkdirSync(join(elsewhere, ".volt"), { recursive: true });
		writeFileSync(join(elsewhere, ".volt", "settings.json"), "{}\n");
		const runtime = await workerRuntime(agentDir, home, "unused", []);
		const { host, conversation } = runtime;

		// A local client starts a conversation elsewhere, and trusts that project for its session.
		// Not the conversation's anchor: it stays open for the phone once the client moved on.
		const opener = await createLoopbackClient(host, conversation, { anchor: false, hostRequests: ["select"] });
		cleanups.push(() => opener.stop());
		const moved = opener.intent("new_session", { cwd: elsewhere });
		let prompt: { requestId: string } | undefined;
		await vi.waitFor(() => {
			prompt = [...opener.live.values.values()].flatMap((value) =>
				value.kind === "host_request" && value.request.kind === "select" ? [{ requestId: value.requestId }] : [],
			)[0];
			expect(prompt).toBeDefined();
		});
		opener.answer(prompt?.requestId ?? "", { value: "Trust (this session only)" });
		const target = (await moved).conversation;
		expect(
			host
				.list()
				.find((open) => open.id === target)
				?.session.settingsManager.isProjectTrusted(),
		).toBe(true);

		// A paired phone of the group, asking nobody, inherits nothing of that answer.
		const phone: HostClient = { id: "phone", remote: true, move: { kind: "in_place", onMoved: () => {} } };
		await host.attach(phone, conversation);
		const phoneOpened = await host.openFor(phone, { kind: "new", cwd: elsewhere });
		if (phoneOpened.cancelled) throw new Error("The phone's open was cancelled");
		expect(phoneOpened.conversation.session.settingsManager.isProjectTrusted()).toBe(false);
	}, 30_000);
});
