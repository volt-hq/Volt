import type { SpawnSyncReturns } from "child_process";
import { existsSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => {
	return {
		spawnSync: vi.fn<(command: string, args: string[], options: unknown) => SpawnSyncReturns<Buffer>>(),
		readClipboardImages: vi.fn<() => Promise<string[]>>(),
	};
});

vi.mock("child_process", () => {
	return {
		spawnSync: mocks.spawnSync,
	};
});

vi.mock("clipboard-image", () => {
	return {
		readClipboardImages: mocks.readClipboardImages,
	};
});

function spawnOk(stdout: Buffer): SpawnSyncReturns<Buffer> {
	return {
		pid: 123,
		output: [Buffer.alloc(0), stdout, Buffer.alloc(0)],
		stdout,
		stderr: Buffer.alloc(0),
		status: 0,
		signal: null,
	};
}

function spawnError(error: Error): SpawnSyncReturns<Buffer> {
	return {
		pid: 123,
		output: [Buffer.alloc(0), Buffer.alloc(0), Buffer.alloc(0)],
		stdout: Buffer.alloc(0),
		stderr: Buffer.alloc(0),
		status: null,
		signal: null,
		error,
	};
}

describe("readClipboardImage", () => {
	beforeEach(() => {
		vi.resetModules();
		mocks.spawnSync.mockReset();
		mocks.readClipboardImages.mockReset();
	});

	test("Wayland: uses wl-paste", async () => {
		mocks.spawnSync.mockImplementation((command, args, _options) => {
			if (command === "wl-paste" && args[0] === "--list-types") {
				return spawnOk(Buffer.from("text/plain\nimage/png\n", "utf-8"));
			}
			if (command === "wl-paste" && args[0] === "--type") {
				return spawnOk(Buffer.from([1, 2, 3]));
			}
			throw new Error(`Unexpected spawnSync call: ${command} ${args.join(" ")}`);
		});

		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
		const result = await readClipboardImage({ platform: "linux", env: { WAYLAND_DISPLAY: "1" } });
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("image/png");
		expect(Array.from(result?.bytes ?? [])).toEqual([1, 2, 3]);
	});

	test("Wayland: falls back to xclip when wl-paste is missing", async () => {
		const enoent = new Error("spawn ENOENT");
		(enoent as { code?: string }).code = "ENOENT";

		mocks.spawnSync.mockImplementation((command, args, _options) => {
			if (command === "wl-paste") {
				return spawnError(enoent);
			}

			if (command === "xclip" && args.includes("TARGETS")) {
				return spawnOk(Buffer.from("image/png\n", "utf-8"));
			}

			if (command === "xclip" && args.includes("image/png")) {
				return spawnOk(Buffer.from([9, 8]));
			}

			return spawnOk(Buffer.alloc(0));
		});

		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
		const result = await readClipboardImage({ platform: "linux", env: { XDG_SESSION_TYPE: "wayland" } });
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("image/png");
		expect(Array.from(result?.bytes ?? [])).toEqual([9, 8]);
	});

	test("WSL: passes PowerShell path directly instead of through a custom env var", async () => {
		let tmpFile: string | undefined;
		mocks.spawnSync.mockImplementation((command, args, options) => {
			if (command === "wl-paste" || command === "xclip") {
				return spawnOk(Buffer.alloc(0));
			}

			if (command === "wslpath") {
				tmpFile = args[1];
				return spawnOk(Buffer.from("C:\\Users\\O'Hare\\clip.png\n", "utf-8"));
			}

			if (command === "powershell.exe") {
				const spawnOptions = options as { env?: NodeJS.ProcessEnv };
				expect(spawnOptions.env?.VOLT_WSL_CLIPBOARD_IMAGE_PATH).toBeUndefined();
				expect(args[2]).toContain("$path = 'C:\\Users\\O''Hare\\clip.png'");
				if (!tmpFile) {
					throw new Error("wslpath should be called before powershell.exe");
				}
				writeFileSync(tmpFile, Buffer.from([4, 5, 6]));
				return spawnOk(Buffer.from("ok\n", "utf-8"));
			}

			throw new Error(`Unexpected spawnSync call: ${command} ${args.join(" ")}`);
		});

		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
		const result = await readClipboardImage({ platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" } });
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("image/png");
		expect(Array.from(result?.bytes ?? [])).toEqual([4, 5, 6]);
	});

	test("X11: uses xclip", async () => {
		mocks.spawnSync.mockImplementation((command, args) => {
			if (command === "xclip" && args.includes("TARGETS")) {
				return spawnOk(Buffer.from("image/png\n", "utf-8"));
			}
			if (command === "xclip" && args.includes("image/png")) {
				return spawnOk(Buffer.from([7]));
			}
			throw new Error(`Unexpected spawnSync call: ${command} ${args.join(" ")}`);
		});

		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
		const result = await readClipboardImage({ platform: "linux", env: { DISPLAY: ":0" } });
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("image/png");
		expect(Array.from(result?.bytes ?? [])).toEqual([7]);
	});

	test("Linux: returns null when clipboard tools have no image", async () => {
		mocks.spawnSync.mockImplementation(() => spawnOk(Buffer.alloc(0)));

		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
		const result = await readClipboardImage({ platform: "linux", env: {} });
		expect(result).toBeNull();
	});

	test("macOS: reads the first PNG and removes the package temporary directory", async () => {
		const directory = mkdtempSync(join(tmpdir(), "volt-clipboard-image-test-"));
		const imagePath = join(directory, "clipboard-image-0.png");
		writeFileSync(imagePath, Buffer.from([1, 3, 5]));
		mocks.readClipboardImages.mockResolvedValue([imagePath]);

		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
		const result = await readClipboardImage({ platform: "darwin", env: {} });
		expect(Array.from(result?.bytes ?? [])).toEqual([1, 3, 5]);
		expect(result?.mimeType).toBe("image/png");
		expect(existsSync(directory)).toBe(false);
	});

	test("Windows: reads PNG via PowerShell without WSL path translation", async () => {
		let tmpFile: string | undefined;
		mocks.spawnSync.mockImplementation((command, args) => {
			expect(command).toBe("powershell.exe");
			expect(args[2]).toContain("$path = '");
			const match = args[2]?.match(/\$path = '([^']+)'/);
			tmpFile = match?.[1];
			if (!tmpFile) {
				throw new Error("PowerShell output path was not present");
			}
			writeFileSync(tmpFile, Buffer.from([2, 4, 6]));
			return spawnOk(Buffer.from("ok\n", "utf-8"));
		});

		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
		const result = await readClipboardImage({ platform: "win32", env: {} });
		expect(Array.from(result?.bytes ?? [])).toEqual([2, 4, 6]);
		expect(result?.mimeType).toBe("image/png");
		expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
	});
});
