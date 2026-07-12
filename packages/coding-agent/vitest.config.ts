import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcOAuth = fileURLToPath(new URL("../ai/src/oauth.ts", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("../agent/src/index.ts", import.meta.url));
const tuiSrcIndex = fileURLToPath(new URL("../tui/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		exclude: [
			...configDefaults.exclude,
			// This relay fixture uses Node's built-in test runner and is exercised by
			// its own package script. Collecting it in Vitest produces an empty suite.
			"examples/remote/firebase-push-relay/functions/**/*.test.js",
		],
		testTimeout: 30000,
		maxWorkers: 8,
		minWorkers: 1,
		server: {
			deps: {
				external: [/@silvia-odwyer\/photon-node/],
			},
		},
	},
	resolve: {
		alias: [
			{ find: /^@earendil-works\/volt-ai$/, replacement: aiSrcIndex },
			{ find: /^@earendil-works\/volt-ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@earendil-works\/volt-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@earendil-works\/volt-tui$/, replacement: tuiSrcIndex },
			{ find: /^@mariozechner\/volt-ai$/, replacement: aiSrcIndex },
			{ find: /^@mariozechner\/volt-ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@mariozechner\/volt-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@mariozechner\/volt-tui$/, replacement: tuiSrcIndex },
		],
	},
});
