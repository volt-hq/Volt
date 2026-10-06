/**
 * User shell commands run on the host for every client: the `bash` intent
 * fires `user_bash` first, an extension's result short-circuits the command,
 * and the live `bash` value shows the running command, its output growing by
 * patches, until its `bashExecution` entry commits.
 */

import type { LiveValue } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createLoopbackClient, type LoopbackClient } from "../../src/client/protocol-client.ts";
import type { ExtensionAPI } from "../../src/core/extensions/index.ts";
import type { HostedConversation } from "../../src/core/host/hosted-conversation.ts";
import { createHostHarness } from "./host-harness.ts";

type BashValue = Extract<LiveValue, { kind: "bash" }>;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

async function setup(extension?: (volt: ExtensionAPI) => void): Promise<{
	conversation: HostedConversation;
	client: LoopbackClient;
	/** Every `bash` value the client held, in order. */
	seen: BashValue[];
}> {
	const harness = await createHostHarness(extension === undefined ? {} : { extension });
	cleanups.push(() => harness.cleanup());
	const conversation = await harness.openStartup();
	const client = await createLoopbackClient(harness.host, conversation);
	cleanups.push(() => client.stop());
	const seen: BashValue[] = [];
	client.onChange(() => {
		const value = client.live.values.get("bash");
		if (value?.kind === "bash" && JSON.stringify(value) !== JSON.stringify(seen.at(-1))) seen.push(value);
	});
	return { conversation, client, seen };
}

function bashEntries(conversation: HostedConversation) {
	return conversation.session.messages.filter((message) => message.role === "bashExecution");
}

describe("user shell commands", () => {
	it("shows the running command and its output until its entry commits", async () => {
		const { conversation, client, seen } = await setup();
		const accepted = await client.intent("bash", { command: "printf 'one\\n'; sleep 0.3; printf 'two\\n'" });
		expect(accepted.result).toMatchObject({ output: "one\ntwo\n", exitCode: 0, cancelled: false });
		await client.caughtUp();

		// It ran: the command with no output yet, then each line as it arrived, then its exit code.
		expect(seen[0]).toMatchObject({
			kind: "bash",
			command: "printf 'one\\n'; sleep 0.3; printf 'two\\n'",
			output: { type: "terminal", lines: [] },
		});
		expect(seen.some((value) => value.output.lines.join("\n") === "one" && value.exitCode === undefined)).toBe(true);
		expect(seen.at(-1)).toMatchObject({ output: { lines: ["one", "two"] }, exitCode: 0 });
		// The committed entry replaced it.
		expect(client.live.values.has("bash")).toBe(false);
		expect(bashEntries(conversation)).toEqual([
			expect.objectContaining({ command: "printf 'one\\n'; sleep 0.3; printf 'two\\n'", output: "one\ntwo\n" }),
		]);
	});

	it("records an extension's result instead of running the command, and marks `!!` output", async () => {
		const handled: string[] = [];
		const { conversation, client, seen } = await setup((volt) => {
			volt.on("user_bash", (event) => {
				handled.push(`${event.command}:${event.excludeFromContext}`);
				if (event.command !== "handled-by-extension") return undefined;
				return {
					result: {
						output: "from \u001b[31mthe\u001b[0m extension\n",
						exitCode: 0,
						cancelled: false,
						truncated: false,
					},
				};
			});
		});
		const accepted = await client.intent("bash", { command: "handled-by-extension", excludeFromContext: true });
		expect(accepted.result).toEqual({
			output: "from \u001b[31mthe\u001b[0m extension\n",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		});
		await client.caughtUp();
		expect(handled).toEqual(["handled-by-extension:true"]);
		// Shown as it was recorded, its output without terminal controls.
		expect(seen.at(-1)).toMatchObject({
			command: "handled-by-extension",
			excludeFromContext: true,
			output: { lines: ["from the extension"] },
			exitCode: 0,
		});
		expect(client.live.values.has("bash")).toBe(false);
		expect(bashEntries(conversation)).toEqual([
			expect.objectContaining({ command: "handled-by-extension", excludeFromContext: true, exitCode: 0 }),
		]);

		// Without a result, the hook saw it and the host ran it.
		await client.intent("bash", { command: "printf ran" });
		expect(handled).toEqual(["handled-by-extension:true", "printf ran:false"]);
		expect(bashEntries(conversation).at(-1)).toMatchObject({ command: "printf ran", output: "ran" });
	});
});
