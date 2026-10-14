/**
 * An extension inventory as a process of its own (`volt daemon extension-inventory`, started from this
 * checkout's source by `ProcessWorkerLauncher`): it loads the root's extensions, writes its result on fd 3
 * whatever the extensions print, and keeps a private log beside the workers'.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Compile } from "typebox/compile";
import { afterEach, describe, expect, it } from "vitest";
import { ExtensionInventoryProbeOutputSchema } from "../src/daemon/extension-inventory.ts";
import { getWorkerLogDirectory } from "../src/daemon/paths.ts";
import { ProcessWorkerLauncher } from "../src/daemon/worker-launcher.ts";

/** The process starts from source here: compiling it can take a while on a cold cache. */
const PROCESS_TEST_TIMEOUT_MS = 180_000;

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("extension inventory processes", () => {
	it(
		"evaluates the root's extensions in a process of its own and returns them on fd 3",
		async () => {
			const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "volt-extension-inventory-process-")));
			tempDirs.push(tempDir);
			const root = join(tempDir, "workspace");
			const agentDir = join(tempDir, "agent");
			mkdirSync(join(root, ".volt", "extensions"), { recursive: true });
			mkdirSync(agentDir, { recursive: true });
			writeFileSync(
				join(root, ".volt", "extensions", "noisy.ts"),
				`export const manifest = { id: "noisy", displayName: "Noisy" };
export default function (volt) {
	// What an extension prints goes to the log, never into the result.
	console.log("{\\"ok\\":false,\\"error\\":\\"spoofed\\"}");
	volt.registerReviewEngine("quick", { label: "Quick", description: "Fast.", targets: ["pr"], remoteSafe: true, async run() {} });
}
`,
			);

			const launched = new ProcessWorkerLauncher().launchExtensionInventory({
				id: "test-1",
				agentDir,
				root,
				projectTrusted: true,
			});
			const output = await launched.result;

			expect(Compile(ExtensionInventoryProbeOutputSchema).Check(output)).toBe(true);
			expect(output).toMatchObject({
				ok: true,
				projectTrusted: true,
				cacheable: true,
				extensions: [{ id: "noisy", state: "active", scope: "project" }],
				reviewEngines: [{ id: "ext:noisy/quick", label: "Quick", targets: ["pr"], remoteSafe: true }],
			});

			const logPath = join(getWorkerLogDirectory(agentDir), "inventory-test-1.log");
			expect(existsSync(logPath)).toBe(true);
			if (process.platform !== "win32") expect(statSync(logPath).mode & 0o777).toBe(0o600);
			expect(readFileSync(logPath, "utf8")).toContain("spoofed");
		},
		PROCESS_TEST_TIMEOUT_MS,
	);

	it(
		"rejects when killed before it writes a result",
		async () => {
			const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "volt-extension-inventory-process-")));
			tempDirs.push(tempDir);
			const agentDir = join(tempDir, "agent");
			mkdirSync(agentDir, { recursive: true });
			const launched = new ProcessWorkerLauncher().launchExtensionInventory({
				id: "test-2",
				agentDir,
				root: tempDir,
				projectTrusted: false,
			});
			launched.kill();
			await expect(launched.result).rejects.toThrow(/wrote no result/);
		},
		PROCESS_TEST_TIMEOUT_MS,
	);
});
