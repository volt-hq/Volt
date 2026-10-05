import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const testAgentDir = join(tmpdir(), `volt-coding-agent-vitest-${randomUUID()}`);
const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcOAuth = fileURLToPath(new URL("../ai/src/oauth.ts", import.meta.url));
const aiSrcSchemas = fileURLToPath(new URL("../ai/src/schemas.ts", import.meta.url));
const protocolSrc = fileURLToPath(new URL("../protocol/src/", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("../agent/src/index.ts", import.meta.url));
const tuiSrcIndex = fileURLToPath(new URL("../tui/src/index.ts", import.meta.url));
// Examples import the package's runtime values (defineManifest); tests that load them resolve it to the source.
const codingAgentSrcIndex = fileURLToPath(new URL("./src/index.ts", import.meta.url));

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
		globalSetup: "./test/vitest-global-setup.ts",
		env: {
			VOLT_CODING_AGENT_DIR: testAgentDir,
			VOLT_CODING_AGENT_SESSION_DIR: "",
		},
		// Keep local runs within a shared host budget; CLI and pool overrides still apply.
		maxWorkers: process.env.CI && process.env.CI !== "false" ? 8 : 2,
		server: {
			deps: {
				external: [/@silvia-odwyer\/photon-node/],
			},
		},
	},
	resolve: {
		alias: [
			{ find: /^@hansjm10\/volt-ai$/, replacement: aiSrcIndex },
			{ find: /^@hansjm10\/volt-ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@hansjm10\/volt-ai\/schemas$/, replacement: aiSrcSchemas },
			{ find: /^@hansjm10\/volt-protocol$/, replacement: `${protocolSrc}index.ts` },
			{
				find: /^@hansjm10\/volt-protocol\/(entries|git-context|wire-limits|daemon-control|remote-handshake|remote-access|push|workspace|work)$/,
				replacement: `${protocolSrc}$1.ts`,
			},
			{ find: /^@hansjm10\/volt-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@hansjm10\/volt-tui$/, replacement: tuiSrcIndex },
			{ find: /^@hansjm10\/volt-coding-agent$/, replacement: codingAgentSrcIndex },
		],
	},
});
