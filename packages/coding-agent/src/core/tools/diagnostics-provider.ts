/**
 * Provider interface for post-mutation file diagnostics (e.g. LSP).
 *
 * Implementations receive the absolute path and the exact content that was
 * written, and return formatted diagnostics text, or undefined when there is
 * nothing to report. Implementations must not throw to fail the mutation;
 * callers treat diagnostics as best-effort.
 */
export interface ToolDiagnosticsProvider {
	getDiagnostics(absolutePath: string, content: string, signal?: AbortSignal): Promise<string | undefined>;
}
