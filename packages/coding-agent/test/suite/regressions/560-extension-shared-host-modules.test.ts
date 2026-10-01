import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Text } from "@hansjm10/volt-tui";
import { afterEach, describe, expect, it } from "vitest";
import { createEventBus, defineTool, discoverAndLoadExtensions } from "../../../src/index.ts";

interface ProbeEvent {
	defineTool: unknown;
	Text: unknown;
}

const EVALUATION_COUNT_KEY = `__volt560Evaluations_${Date.now()}_${Math.random().toString(36).slice(2)}`;
const globalState = globalThis as typeof globalThis & Record<string, number | undefined>;

const PROBE_EXTENSION = `import { defineTool } from "@hansjm10/volt-coding-agent";
import { Text } from "@hansjm10/volt-tui";

globalThis[${JSON.stringify(EVALUATION_COUNT_KEY)}] = (globalThis[${JSON.stringify(EVALUATION_COUNT_KEY)}] ?? 0) + 1;

export default function (volt) {
	volt.events.emit("probe", { defineTool, Text });
}
`;

describe("issue #560 extensions share host package modules", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		delete globalState[EVALUATION_COUNT_KEY];
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("serves Volt packages from the host instance while still evaluating extension sources per load", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "volt-560-"));
		tempDirs.push(tempDir);
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir);
		const extensionPath = join(tempDir, "probe.ts");
		writeFileSync(extensionPath, PROBE_EXTENSION);

		const eventBus = createEventBus();
		const probes: ProbeEvent[] = [];
		eventBus.on("probe", (data) => {
			probes.push(data as ProbeEvent);
		});

		for (let load = 0; load < 2; load++) {
			const result = await discoverAndLoadExtensions([extensionPath], tempDir, agentDir, eventBus);
			expect(result.errors).toEqual([]);
			expect(result.extensions).toHaveLength(1);
		}

		expect(probes).toHaveLength(2);
		for (const probe of probes) {
			expect(probe.defineTool).toBe(defineTool);
			expect(probe.Text).toBe(Text);
		}
		expect(globalState[EVALUATION_COUNT_KEY]).toBe(2);
	});
});
