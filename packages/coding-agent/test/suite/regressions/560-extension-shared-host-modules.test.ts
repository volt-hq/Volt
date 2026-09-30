import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Text } from "@hansjm10/volt-tui";
import { afterEach, describe, expect, it } from "vitest";
import { createEventBus, defineTool, discoverAndLoadExtensions } from "../../../src/index.ts";

interface ProbeEvent {
	defineTool: unknown;
	Text: unknown;
	moduleEvaluations: number;
}

const PROBE_EXTENSION = `import { defineTool } from "@hansjm10/volt-coding-agent";
import { Text } from "@hansjm10/volt-tui";

let moduleEvaluations = 0;
moduleEvaluations++;

export default function (volt) {
	volt.events.emit("probe", { defineTool, Text, moduleEvaluations });
}
`;

describe("issue #560 extensions share host package modules", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
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
			expect(probe.moduleEvaluations).toBe(1);
		}
	});
});
