import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcSchemas = fileURLToPath(new URL("../ai/src/schemas.ts", import.meta.url));
const protocolSrcEntries = fileURLToPath(new URL("../protocol/src/entries.ts", import.meta.url));
const protocolSrcWork = fileURLToPath(new URL("../protocol/src/work.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000, // 30 seconds for API calls
		// Local runs use half the host's cores; set VITEST_MAX_WORKERS to share a busy host. CLI and pool overrides still apply.
		maxWorkers: process.env.CI && process.env.CI !== "false" ? 8 : "50%",
	},
	resolve: {
		alias: [
			{ find: /^@hansjm10\/volt-ai$/, replacement: aiSrcIndex },
			{ find: /^@hansjm10\/volt-ai\/schemas$/, replacement: aiSrcSchemas },
			{ find: /^@hansjm10\/volt-protocol\/entries$/, replacement: protocolSrcEntries },
			{ find: /^@hansjm10\/volt-protocol\/work$/, replacement: protocolSrcWork },
		],
	},
});
