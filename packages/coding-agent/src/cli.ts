#!/usr/bin/env node
/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: npx tsx src/cli-new.ts [args...]
 */
import { handleLspAuditCommand } from "./cli/lsp-audit.ts";
import { APP_NAME } from "./config.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { main } from "./main.ts";

process.title = APP_NAME;
process.env.VOLT_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

const args = process.argv.slice(2);
void handleLspAuditCommand(args).then((handled) => {
	if (!handled) {
		// Configure undici only for normal startup, never for an offline audit.
		configureHttpDispatcher();
		return main(args);
	}
});
