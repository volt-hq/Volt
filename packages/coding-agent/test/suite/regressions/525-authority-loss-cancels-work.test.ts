import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@hansjm10/volt-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionError, ExtensionFactory } from "../../../src/core/extensions/index.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { ExtensionUIDismissedError } from "../../../src/index.ts";
import { loseLog } from "../../lost-conversation-lock.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
const directories: string[] = [];
let unhandledRejections: unknown[] = [];
const onUnhandledRejection = (reason: unknown) => {
	unhandledRejections.push(reason);
};

beforeEach(() => {
	unhandledRejections = [];
	process.on("unhandledRejection", onUnhandledRejection);
});

afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.cleanupAsync().catch(() => {});
	}
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	// Let late rejections of abandoned work surface before the check.
	await new Promise((resolve) => setTimeout(resolve, 0));
	process.off("unhandledRejection", onUnhandledRejection);
	expect(unhandledRejections).toEqual([]);
});

async function createTestHarness(options: { extension?: ExtensionFactory; tools?: AgentTool[] } = {}) {
	const directory = mkdtempSync(join(tmpdir(), "volt-525-"));
	directories.push(directory);
	const harness = await createHarness({
		sessionManager: await SessionManager.create(directory),
		settings: { lsp: { enabled: false }, compaction: { enabled: false } },
		...(options.extension ? { extensionFactories: [options.extension] } : {}),
		...(options.tools ? { tools: options.tools } : {}),
	});
	harnesses.push(harness);
	const extensionErrors: ExtensionError[] = [];
	harness.session.extensionRunner.onError((error) => {
		extensionErrors.push(error);
	});
	return { harness, extensionErrors };
}

/** The session's lock is lost, and its next commit finds that out. */
function loseLock(harness: Harness): Promise<Error> {
	return loseLog(harness.session.sessionWriter);
}

function withinTimeout<T>(promise: Promise<T>, label: string, ms = 5_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

describe("regression #525: a session that loses its log cancels its own work", () => {
	it("stops waiting for a command that never settles and aborts its ctx.signal", async () => {
		const started = Promise.withResolvers<AbortSignal>();
		const { harness, extensionErrors } = await createTestHarness({
			extension: (volt) => {
				volt.registerCommand("block", {
					description: "Never finishes",
					handler: async (_args, ctx) => {
						started.resolve(ctx.signal);
						await new Promise<never>(() => {});
					},
				});
			},
		});

		const prompt = harness.session.prompt("/block");
		const signal = await started.promise;
		expect(signal.aborted).toBe(false);
		expect(harness.session.isBusy).toBe(true);

		const lost = await loseLock(harness);

		await expect(withinTimeout(prompt, "prompt('/block')")).resolves.toBeUndefined();
		await withinTimeout(harness.session.waitForNotBusy(), "waitForNotBusy()");
		expect(harness.session.isBusy).toBe(false);
		expect(signal.aborted).toBe(true);
		expect(signal.reason).toBe(lost);
		expect(extensionErrors).toEqual([]);
	});

	it("does not report a command that fails with its own cancellation after the loss", async () => {
		const started = Promise.withResolvers<void>();
		const { harness, extensionErrors } = await createTestHarness({
			extension: (volt) => {
				volt.registerCommand("cooperative", {
					description: "Rejects with its signal's reason",
					handler: async (_args, ctx) => {
						started.resolve();
						await new Promise<never>((_, reject) => {
							ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true });
						});
					},
				});
			},
		});

		const prompt = harness.session.prompt("/cooperative");
		await started.promise;
		await loseLock(harness);

		await expect(withinTimeout(prompt, "prompt('/cooperative')")).resolves.toBeUndefined();
		await withinTimeout(harness.session.waitForNotBusy(), "waitForNotBusy()");
		expect(extensionErrors).toEqual([]);
	});

	it("aborts a tool that is waiting on its signal and lets the session go idle", async () => {
		const toolStarted = Promise.withResolvers<AbortSignal>();
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait until aborted",
			parameters: Type.Object({}),
			execute: async (_toolCallId, _params, signal) => {
				if (!signal) throw new Error("expected a tool signal");
				toolStarted.resolve(signal);
				await new Promise<never>((_, reject) => {
					signal.addEventListener("abort", () => reject(new Error("tool aborted")), { once: true });
				});
				throw new Error("unreachable");
			},
		};
		const { harness } = await createTestHarness({ tools: [waitTool] });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("must not be requested"),
		]);

		const prompt = harness.session.prompt("start");
		const toolSignal = await toolStarted.promise;
		expect(harness.session.isStreaming).toBe(true);

		await loseLock(harness);

		await withinTimeout(Promise.allSettled([prompt]), "prompt('start')");
		await withinTimeout(harness.session.waitForNotBusy(), "waitForNotBusy()");
		expect(toolSignal.aborted).toBe(true);
		expect(harness.session.isBusy).toBe(false);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("gives commands a session-lifetime ctx.signal that aborts when the session is disposed", async () => {
		const signals: AbortSignal[] = [];
		const { harness } = await createTestHarness({
			extension: (volt) => {
				volt.registerCommand("signal", {
					description: "Records its signal",
					handler: async (_args, ctx) => {
						signals.push(ctx.signal);
					},
				});
			},
		});

		await harness.session.prompt("/signal");
		await harness.session.prompt("/signal");

		expect(signals).toHaveLength(2);
		expect(signals[0]).toBeInstanceOf(AbortSignal);
		expect(signals[1]).toBe(signals[0]);
		expect(signals[0]?.aborted).toBe(false);

		harness.session.dispose();
		expect(signals[0]?.aborted).toBe(true);
	});

	it("ends a command quietly when its custom UI is dismissed by the host", async () => {
		const { harness, extensionErrors } = await createTestHarness({
			extension: (volt) => {
				volt.registerCommand("dismissed", {
					description: "UI torn down by the host",
					handler: async () => {
						throw new ExtensionUIDismissedError();
					},
				});
				volt.registerCommand("broken", {
					description: "Fails on its own",
					handler: async () => {
						throw new Error("broken command");
					},
				});
			},
		});

		await harness.session.prompt("/dismissed");
		expect(extensionErrors).toEqual([]);

		await harness.session.prompt("/broken");
		expect(extensionErrors).toEqual([
			expect.objectContaining({ extensionId: "inline-1", event: "command", error: "broken command" }),
		]);
	});
});
