#!/usr/bin/env node
// Offline /lsp visual fixture. No AgentSession, credentials, server, or daemon is created.
// node scripts/lsp-ui-fixture.mjs healthy|degraded|error|idle [dark|light]
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { tsconfigPaths: resolve(root, "tsconfig.json") });
const { Container, Editor, ProcessTerminal, ScrollView, Text, TuiAltScreen, VStack } = await jiti.import("@hansjm10/volt-tui");
const { initTheme, getEditorTheme } = await jiti.import(resolve(root, "packages/coding-agent/src/core/theme/runtime.ts"));
const { InteractiveMode } = await jiti.import(resolve(root, "packages/coding-agent/src/modes/interactive/interactive-mode.ts"));
const { FooterComponent } = await jiti.import(resolve(root, "packages/coding-agent/src/modes/interactive/components/footer.ts"));

const { ToolExecutionComponent } = await jiti.import(resolve(root, "packages/coding-agent/src/modes/interactive/components/tool-execution.ts"));
const { lspResult, lspOperationMetadata } = await jiti.import(resolve(root, "packages/coding-agent/src/core/lsp/outcome.ts"));
const state = process.argv[2] ?? "healthy";
if (!["healthy", "degraded", "error", "idle", "cards"].includes(state)) throw new Error(`Unknown fixture: ${state}`);
initTheme(process.argv[3] ?? "dark", true);
const workspaceRoot = "/workspace/volt";
const server = {
	name: "typescript", workspaceRoot, root: workspaceRoot,
	alive: state === "healthy" || state === "degraded", openDocuments: state === "idle" || state === "error" ? 0 : 2,
	idleMs: 3200, resolvedExecutable: "/opt/toolchain/bin/tsc", launchSource: "path", attempts: state === "error" ? 3 : 1,
	state: { healthy: "ready", degraded: "degraded", error: "blocked", idle: "idle" }[state],
	version: "7.0.2", serverInfo: { name: "TypeScript", version: "7.0.2" },
	capabilities: state === "idle" || state === "error" ? undefined : ["definitionProvider", "referencesProvider", "hoverProvider"],
	breaker: state === "error" ? "open" : "closed", operations: 12, failures: state === "healthy" || state === "idle" ? 0 : 1,
	totalDurationMs: 620, lastDurationMs: 24, lastSuccess: "2026-09-14T12:00:00.000Z",
	...(state === "degraded" ? { requestError: "Request timed out; diagnostics not verified.", lastFailure: "2026-09-14T12:00:03.000Z" } : {}),
	...(state === "error" ? { lastError: "Server exited during initialize; repair the configured executable.", startupStderr: "Missing optional native binding.", lastFailure: "2026-09-14T12:00:03.000Z" } : {}),
};
const tui = new TuiAltScreen(new ProcessTerminal());
const chatContainer = new Container();
if (state === "cards") {
	for (const [label, action, outcome, text, freshness, source] of [
		["healthy", "diagnostics", "empty", "No diagnostics in src/main.ts.", "fresh", "pull"],
		["degraded", "diagnostics", "empty", "No diagnostics reported (best-effort, unversioned publication).", "unverified", "push"],
		["error", "definition", "unavailable", "TypeScript 6.0.2 is incompatible. Native LSP requires >=7; use /lsp to inspect repair options.", "unknown", "none"],
		["idle", "status", "success", "typescript: idle; next supported query starts the server lazily.", "unknown", "none"],
	]) {
		const result = lspResult(outcome, text, { freshness, source });
		const card = new ToolExecutionComponent("lsp", label, { action, path: "src/main.ts" }, {}, undefined, tui, workspaceRoot);
		card.setArgsComplete();
		card.updateResult({ content: [{ type: "text", text }], details: { action, lsp: lspOperationMetadata(result, "explicit", action, performance.now()) }, isError: outcome === "unavailable" });
		chatContainer.addChild(card);
	}
} else {
	await InteractiveMode.prototype.handleLspCommand.call({
		session: { getLspStatus: () => ({ enabled: true, workspaceRoot, servers: [server] }) },
		chatContainer, ui: tui,
	});
}
const editor = new Editor(tui, getEditorTheme());
const footer = new FooterComponent({
	state: { model: { id: "fixture-model", provider: "offline", reasoning: true, contextWindow: 200000 }, thinkingLevel: "off" },
	sessionManager: { getEntries: () => [], getCwd: () => workspaceRoot, getSessionName: () => undefined },
	getContextUsage: () => undefined, settingsManager: { getContextWarningTokens: () => 0 },
	modelRegistry: { isUsingOAuth: () => false },
}, { getGitBranch: () => "feat/first-class-lsp", getAvailableProviderCount: () => 1, getExtensionStatuses: () => new Map() });
tui.setLayoutRoot(new VStack([
	{ component: new ScrollView(chatContainer, { follow: "start", primary: true }), basis: 0, grow: 1, minSize: 1 },
	{ component: new VStack([new Text(`Offline fixture: ${state}`, 1, 0), editor, footer]), basis: "auto" },
]));
tui.setFocus(editor);
tui.start();
process.on("SIGTERM", () => { tui.stop({ preserveScreen: true }); process.exit(0); });
