/**
 * The CLI's yes/no prompt answers no when the user ends it with Ctrl+C or
 * Ctrl+D, so a caller that rolls back on "no" (a declined permission review)
 * runs its rollback instead of exiting with the change in place.
 */

import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promptConfirm } from "../src/daemon/cli.ts";

vi.mock("node:readline", () => ({ createInterface: vi.fn() }));

class FakeReadline extends EventEmitter {
	answer: ((answer: string) => void) | undefined;
	readonly close = vi.fn(() => {
		this.emit("close");
	});

	question(_query: string, answer: (answer: string) => void): void {
		this.answer = answer;
	}
}

describe("promptConfirm", () => {
	const tty = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };
	let readline: FakeReadline;

	beforeEach(() => {
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		readline = new FakeReadline();
		vi.mocked(createInterface).mockReturnValue(readline as unknown as ReturnType<typeof createInterface>);
	});

	afterEach(() => {
		Object.defineProperty(process.stdin, "isTTY", { value: tty.stdin, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: tty.stdout, configurable: true });
		vi.clearAllMocks();
	});

	it("answers yes only for y or yes", async () => {
		const asked = promptConfirm("Proceed?");
		readline.answer?.(" Yes ");
		await expect(asked).resolves.toBe(true);
		expect(readline.close).toHaveBeenCalledOnce();
	});

	it.each([
		["Ctrl+C", (prompt: FakeReadline) => prompt.emit("SIGINT")],
		["Ctrl+D", (prompt: FakeReadline) => prompt.close()],
	])("answers no when the prompt ends with %s", async (_key, end) => {
		const asked = promptConfirm("Acknowledge these permissions?");
		end(readline);
		await expect(asked).resolves.toBe(false);
	});
});
