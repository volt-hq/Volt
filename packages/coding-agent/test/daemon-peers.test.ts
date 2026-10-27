import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
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

/** Turn on the experimental `peer` tool for the harness's terminal conversations. */
function enablePeerTool(harness: DaemonHarness): void {
	const path = join(harness.agentDir, "settings.json");
	const settings = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	writeFileSync(path, `${JSON.stringify({ ...settings, remote: { peers: true } })}\n`);
}

/** A pairing ticket for the harness's workspace, from a control connection that stays open until the harness closes. */
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

/** Bob's host, and Alice's daemon paired with it as the peer `bob`, with the `peer` tool on. */
async function pairedPeers(): Promise<{ alice: DaemonHarness; bob: DaemonHarness }> {
	const bob = await startHarness({ extensions: [createIrohDaemonService({ relayMode: "disabled" })] });
	const alice = await startHarness({ extensions: [createPeerDaemonService()] });
	enablePeerTool(alice);
	const added = await alice.control.request({ type: "peer_add", name: "bob", ticket: await pairingTicket(bob) });
	expect(added).toMatchObject({ type: "peer_result", peer: { name: "bob", workspace: bob.workspaceName } });
	return { alice, bob };
}

/** A terminal conversation in Alice's workspace, as a TUI opens it. */
async function openTerminal(alice: DaemonHarness): Promise<ProtocolClient> {
	const tui = await alice.connect("tui");
	const { transport } = await openDaemonConversation(tui, {
		target: { kind: "new" },
		spawn: { env: {}, config: {}, cwd: alice.workspacePath, persist: true, session: {} },
		clientKey: "tui-1",
	});
	const client = new ProtocolClient({ followMoves: "reconnect" });
	cleanups.push(() => client.stop());
	await client.connect(transport);
	return client;
}

const ASK_BOB = fauxAssistantMessage([fauxToolCall("peer", { peer: "bob", task: "summarize the API change" })], {
	stopReason: "toolUse",
});

function lastUserText(context: Context): string {
	const message = context.messages.findLast((candidate) => candidate.role === "user");
	if (message === undefined) return "";
	if (typeof message.content === "string") return message.content;
	return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
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
		"delegates a terminal conversation's task to the agent of a paired peer",
		async () => {
			const { alice, bob } = await pairedPeers();
			expect(await alice.control.request({ type: "peers_list" })).toMatchObject({
				type: "peers_result",
				peers: [{ name: "bob", workspace: bob.workspaceName }],
			});
			// Bob's host lists Alice's daemon as a paired client.
			expect((await bob.status()).clients).toEqual([
				expect.objectContaining({ label: expect.stringMatching(/^peer:/) }),
			]);

			bob.faux.setResponses([(context) => fauxAssistantMessage(`bob did: ${lastUserText(context)}`)]);
			alice.faux.setResponses([ASK_BOB, fauxAssistantMessage("bob answered")]);
			const client = await openTerminal(alice);
			await client.promptAndWait("ask bob about the API change", { timeoutMs: 60_000 });

			// The peer's reply is the tool's result in Alice's conversation.
			const toolResult = client.state.entries.find(
				(entry) => entry.type === "message" && entry.view?.role === "tool" && entry.view.toolName === "peer",
			);
			expect(JSON.stringify(toolResult?.payload)).toContain("bob did: summarize the API change");
			// The task ran in a conversation of its own on Bob's host.
			expect((await bob.status()).workers).toEqual([
				expect.objectContaining({ origin: "phone", sessionIds: [expect.any(String)] }),
			]);
		},
		120_000,
	);

	it.runIf(nativeIrohAvailable)(
		"stops the peer's turn when the delegating turn is aborted",
		async () => {
			const { alice, bob } = await pairedPeers();
			const started = Promise.withResolvers<void>();
			let aborted = false;
			// A turn on Bob's host that ends only once it is aborted.
			bob.faux.setResponses([
				async (_context, options) => {
					started.resolve();
					await new Promise<void>((resolve) => {
						if (options?.signal?.aborted) resolve();
						options?.signal?.addEventListener("abort", () => resolve(), { once: true });
					});
					aborted = true;
					return fauxAssistantMessage("aborted");
				},
			]);
			alice.faux.setResponses([ASK_BOB, fauxAssistantMessage("never reached")]);
			const client = await openTerminal(alice);
			await client.prompt("ask bob about the API change");
			await started.promise;

			await client.intent("abort", {}, { expectedOrdinal: client.state.ordinal });
			await vi.waitFor(() => expect(aborted).toBe(true), { timeout: 10_000 });
			await client.waitForIdle(30_000);
		},
		120_000,
	);
});
