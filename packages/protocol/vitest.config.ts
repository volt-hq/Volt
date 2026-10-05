import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const aiSrcSchemas = fileURLToPath(new URL("../ai/src/schemas.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		// Local runs use half the host's cores; set VITEST_MAX_WORKERS to share a busy host. CLI and pool overrides still apply.
		maxWorkers: process.env.CI && process.env.CI !== "false" ? 8 : "50%",
	},
	resolve: {
		alias: [{ find: /^@hansjm10\/volt-ai\/schemas$/, replacement: aiSrcSchemas }],
	},
});
