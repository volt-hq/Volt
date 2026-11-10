#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { supervisePilot, waitForPilotOwner } from "./run-compaction-quality.mjs";

// Two minutes for cleanup beyond the worker's configurable deadline. Validate before spawning.
export function routingSupervisorTimeout(args) {
	const index = args.indexOf("--minutes");
	const value = index === -1 ? "30" : args[index + 1];
	const minutes = Number(value);
	if (!/^\d+$/.test(value ?? "") || !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 60)
		throw new Error("--minutes must be an integer from 1 through 60");
	return (minutes + 2) * 60_000;
}

// Reuse the existing pilot supervisor: provider calls cannot outlive their owning process.
const launcher = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === launcher) {
	if (process.argv[2] === "--worker" && process.send) {
		process.argv.splice(2, 1);
		await waitForPilotOwner();
		const entry = fileURLToPath(new URL("../packages/coding-agent/benchmarks/code-mode-routing-cli.ts", import.meta.url));
		process.argv[1] = entry;
		const jiti = createJiti(entry, {
			tsconfigPaths: fileURLToPath(new URL("../tsconfig.json", import.meta.url)),
		});
		await jiti.import(entry);
	} else {
		process.exitCode = await supervisePilot(launcher, ["--worker", ...process.argv.slice(2)], {
			timeoutMs: routingSupervisorTimeout(process.argv.slice(2)),
		});
	}
}
