import { Buffer } from "node:buffer";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeWindowsReviewDiagnostic } from "../src/core/windows-review-private-diagnostics.ts";

const nativeMocks = vi.hoisted(() => ({
	write: vi.fn<(path: string, content: Buffer) => Promise<void>>(),
	load: vi.fn(),
}));
vi.mock("../src/core/workspace-fs/native-loader.ts", () => ({
	loadWorkspaceFsNativeAddon: nativeMocks.load,
}));

afterEach(() => {
	vi.restoreAllMocks();
	nativeMocks.write.mockReset();
	nativeMocks.load.mockReset();
});

describe("Windows native diagnostic failure containment", () => {
	it.each(["native load failure", "private file creation failure"])(
		"sanitizes %s without a fallback write",
		async (failure) => {
			const root = mkdtempSync(join(tmpdir(), "volt-native-diagnostic-error-"));
			const path = join(root, "private-path-marker.jsonl");
			const content = "private-content-marker";
			const error = new Error(`${path}: ${content}`);
			if (failure === "native load failure")
				nativeMocks.load.mockImplementation(() => {
					throw error;
				});
			else {
				nativeMocks.load.mockReturnValue({ writeWindowsPrivateFile: nativeMocks.write });
				nativeMocks.write.mockRejectedValue(error);
			}
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				await expect(writeWindowsReviewDiagnostic(path, content)).rejects.toThrow(
					/^Could not retain private Windows review diagnostics\.$/,
				);
				expect(existsSync(path)).toBe(false);
				expect(warn).not.toHaveBeenCalled();
				expect(nativeMocks.write).toHaveBeenCalledTimes(failure === "native load failure" ? 0 : 1);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	);

	it("waits for the native write and passes literal UTF-8 content", async () => {
		let finish = () => {};
		nativeMocks.load.mockReturnValue({ writeWindowsPrivateFile: nativeMocks.write });
		nativeMocks.write.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		const path = join(tmpdir(), "private '$(); 界", "capture.jsonl");
		const content = '$(throw \'not executable\'); 界\r\n{"capture":"private"}\n';
		let completed = false;
		const write = writeWindowsReviewDiagnostic(path, content).then(() => {
			completed = true;
		});
		await Promise.resolve();
		expect(completed).toBe(false);
		expect(nativeMocks.write).toHaveBeenCalledExactlyOnceWith(path, Buffer.from(content, "utf8"));
		finish();
		await write;
		expect(completed).toBe(true);
	});
});
