import { Buffer } from "node:buffer";
import { loadWorkspaceFsNativeAddon } from "./workspace-fs/native-loader.ts";

/** Owner-only Windows sink; failure must never fall back to chmod-only storage. */
export async function writeWindowsReviewDiagnostic(filePath: string, content: string): Promise<void> {
	try {
		await loadWorkspaceFsNativeAddon().writeWindowsPrivateFile(filePath, Buffer.from(content, "utf8"));
	} catch {
		// Loader and filesystem errors may contain private paths or diagnostic data.
		throw new Error("Could not retain private Windows review diagnostics.");
	}
}
