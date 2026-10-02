import { describe, it } from "vitest";
import { assertLspCliScenario, LSP_CLI_SCENARIOS, runLspCliScenario } from "./fixtures/lsp-cli-scenario.ts";

// This is intentionally a real source CLI process, not createAgentSession with injected tools.
// Each case owns its workspace, settings, model registry, session store and LSP process.
describe("synthetic JSON CLI LSP diagnostics", () => {
	it.each(LSP_CLI_SCENARIOS)(
		"%s preserves mutation, model, event and persisted evidence",
		async (scenario) => {
			const report = await runLspCliScenario(scenario);
			assertLspCliScenario(report);
		},
		55_000,
	);
});
