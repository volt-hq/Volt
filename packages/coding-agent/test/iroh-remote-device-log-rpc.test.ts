import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	DEFAULT_IROH_REMOTE_DEVICE_LOG_MAX_CONTENT_BYTES,
	handleIrohRemoteDeviceLogUploadRpcCommand,
} from "../src/core/remote/iroh/index.ts";
import { directorySymlinkType, tryCreateFileSymlink } from "./symlink-utils.ts";

describe("Iroh remote device log upload RPC", () => {
	let workspacePath: string;
	let outsidePath: string;

	beforeEach(async () => {
		workspacePath = await mkdtemp(join(tmpdir(), "volt-device-log-test-"));
		outsidePath = await mkdtemp(join(tmpdir(), "volt-device-log-outside-"));
	});

	afterEach(async () => {
		await rm(workspacePath, { recursive: true, force: true });
		await rm(outsidePath, { recursive: true, force: true });
	});

	test("writes the log under .volt/device-logs and reports the relative path", async () => {
		const response = await handleIrohRemoteDeviceLogUploadRpcCommand(
			{ id: "req-1", type: "upload_device_logs", fileName: "volt-logs.log", content: "line one\nline two\n" },
			{ workspacePath },
		);

		expect(response).toEqual({
			id: "req-1",
			type: "response",
			command: "upload_device_logs",
			success: true,
			data: { path: ".volt/device-logs/volt-logs.log", byteCount: 18 },
		});
		const logPath = join(workspacePath, ".volt", "device-logs", "volt-logs.log");
		const written = await readFile(logPath, "utf8");
		expect(written).toBe("line one\nline two\n");
		if (process.platform !== "win32") {
			expect((await stat(logPath)).mode & 0o777).toBe(0o600);
		}
	});

	test("rejects an outside-root .volt symlink without writing through it", async () => {
		await symlink(outsidePath, join(workspacePath, ".volt"), directorySymlinkType());

		const response = await handleIrohRemoteDeviceLogUploadRpcCommand(
			{ id: "req-outside", type: "upload_device_logs", fileName: "escaped.log", content: "escape" },
			{ workspacePath },
		);

		expect(response.success).toBe(false);
		if (response.success === false) {
			expect(response.error).toContain(".volt directory must not be a symbolic link");
		}
		expect(await readdir(outsidePath)).toEqual([]);
	});

	test("hardens pre-existing device-log directories to owner-only permissions", async () => {
		const voltDirectory = join(workspacePath, ".volt");
		const logDirectory = join(voltDirectory, "device-logs");
		await mkdir(logDirectory, { recursive: true });
		if (process.platform !== "win32") {
			await chmod(voltDirectory, 0o777);
			await chmod(logDirectory, 0o777);
		}

		const response = await handleIrohRemoteDeviceLogUploadRpcCommand(
			{ id: "req-mode", type: "upload_device_logs", fileName: "private.log", content: "private" },
			{ workspacePath },
		);

		expect(response.success).toBe(true);
		if (process.platform !== "win32") {
			expect((await stat(voltDirectory)).mode & 0o777).toBe(0o700);
			expect((await stat(logDirectory)).mode & 0o777).toBe(0o700);
		}
	});

	test("rejects an in-workspace device-logs symlink without overwriting its target", async () => {
		const redirectedPath = join(workspacePath, "redirected-logs");
		await mkdir(join(workspacePath, ".volt"));
		await mkdir(redirectedPath);
		await symlink(redirectedPath, join(workspacePath, ".volt", "device-logs"), directorySymlinkType());

		const response = await handleIrohRemoteDeviceLogUploadRpcCommand(
			{ id: "req-inside", type: "upload_device_logs", fileName: "overwritten.log", content: "overwrite" },
			{ workspacePath },
		);

		expect(response.success).toBe(false);
		if (response.success === false) {
			expect(response.error).toContain("device-logs directory must not be a symbolic link");
		}
		expect(await readdir(redirectedPath)).toEqual([]);
	});

	test("replaces a final-file symlink without following or overwriting its referent", async () => {
		const directory = join(workspacePath, ".volt", "device-logs");
		const targetPath = join(directory, "volt-logs.log");
		const referentPath = join(outsidePath, "referent.log");
		await mkdir(directory, { recursive: true });
		await writeFile(referentPath, "untouched", "utf8");
		if (!(await tryCreateFileSymlink(referentPath, targetPath))) {
			return;
		}

		const response = await handleIrohRemoteDeviceLogUploadRpcCommand(
			{ id: "req-final", type: "upload_device_logs", fileName: "volt-logs.log", content: "replacement" },
			{ workspacePath },
		);

		expect(response.success).toBe(true);
		expect(await readFile(referentPath, "utf8")).toBe("untouched");
		expect((await lstat(targetPath)).isSymbolicLink()).toBe(false);
		expect(await readFile(targetPath, "utf8")).toBe("replacement");
	});

	test("generates a timestamped file name when none is provided", async () => {
		const response = await handleIrohRemoteDeviceLogUploadRpcCommand(
			{ id: "req-2", type: "upload_device_logs", content: "entry" },
			{ workspacePath, now: () => new Date("2026-07-02T10:20:30.123Z") },
		);

		expect(response.success).toBe(true);
		if (response.success !== true) {
			return;
		}
		expect(response.data.path).toBe(".volt/device-logs/device-2026-07-02T10-20-30Z.log");
		const entries = await readdir(join(workspacePath, ".volt", "device-logs"));
		expect(entries).toEqual(["device-2026-07-02T10-20-30Z.log"]);
	});

	test("overwrites an existing log with the same file name", async () => {
		const command = { id: "req-3", type: "upload_device_logs", fileName: "volt-logs.log", content: "first" };
		await handleIrohRemoteDeviceLogUploadRpcCommand(command, { workspacePath });
		const response = await handleIrohRemoteDeviceLogUploadRpcCommand(
			{ ...command, content: "second" },
			{ workspacePath },
		);

		expect(response.success).toBe(true);
		const written = await readFile(join(workspacePath, ".volt", "device-logs", "volt-logs.log"), "utf8");
		expect(written).toBe("second");
	});

	test("rejects file names with path separators or leading dots", async () => {
		for (const fileName of ["../escape.log", "nested/log.log", ".hidden.log", "bad\\name.log", ""]) {
			const response = await handleIrohRemoteDeviceLogUploadRpcCommand(
				{ id: "req-4", type: "upload_device_logs", fileName, content: "entry" },
				{ workspacePath },
			);
			expect(response.success).toBe(false);
		}
		const entries = await readdir(workspacePath);
		expect(entries).toEqual([]);
	});

	test("rejects missing, empty, or non-string content", async () => {
		for (const content of [undefined, "", 42]) {
			const response = await handleIrohRemoteDeviceLogUploadRpcCommand(
				{ id: "req-5", type: "upload_device_logs", content },
				{ workspacePath },
			);
			expect(response.success).toBe(false);
			if (response.success === false) {
				expect(response.error).toContain('"content"');
			}
		}
	});

	test("rejects content above the size limit", async () => {
		const response = await handleIrohRemoteDeviceLogUploadRpcCommand(
			{ id: "req-6", type: "upload_device_logs", content: "x".repeat(11) },
			{ workspacePath, maxContentBytes: 10 },
		);

		expect(response.success).toBe(false);
		if (response.success === false) {
			expect(response.error).toContain("maximum size");
		}
	});

	test("default size limit is 4 MiB", () => {
		expect(DEFAULT_IROH_REMOTE_DEVICE_LOG_MAX_CONTENT_BYTES).toBe(4 * 1024 * 1024);
	});
});
