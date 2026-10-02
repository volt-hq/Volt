import { stat, unlink } from "node:fs/promises";
import { afterEach, describe, expect, test } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.ts";

const createdPaths: string[] = [];

afterEach(async () => {
	await Promise.all(createdPaths.splice(0).map((path) => unlink(path).catch(() => undefined)));
});

describe.skipIf(process.platform === "win32")("temporary artifact permissions", () => {
	test("tool output spill files are private", async () => {
		const accumulator = new OutputAccumulator({ maxBytes: 1 });
		accumulator.append(Buffer.from("private tool output"));
		accumulator.finish();
		const outputPath = accumulator.snapshot({ persistIfTruncated: true }).fullOutputPath;
		expect(outputPath).toBeDefined();
		await accumulator.closeTempFile();
		createdPaths.push(outputPath!);

		expect((await stat(outputPath!)).mode & 0o777).toBe(0o600);
	});

	test("bash output spill files are private", async () => {
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.alloc(200_000, 0x78));
				return { exitCode: 0 };
			},
		};
		const result = await executeBashWithOperations("emit-private-output", process.cwd(), operations);
		expect(result.fullOutputPath).toBeDefined();
		createdPaths.push(result.fullOutputPath!);

		for (let attempt = 0; attempt < 20; attempt += 1) {
			try {
				expect((await stat(result.fullOutputPath!)).mode & 0o777).toBe(0o600);
				return;
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		}
		throw new Error("bash spill file was not created");
	});
});
