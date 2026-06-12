export { LspClient, type LspClientOptions, type LspDiagnostic } from "./client.ts";
export {
	type LspServerSettings,
	type LspSettings,
	type LspSeverity,
	languageIdForExtension,
	type ResolvedLspConfig,
	type ResolvedLspServerConfig,
	resolveLspConfig,
} from "./config.ts";
export { LspManager, type LspManagerOptions, type LspServerStatus } from "./manager.ts";
export {
	applyTextEdits,
	type LspTextEdit,
	type LspWorkspaceEdit,
	type NormalizedWorkspaceOperation,
	normalizeWorkspaceEdit,
} from "./workspace-edit.ts";
