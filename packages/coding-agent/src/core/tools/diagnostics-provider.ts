import { extname } from "node:path";
import { languageIdForExtension } from "../lsp/config.ts";
import {
	type LspOperationMetadata,
	type LspResult,
	lspErrorResult,
	lspOperationMetadata,
	lspResult,
} from "../lsp/outcome.ts";

/**
 * Provider interface for post-mutation file diagnostics (e.g. LSP).
 *
 * Implementations receive the absolute path and the exact content that was
 * written, and return typed collection evidence with optional display text.
 * Every completed check is recorded. Implementations must not fail the mutation;
 * callers treat diagnostics as best-effort.
 */
export interface ToolDiagnosticsProvider {
	getDiagnostics(absolutePath: string, content: string, signal?: AbortSignal): Promise<LspResult>;
}

export async function collectToolDiagnostics(
	provider: ToolDiagnosticsProvider | undefined,
	absolutePath: string,
	content: string,
	trigger: "edit" | "write",
	signal?: AbortSignal,
): Promise<{ diagnostics?: string; lsp: LspOperationMetadata }> {
	const startedAt = performance.now();
	let result: LspResult;
	try {
		result = provider
			? await provider.getDiagnostics(absolutePath, content, signal)
			: lspResult("skipped", "", { reason: "disabled" });
	} catch (error) {
		result = { ...lspErrorResult(error), text: "Diagnostics unavailable; file mutation succeeded." };
	}
	result.language ??= languageIdForExtension(extname(absolutePath));
	return {
		...(result.text ? { diagnostics: result.text } : {}),
		lsp: lspOperationMetadata(result, trigger, "diagnostics", startedAt),
	};
}
