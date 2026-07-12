import { describe, expect, it, vi } from "vitest";
import { type DurableAtomicWriteOperations, writeDurableAtomicFile } from "../src/utils/durable-atomic-write.ts";

function createOperations(events: string[]): DurableAtomicWriteOperations {
	return {
		mkdir: vi.fn(async () => {
			events.push("mkdir");
		}),
		open: vi.fn(async (_path, flags) => {
			const kind = flags === "r" ? "parent" : "temp";
			events.push(`open:${kind}`);
			return {
				writeFile: vi.fn(async (content: string) => {
					events.push(`write:${content}`);
				}),
				sync: vi.fn(async () => {
					events.push(`sync:${kind}`);
				}),
				close: vi.fn(async () => {
					events.push(`close:${kind}`);
				}),
			};
		}),
		rename: vi.fn(async () => {
			events.push("rename");
		}),
		rm: vi.fn(async () => {
			events.push("rm");
		}),
	};
}

describe("durable atomic writes", () => {
	it("fsyncs the temp file before rename and the parent directory after rename", async () => {
		const events: string[] = [];
		await writeDurableAtomicFile("/state/host.json", "payload", { operations: createOperations(events) });

		expect(events).toEqual([
			"mkdir",
			"open:temp",
			"write:payload",
			"sync:temp",
			"close:temp",
			"rename",
			"open:parent",
			"sync:parent",
			"close:parent",
		]);
	});

	it("closes and removes an unrenamed temp file when fsync fails", async () => {
		const events: string[] = [];
		const operations = createOperations(events);
		operations.open = vi.fn(async (_path, flags) => {
			const kind = flags === "r" ? "parent" : "temp";
			events.push(`open:${kind}`);
			return {
				writeFile: vi.fn(async () => {
					events.push(`write:${kind}`);
				}),
				sync: vi.fn(async () => {
					events.push(`sync:${kind}`);
					throw new Error("injected fsync failure");
				}),
				close: vi.fn(async () => {
					events.push(`close:${kind}`);
				}),
			};
		});

		await expect(writeDurableAtomicFile("/state/host.json", "payload", { operations })).rejects.toThrow(
			"injected fsync failure",
		);
		expect(events).toEqual(["mkdir", "open:temp", "write:temp", "sync:temp", "close:temp", "rm"]);
		expect(operations.rename).not.toHaveBeenCalled();
	});
});
