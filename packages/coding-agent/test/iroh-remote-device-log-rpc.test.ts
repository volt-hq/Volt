import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RemoteCapability } from "@hansjm10/volt-protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { WorkspaceIntentError } from "../src/core/protocol/intents/types.ts";
import {
	DEFAULT_IROH_REMOTE_DEVICE_LOG_MAX_CONTENT_BYTES,
	type IrohRemoteDeviceLogUploadOptions,
	serveIrohRemoteConnection,
	uploadIrohRemoteDeviceLog,
} from "../src/core/remote/iroh/index.ts";
import { directorySymlinkType, tryCreateFileSymlink } from "./symlink-utils.ts";
import { createIrohStreamPair } from "./utilities/iroh-stream-pair.ts";
import { connectRemotePhone, type RemotePhone } from "./utilities/remote-phone.ts";

type UploadOutcome = { success: true; data: { path: string; byteCount: number } } | { success: false; error: string };

/** An upload's outcome: what it wrote, or the stable error a device is answered with. */
async function uploadOutcome(
	request: Record<string, unknown>,
	options: IrohRemoteDeviceLogUploadOptions,
): Promise<UploadOutcome> {
	try {
		return { success: true, data: await uploadIrohRemoteDeviceLog(request, options) };
	} catch (error) {
		if (error instanceof WorkspaceIntentError) return { success: false, error: error.error };
		throw error;
	}
}

describe("Iroh remote device log upload", () => {
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
		const response = await uploadOutcome(
			{ fileName: "volt-logs.log", content: "line one\nline two\n" },
			{ workspacePath },
		);

		expect(response).toEqual({
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

		const response = await uploadOutcome({ fileName: "escaped.log", content: "escape" }, { workspacePath });

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

		const response = await uploadOutcome({ fileName: "private.log", content: "private" }, { workspacePath });

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

		const response = await uploadOutcome({ fileName: "overwritten.log", content: "overwrite" }, { workspacePath });

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

		const response = await uploadOutcome({ fileName: "volt-logs.log", content: "replacement" }, { workspacePath });

		expect(response.success).toBe(true);
		expect(await readFile(referentPath, "utf8")).toBe("untouched");
		expect((await lstat(targetPath)).isSymbolicLink()).toBe(false);
		expect(await readFile(targetPath, "utf8")).toBe("replacement");
	});

	test("generates a timestamped file name when none is provided", async () => {
		const response = await uploadOutcome(
			{ content: "entry" },
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
		const command = { fileName: "volt-logs.log", content: "first" };
		await uploadOutcome(command, { workspacePath });
		const response = await uploadOutcome({ ...command, content: "second" }, { workspacePath });

		expect(response.success).toBe(true);
		const written = await readFile(join(workspacePath, ".volt", "device-logs", "volt-logs.log"), "utf8");
		expect(written).toBe("second");
	});

	test("rejects file names with path separators or leading dots", async () => {
		for (const fileName of ["../escape.log", "nested/log.log", ".hidden.log", "bad\\name.log", ""]) {
			const response = await uploadOutcome({ fileName, content: "entry" }, { workspacePath });
			expect(response.success).toBe(false);
		}
		const entries = await readdir(workspacePath);
		expect(entries).toEqual([]);
	});

	test("rejects missing, empty, or non-string content", async () => {
		for (const content of [undefined, "", 42]) {
			const response = await uploadOutcome({ content }, { workspacePath });
			expect(response.success).toBe(false);
			if (response.success === false) {
				expect(response.error).toContain('"content"');
			}
		}
	});

	test("rejects content above the size limit", async () => {
		const response = await uploadOutcome({ content: "x".repeat(11) }, { workspacePath, maxContentBytes: 10 });

		expect(response.success).toBe(false);
		if (response.success === false) {
			expect(response.error).toContain("maximum size");
		}
	});

	test("default size limit is 4 MiB", () => {
		expect(DEFAULT_IROH_REMOTE_DEVICE_LOG_MAX_CONTENT_BYTES).toBe(4 * 1024 * 1024);
	});
});

describe("upload_device_logs on a paired device's stream", () => {
	let workspacePath: string;
	const cleanups: Array<() => Promise<void>> = [];

	beforeEach(async () => {
		workspacePath = await mkdtemp(join(tmpdir(), "volt-device-log-stream-"));
	});

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
		await rm(workspacePath, { recursive: true, force: true });
	});

	/** A phone on a stream whose host writes device logs under the workspace, as a TUI serving a relayed phone does. */
	async function phone(capabilities: RemoteCapability[] = ["diagnostics.upload.v1"]): Promise<RemotePhone> {
		const pair = createIrohStreamPair();
		const connection = serveIrohRemoteConnection({
			stream: pair.host,
			grant: { schemaVersion: 1, revision: 1, capabilities },
			redaction: { workspacePath },
			services: () => ({
				workspace: {
					name: "volt",
					uploadDeviceLogs: (upload) => uploadIrohRemoteDeviceLog(upload, { workspacePath }),
				},
			}),
		});
		const device = connectRemotePhone(pair.phone);
		cleanups.push(async () => {
			await connection.close().catch(() => undefined);
			await device.close();
		});
		await device.hello();
		return device;
	}

	test("writes the log and accepts with its workspace-relative path", async () => {
		const device = await phone();
		expect(
			await device.intent("upload_device_logs", { fileName: "volt-logs.log", content: "line one\nline two\n" }),
		).toMatchObject({
			type: "accepted",
			result: { path: ".volt/device-logs/volt-logs.log", byteCount: 18 },
		});
		expect(await readFile(join(workspacePath, ".volt", "device-logs", "volt-logs.log"), "utf8")).toBe(
			"line one\nline two\n",
		);
	});

	test("rejects a refused upload with its stable error and writes nothing", async () => {
		const device = await phone();
		expect(await device.intent("upload_device_logs", { fileName: "../escape.log", content: "entry" })).toMatchObject({
			type: "rejected",
			reason: { code: "failed", message: expect.stringContaining('"fileName" must contain only') },
		});
		expect(await device.intent("upload_device_logs", { content: "" })).toMatchObject({
			type: "rejected",
			reason: { code: "failed", message: '"content" must be a non-empty string' },
		});
		expect(await device.intent("upload_device_logs", { content: 42 })).toMatchObject({
			type: "rejected",
			reason: { code: "invalid_input" },
		});
		expect(await readdir(workspacePath)).toEqual([]);
	});

	test("requires the diagnostics upload capability", async () => {
		const device = await phone(["conversation.observe.v1", "conversation.control.v1", "host.manage.v1"]);
		expect(await device.intent("upload_device_logs", { content: "entry" })).toMatchObject({
			type: "rejected",
			reason: { code: "not_allowed", requiredCapability: "diagnostics.upload.v1" },
		});
		expect(await readdir(workspacePath)).toEqual([]);
	});
});
