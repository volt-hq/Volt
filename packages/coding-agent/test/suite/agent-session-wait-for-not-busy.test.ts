import type { AgentTool } from "@hansjm10/volt-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { BashOperations } from "../../src/core/tools/bash.ts";
import { scheduleDetachedRuntimeRetention } from "../../src/remote/integrated-runtime-retention.ts";
import { createHarness, type Harness } from "./harness.ts";

function gate(): { promise: Promise<void>; release: () => void } {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

/** A `!` command whose process exits when the gate is released. */
function blockingBash(exit: Promise<void>): BashOperations {
	return {
		exec: async () => {
			await exit;
			return { exitCode: 0 };
		},
	};
}

/** Yield several macrotasks so any pending settlement can run. */
async function drain(): Promise<void> {
	for (let index = 0; index < 5; index++) await new Promise((resolve) => setImmediate(resolve));
}

function track(promise: Promise<void>): { readonly settled: boolean } {
	const state = { settled: false };
	void promise.then(() => {
		state.settled = true;
	});
	return state;
}

describe("AgentSession.waitForNotBusy", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.cleanupAsync();
	});

	async function create(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
		const harness = await createHarness(options);
		harnesses.push(harness);
		return harness;
	}

	it("waits for a ! command that waitForIdle does not cover", async () => {
		const harness = await create();
		const exit = gate();
		const bash = harness.session.executeBash("sleep", undefined, { operations: blockingBash(exit.promise) });
		await drain();
		expect(harness.session.isBusy).toBe(true);

		await harness.session.waitForIdle();
		const notBusy = track(harness.session.waitForNotBusy());
		await drain();
		expect(notBusy.settled).toBe(false);

		exit.release();
		await bash;
		await drain();
		expect(notBusy.settled).toBe(true);
		expect(harness.session.isBusy).toBe(false);
	});

	it("waits for an extension command waiting on the user", async () => {
		const answer = gate();
		const harness = await create({
			extensionFactories: [
				(volt) => {
					volt.registerCommand("ask", {
						description: "Wait for an answer",
						handler: async () => {
							await answer.promise;
						},
					});
				},
			],
		});
		const command = harness.session.prompt("/ask");
		await drain();
		expect(harness.session.isBusy).toBe(true);

		const notBusy = track(harness.session.waitForNotBusy());
		await drain();
		expect(notBusy.settled).toBe(false);

		answer.release();
		await command;
		await drain();
		expect(notBusy.settled).toBe(true);
	});

	it("waits for a turn to settle", async () => {
		const toolDone = gate();
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await toolDone.promise;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await create({ tools: [waitTool] });
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const prompt = harness.session.prompt("start");
		await drain();

		const notBusy = track(harness.session.waitForNotBusy());
		await drain();
		expect(notBusy.settled).toBe(false);

		toolDone.release();
		await prompt;
		await drain();
		expect(notBusy.settled).toBe(true);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it("resolves when the session is disposed while busy", async () => {
		const harness = await create();
		const exit = gate();
		const bash = harness.session.executeBash("sleep", undefined, { operations: blockingBash(exit.promise) });
		await drain();

		const notBusy = track(harness.session.waitForNotBusy());
		harness.session.dispose();
		await drain();
		expect(notBusy.settled).toBe(true);

		exit.release();
		await bash.catch(() => {});
	});

	it("keeps detached runtime retention waiting, without spinning, while a ! command runs", async () => {
		const harness = await create();
		const exit = gate();
		const bash = harness.session.executeBash("sleep", undefined, { operations: blockingBash(exit.promise) });
		await drain();

		let waits = 0;
		let expired = false;
		// Composed like the daemon's detached-runtime retention for one session.
		const handle = scheduleDetachedRuntimeRetention({
			ttlMs: 50,
			isDetached: () => true,
			isActive: () => harness.session.isBusy,
			waitForIdle: async () => {
				waits++;
				if (waits > 100) handle.cancel();
				await harness.session.waitForNotBusy();
			},
			onExpire: () => {
				expired = true;
			},
		});
		await drain();
		expect(waits).toBe(1);
		expect(expired).toBe(false);

		exit.release();
		await bash;
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(waits).toBe(1);
		expect(expired).toBe(true);
	});
});
