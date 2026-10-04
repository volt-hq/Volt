import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const repoRoot = new URL("../../../", import.meta.url);
const jiti = createJiti(import.meta.url, {
	alias: {
		"@hansjm10/volt-agent-core": fileURLToPath(new URL("packages/agent/src/index.ts", repoRoot)),
		"@hansjm10/volt-ai": fileURLToPath(new URL("packages/ai/src/index.ts", repoRoot)),
		"@hansjm10/volt-ai/oauth": fileURLToPath(new URL("packages/ai/src/oauth.ts", repoRoot)),
		"@hansjm10/volt-ai/schemas": fileURLToPath(new URL("packages/ai/src/schemas.ts", repoRoot)),
		"@hansjm10/volt-protocol": fileURLToPath(new URL("packages/protocol/src/index.ts", repoRoot)),
		"@hansjm10/volt-protocol/entries": fileURLToPath(new URL("packages/protocol/src/entries.ts", repoRoot)),
		"@hansjm10/volt-protocol/git-context": fileURLToPath(new URL("packages/protocol/src/git-context.ts", repoRoot)),
		"@hansjm10/volt-protocol/wire-limits": fileURLToPath(new URL("packages/protocol/src/wire-limits.ts", repoRoot)),
		"@hansjm10/volt-protocol/daemon-control": fileURLToPath(new URL("packages/protocol/src/daemon-control.ts", repoRoot)),
		"@hansjm10/volt-protocol/remote-handshake": fileURLToPath(new URL("packages/protocol/src/remote-handshake.ts", repoRoot)),
		"@hansjm10/volt-protocol/remote-access": fileURLToPath(new URL("packages/protocol/src/remote-access.ts", repoRoot)),
		"@hansjm10/volt-protocol/push": fileURLToPath(new URL("packages/protocol/src/push.ts", repoRoot)),
		"@hansjm10/volt-protocol/workspace": fileURLToPath(new URL("packages/protocol/src/workspace.ts", repoRoot)),
		"@hansjm10/volt-protocol/work": fileURLToPath(new URL("packages/protocol/src/work.ts", repoRoot)),
		"@hansjm10/volt-tui": fileURLToPath(new URL("packages/tui/src/index.ts", repoRoot)),
	},
});

await jiti.import(fileURLToPath(new URL("packages/coding-agent/src/cli.ts", repoRoot)));
