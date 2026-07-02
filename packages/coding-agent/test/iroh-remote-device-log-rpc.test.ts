import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	DEFAULT_IROH_REMOTE_DEVICE_LOG_MAX_CONTENT_BYTES,
	handleIrohRemoteDeviceLogUploadRpcCommand,
} from "../src/core/remote/iroh/index.ts";

describe("Iroh remote device log upload RPC", () => {
	let workspacePath: string;

	beforeEach(async () => {
		workspacePath = await mkdtemp(join(tmpdir(), "volt-device-log-test-"));
	});

	afterEach(async () => {
		await rm(workspacePath, { recursive: true, force: true });
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
		const written = await readFile(join(workspacePath, ".volt", "device-logs", "volt-logs.log"), "utf8");
		expect(written).toBe("line one\nline two\n");
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
