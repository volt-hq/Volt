// Standalone synthetic acceptance runner; no build or provider credentials required.
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const repoRoot = new URL("../../../", import.meta.url);
const jiti = createJiti(import.meta.url, {
	alias: {
		"@hansjm10/volt-agent-core/node": fileURLToPath(new URL("packages/agent/src/node.ts", repoRoot)),
		"@hansjm10/volt-agent-core": fileURLToPath(new URL("packages/agent/src/index.ts", repoRoot)),
		"@hansjm10/volt-ai": fileURLToPath(new URL("packages/ai/src/index.ts", repoRoot)),
		"@hansjm10/volt-ai/oauth": fileURLToPath(new URL("packages/ai/src/oauth.ts", repoRoot)),
		"@hansjm10/volt-tui": fileURLToPath(new URL("packages/tui/src/index.ts", repoRoot)),
	},
});
const fixture = await jiti.import(fileURLToPath(new URL("./fixtures/lsp-cli-scenario.ts", import.meta.url)));

if (process.argv[2] === "--child") {
	fixture.prepareLspCliChild(process.argv[3], process.argv[4]);
	// Import the production entry point, not main() with injected tools/services.
	await jiti.import(fileURLToPath(new URL("packages/coding-agent/src/cli.ts", repoRoot)));
} else {
	const args = process.argv.slice(2);
	if (args.length !== 2 || args[0] !== "--scenario" || !fixture.LSP_CLI_SCENARIOS.includes(args[1])) {
		console.error(`Usage: node test/lsp-cli-runner.mjs --scenario <${fixture.LSP_CLI_SCENARIOS.join("|")}>`);
		process.exitCode = 2;
	} else {
		const controller = new AbortController();
		const cancel = () => controller.abort();
		process.once("SIGINT", cancel);
		process.once("SIGTERM", cancel);
		try {
			const report = await fixture.runLspCliScenario(args[1], controller.signal);
			fixture.assertLspCliScenario(report);
			console.log(JSON.stringify({
				scenario: report.scenario,
				result: "passed",
				toolResults: report.toolEnds.length,
				fauxRequests: report.requests.length,
				persistedToolResults: report.persisted.length,
				agentSettled: report.events.some((event) => event.type === "agent_settled"),
				exitCode: report.exitCode,
				cleanup: report.cleanup,
			}));
		} catch (error) {
			console.error(error);
			process.exitCode = 1;
		} finally {
			process.off("SIGINT", cancel);
			process.off("SIGTERM", cancel);
		}
	}
}
