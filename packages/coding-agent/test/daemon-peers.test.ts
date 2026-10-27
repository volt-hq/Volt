import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import type { LiveValue } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDaemonConversation } from "../src/client/daemon-conversation.ts";
import { ProtocolClient } from "../src/client/protocol-client.ts";
import type { ControlEvent } from "../src/daemon/control-protocol.ts";
import { createIrohDaemonService } from "../src/daemon/iroh-service.ts";
import { createPeerDaemonService } from "../src/daemon/peers.ts";
import { createDaemonHarness, type DaemonHarness } from "./suite/daemon-harness.ts";
import { nativeIrohAvailable } from "./utilities/daemon-phone.ts";

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});

async function startHarness(options: Parameters<typeof createDaemonHarness>[0]): Promise<DaemonHarness> {
	const harness = await createDaemonHarness(options);
	cleanups.push(() => harness.dispose());
	return harness;
}

function enablePeerTool(harness: DaemonHarness): void {
	const path = join(harness.agentDir, "settings.json");
	const settings = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	writeFileSync(path, `${JSON.stringify({ ...settings, remote: { peers: true } })}\n`);
}

async function pairingTicket(host: DaemonHarness): Promise<string> {
	const events: ControlEvent[] = [];
	const control = await host.connect("cli", { onEvent: (event) => events.push(event) });
	const started = await control.request({ type: "pair_request", workspaceName: host.workspaceName, access: "coding" });
	expect(started.type).toBe("pair_started");
	let ticket: string | undefined;
	await vi.waitFor(
		() => {
			const progress = events.find((event) => event.type === "pairing_progress" && event.phase === "ticket");
			ticket = progress?.type === "pairing_progress" ? progress.ticket : undefined;
			expect(ticket).toBeDefined();
		},
		{ timeout: 10_000 },
	);
	if (ticket === undefined) throw new Error("no pairing ticket");
	return ticket;
}

async function pairedPeers(): Promise<{ alice: DaemonHarness; bob: DaemonHarness }> {
	const bob = await startHarness({ extensions: [createIrohDaemonService({ relayMode: "disabled" })] });
	const alice = await startHarness({ extensions: [createPeerDaemonService()] });
	enablePeerTool(alice);
	const added = await alice.control.request({ type: "peer_add", name: "bob", ticket: await pairingTicket(bob) });
	expect(added).toMatchObject({ type: "peer_result", peer: { name: "bob", workspace: bob.workspaceName } });
	return { alice, bob };
}

/** A real terminal-opened conversation; selects are answered through the same protocol as the TUI. */
async function openTerminal(harness: DaemonHarness, picker = false): Promise<ProtocolClient> {
	const tui = await harness.connect("tui");
	const { transport } = await openDaemonConversation(tui, {
		target: { kind: "new" },
		spawn: { env: {}, config: {}, cwd: harness.workspacePath, persist: true, session: {} },
		clientKey: "tui-1",
	});
	const client = new ProtocolClient({ followMoves: "reconnect", hostRequests: picker ? ["select"] : [] });
	cleanups.push(async () => {
		await client.intent("abort", {}, { expectedOrdinal: client.state.ordinal }).catch(() => undefined);
		await client.stop();
	});
	await client.connect(transport);
	return client;
}

function askBob(params: Record<string, unknown>) {
	return fauxAssistantMessage(
		[fauxToolCall("peer", { action: "send", peer: "bob", message: "summarize the API change", ...params })],
		{ stopReason: "toolUse" },
	);
}

function lastUserText(context: Context): string {
	const message = context.messages.findLast((candidate) => candidate.role === "user");
	if (message === undefined) return "";
	if (typeof message.content === "string") return message.content;
	return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

function peerResults(client: ProtocolClient): string {
	return JSON.stringify(
		client.state.entries.filter(
			(entry) => entry.type === "message" && entry.view?.role === "tool" && entry.view.toolName === "peer",
		),
	);
}

function pendingSelect(client: ProtocolClient): Extract<LiveValue, { kind: "host_request" }> | undefined {
	for (const value of client.live.values.values()) {
		if (value.kind === "host_request" && value.request.kind === "select") return value;
	}
	return undefined;
}

describe("peer agents (experimental)", () => {
	it("refuses tickets it cannot use and peers it does not know", async () => {
		const harness = await startHarness({ extensions: [createPeerDaemonService()] });
		expect(await harness.control.request({ type: "peer_add", name: "bob", ticket: "not-a-ticket" })).toMatchObject({
			type: "error",
			code: "invalid_ticket",
		});
		expect(await harness.control.request({ type: "peers_list" })).toMatchObject({ type: "peers_result", peers: [] });
		expect(await harness.control.request({ type: "peer_remove", name: "bob" })).toMatchObject({
			type: "error",
			code: "not_found",
		});
	}, 60_000);

	it.runIf(nativeIrohAvailable)(
		"lists and reads a live terminal conversation, then continues it with full tools",
		async () => {
			const { alice, bob } = await pairedPeers();
			expect((await bob.status()).clients).toEqual([
				expect.objectContaining({ label: expect.stringMatching(/^peer:/) }),
			]);
			bob.faux.setResponses([
				fauxAssistantMessage("I am updating the API"),
				fauxAssistantMessage([fauxToolCall("write", { path: "peer-result.txt", content: "cooperation works" })], {
					stopReason: "toolUse",
				}),
				(context) => fauxAssistantMessage(`bob did: ${lastUserText(context)}`),
				fauxAssistantMessage("continued in the same conversation"),
			]);
			const bobClient = await openTerminal(bob);
			await bobClient.promptAndWait("Update the API");
			const session = bobClient.conversation!;
			alice.faux.setResponses([
				fauxAssistantMessage([fauxToolCall("peer", { action: "conversations", peer: "bob" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage([fauxToolCall("peer", { action: "read", peer: "bob", session, limit: 2 })], {
					stopReason: "toolUse",
				}),
				askBob({ session }),
				askBob({ session, message: "continue the API discussion" }),
				fauxAssistantMessage("bob answered"),
			]);
			const client = await openTerminal(alice);
			await client.promptAndWait("ask bob about the API change", { timeoutMs: 60_000 });
			const results = peerResults(client);
			expect(results).toContain(session);
			expect(results).toContain("I am updating the API");
			expect(results).toContain("summarize the API change");
			expect(results).toContain("continued in the same conversation");
			expect(readFileSync(join(bob.workspacePath, "peer-result.txt"), "utf8")).toBe("cooperation works");
			await vi.waitFor(() =>
				expect(JSON.stringify(bobClient.state.entries)).toContain("continue the API discussion"),
			);
			expect(JSON.stringify(bobClient.state.entries)).toContain("sent with the peer tool");
			expect((await bob.status()).workers).toEqual([
				expect.objectContaining({ origin: "tui", sessionIds: [session] }),
			]);
		},
		120_000,
	);

	it.runIf(nativeIrohAvailable).each(["existing", "new"] as const)(
		"lets the terminal user pick a %s conversation",
		async (choice) => {
			const { alice, bob } = await pairedPeers();
			const bobClient = await openTerminal(bob);
			bob.faux.setResponses([fauxAssistantMessage("I am updating the API")]);
			await bobClient.promptAndWait("Update the API");
			bob.faux.setResponses([(context) => fauxAssistantMessage(`bob did: ${lastUserText(context)}`)]);
			alice.faux.setResponses([askBob({}), fauxAssistantMessage("bob answered")]);
			const client = await openTerminal(alice, true);
			await client.prompt("ask bob about the API change");
			await vi.waitFor(() => expect(pendingSelect(client)).toBeDefined(), { timeout: 30_000 });
			const question = pendingSelect(client)!;
			if (question.request.kind !== "select") throw new Error("expected select");
			expect(question.request.options).toContain("New conversation");
			expect(question.request.options.some((option) => option.includes(bobClient.conversation!))).toBe(true);
			const value =
				choice === "new"
					? "New conversation"
					: question.request.options.find((option) => option.includes(bobClient.conversation!))!;
			client.answer(question.requestId, { value });
			await client.waitForIdle(60_000);
			expect(peerResults(client)).toContain("bob did:");
			expect(peerResults(client)).toContain(`"created":${choice === "new"}`);
			const sessionIds = (await bob.status()).workers.flatMap((worker) => worker.sessionIds);
			expect(sessionIds).toHaveLength(choice === "new" ? 2 : 1);
		},
		120_000,
	);

	it.runIf(nativeIrohAvailable)(
		"delivers a non-blocking steer to a busy conversation",
		async () => {
			const { alice, bob } = await pairedPeers();
			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			bob.faux.setResponses([
				async () => {
					started.resolve();
					await release.promise;
					return fauxAssistantMessage("original work done");
				},
				(context) => fauxAssistantMessage(`steer received: ${lastUserText(context)}`),
			]);
			const bobClient = await openTerminal(bob);
			cleanups.push(async () => release.resolve());
			await bobClient.prompt("keep working");
			await started.promise;
			alice.faux.setResponses([
				askBob({ session: bobClient.conversation, wait: false }),
				fauxAssistantMessage("message delivered"),
			]);
			const client = await openTerminal(alice);
			await client.promptAndWait("send bob a steer", { timeoutMs: 60_000 });
			expect(peerResults(client)).toContain("Not waiting");
			expect(bobClient.isIdle()).toBe(false);
			release.resolve();
			await bobClient.waitForIdle(30_000);
			expect(JSON.stringify(bobClient.state.entries)).toContain("steer received:");
		},
		120_000,
	);

	it.runIf(nativeIrohAvailable).each(["new", "existing"] as const)(
		"cancels a wait on a %s conversation without aborting someone else's turn",
		async (target) => {
			const { alice, bob } = await pairedPeers();
			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			let aborted = false;
			bob.faux.setResponses([
				async (_context, options) => {
					const onAbort = () => {
						aborted = true;
						release.resolve();
					};
					if (options?.signal?.aborted) onAbort();
					options?.signal?.addEventListener("abort", onAbort, { once: true });
					started.resolve();
					await release.promise;
					options?.signal?.removeEventListener("abort", onAbort);
					return fauxAssistantMessage("finished");
				},
			]);
			const bobClient = target === "existing" ? await openTerminal(bob) : undefined;
			alice.faux.setResponses([
				askBob({ session: bobClient?.conversation ?? "new" }),
				fauxAssistantMessage("never reached"),
			]);
			const client = await openTerminal(alice);
			cleanups.push(async () => release.resolve());
			await client.prompt("ask bob about the API change");
			await started.promise;
			await client.intent("abort", {}, { expectedOrdinal: client.state.ordinal });
			await client.waitForIdle(30_000);
			if (target === "new") {
				await vi.waitFor(() => expect(aborted).toBe(true), { timeout: 10_000 });
			} else {
				expect(aborted).toBe(false);
				expect(bobClient!.isIdle()).toBe(false);
				await bobClient!.intent("abort", {}, { expectedOrdinal: bobClient!.state.ordinal });
				await vi.waitFor(() => expect(aborted).toBe(true));
				await bobClient!.waitForIdle(30_000);
			}
		},
		120_000,
	);
});
