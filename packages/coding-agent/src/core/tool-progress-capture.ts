import { randomUUID } from "node:crypto";
import { rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { writeDurableAtomicFile } from "../utils/durable-atomic-write.ts";
import { ensurePrivateDirectorySync } from "../utils/private-files.ts";
import { writeWindowsReviewDiagnostic } from "./windows-review-private-diagnostics.ts";

/** Write an immutable diagnostic snapshot without blocking provider or terminal callbacks. */
export async function writeToolProgressCapture(path: string, content: string): Promise<void> {
	if (process.platform === "win32") {
		const temporaryPath = `${path}.${randomUUID()}.tmp`;
		try {
			await writeWindowsReviewDiagnostic(temporaryPath, content);
			await rename(temporaryPath, path);
		} finally {
			await rm(temporaryPath, { force: true });
		}
	} else {
		ensurePrivateDirectorySync(dirname(path));
		await writeDurableAtomicFile(path, content);
	}
}
