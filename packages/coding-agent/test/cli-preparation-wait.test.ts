import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@hansjm10/volt-ai";
import { expect, it, vi } from "vitest";
import { restoreStdout } from "../src/core/output-guard.ts";
import { main } from "../src/main.ts";

it.each([undefined, 0, 800, 1000])("passes the CLI preparation allowance %s to the actual runtime", async (wait) => {
	const root = mkdtempSync(join(tmpdir(), "volt-cli-preparation-"));
	const workspace = join(root, "workspace");
	const agentDir = join(root, "agent");
	mkdirSync(workspace);
	mkdirSync(agentDir);
	const previousCwd = process.cwd();
	const previousExitCode = process.exitCode;
	const stdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
	const faux = registerFauxProvider();
	const model = faux.getModel();
	faux.setResponses([fauxAssistantMessage("")]);
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				[model.provider]: { api: faux.api, apiKey: "faux-key", baseUrl: "http://localhost:0", models: faux.models },
			},
		}),
	);
	const observed: Array<{ available: number; requested: number }> = [];
	try {
		process.chdir(workspace);
		vi.stubEnv("HOME", root);
		vi.stubEnv("VOLT_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("VOLT_CODING_AGENT_SESSION_DIR", join(root, "sessions"));
		vi.stubEnv("VOLT_OFFLINE", "1");
		vi.stubEnv("VOLT_SKIP_VERSION_CHECK", "1");
		Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
		await main(
			[
				"--print",
				"--offline",
				"--no-session",
				"--no-tools",
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-context-files",
				"--model",
				`${model.provider}/${model.id}`,
				...(wait === undefined ? [] : ["--preparation-wait-ms", String(wait)]),
				"inspect allowance",
			],
			{
				extensionFactories: [
					(volt) => {
						volt.on("request_boundary", (event, ctx) => {
							observed.push({
								available: event.waitAvailableMs,
								requested: ctx.work!.context.requestWait(2000),
							});
						});
					},
				],
			},
		);
		expect(observed).toEqual([{ available: wait ?? 0, requested: wait ?? 0 }]);
		expect(faux.state.callCount).toBe(1);
	} finally {
		restoreStdout();
		process.chdir(previousCwd);
		process.exitCode = previousExitCode;
		vi.unstubAllEnvs();
		if (stdinIsTTY) Object.defineProperty(process.stdin, "isTTY", stdinIsTTY);
		else Reflect.deleteProperty(process.stdin, "isTTY");
		faux.unregister();
		rmSync(root, { recursive: true, force: true });
	}
});
