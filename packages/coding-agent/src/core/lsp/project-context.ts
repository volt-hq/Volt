import { statSync } from "node:fs";
import { join } from "node:path";
import type { LspProjectContext } from "./outcome.ts";

/** Inspect only the actual canonical server root. No build, probe, or server request. */
export function swiftProjectContext(root: string): LspProjectContext {
	try {
		if (!statSync(root).isDirectory()) return "unknown";
		for (const [marker, context] of [
			["buildServer.json", "build-server-detected"],
			["Package.swift", "swiftpm-detected"],
		] as const) {
			try {
				if (statSync(join(root, marker)).isFile()) return context;
			} catch (error) {
				if (
					!(
						typeof error === "object" &&
						error !== null &&
						"code" in error &&
						(error.code === "ENOENT" || error.code === "ENOTDIR")
					)
				)
					return "unknown";
			}
		}
		return "not-detected";
	} catch {
		return "unknown";
	}
}

export function swiftContextCaveat(context: LspProjectContext): string {
	const evidence =
		context === "build-server-detected"
			? "buildServer.json detected"
			: context === "swiftpm-detected"
				? "Package.swift detected"
				: context === "not-detected"
					? "No Swift project context detected"
					: "Swift project context inspection unavailable";
	return `${evidence}; filesystem evidence does not verify active build settings or complete indexing. ${context === "not-detected" || context === "unknown" ? "Diagnostics are best-effort. For Xcode, configure a build server manually; for SwiftPM, use the package root. " : "Module/reference coverage may require a recent build. "}After changing project configuration, use /lsp restart or /reload to reconfigure the server.`;
}
