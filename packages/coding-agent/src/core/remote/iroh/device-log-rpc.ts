import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createIrohRemoteRpcErrorResponse, type IrohRemoteRpcErrorResponse } from "./rpc-command-filter.ts";

export const IROH_REMOTE_UPLOAD_DEVICE_LOGS_RPC_TYPE = "upload_device_logs";

export const IROH_REMOTE_DEVICE_LOGS_DIR_SEGMENTS = [".volt", "device-logs"] as const;

export const DEFAULT_IROH_REMOTE_DEVICE_LOG_MAX_CONTENT_BYTES = 4 * 1024 * 1024;

const DEVICE_LOG_FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface IrohRemoteDeviceLogUploadRpcData {
	path: string;
	byteCount: number;
}

export type IrohRemoteDeviceLogUploadRpcResponse =
	| {
			id?: string;
			type: "response";
			command: typeof IROH_REMOTE_UPLOAD_DEVICE_LOGS_RPC_TYPE;
			success: true;
			data: IrohRemoteDeviceLogUploadRpcData;
	  }
	| IrohRemoteRpcErrorResponse;

export interface HandleIrohRemoteDeviceLogUploadRpcCommandOptions {
	workspacePath: string;
	maxContentBytes?: number;
	now?: () => Date;
}

export async function handleIrohRemoteDeviceLogUploadRpcCommand(
	command: Record<string, unknown>,
	options: HandleIrohRemoteDeviceLogUploadRpcCommandOptions,
): Promise<IrohRemoteDeviceLogUploadRpcResponse> {
	const id = typeof command.id === "string" ? command.id : undefined;
	const request = parseIrohRemoteDeviceLogUploadCommand(command, options);
	if (!request.ok) {
		return createIrohRemoteRpcErrorResponse(id, IROH_REMOTE_UPLOAD_DEVICE_LOGS_RPC_TYPE, request.error);
	}

	const directory = join(options.workspacePath, ...IROH_REMOTE_DEVICE_LOGS_DIR_SEGMENTS);
	const targetPath = join(directory, request.fileName);
	const tempPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await mkdir(directory, { recursive: true });
		await writeFile(tempPath, request.content, "utf8");
		await rename(tempPath, targetPath);
	} catch (error: unknown) {
		return createIrohRemoteRpcErrorResponse(
			id,
			IROH_REMOTE_UPLOAD_DEVICE_LOGS_RPC_TYPE,
			`Failed to write device log: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	return {
		id,
		type: "response",
		command: IROH_REMOTE_UPLOAD_DEVICE_LOGS_RPC_TYPE,
		success: true,
		data: {
			path: [...IROH_REMOTE_DEVICE_LOGS_DIR_SEGMENTS, request.fileName].join("/"),
			byteCount: request.byteCount,
		},
	};
}

function parseIrohRemoteDeviceLogUploadCommand(
	command: Record<string, unknown>,
	options: HandleIrohRemoteDeviceLogUploadRpcCommandOptions,
): { ok: true; fileName: string; content: string; byteCount: number } | { ok: false; error: string } {
	if (typeof command.content !== "string" || command.content.length === 0) {
		return { ok: false, error: 'Invalid RPC command payload: "content" must be a non-empty string' };
	}
	const byteCount = Buffer.byteLength(command.content, "utf8");
	const maxContentBytes = options.maxContentBytes ?? DEFAULT_IROH_REMOTE_DEVICE_LOG_MAX_CONTENT_BYTES;
	if (byteCount > maxContentBytes) {
		return { ok: false, error: `Device log content exceeds maximum size of ${maxContentBytes} bytes` };
	}
	if (command.fileName === undefined) {
		const timestamp = (options.now?.() ?? new Date())
			.toISOString()
			.replaceAll(":", "-")
			.replace(/\.\d+Z$/, "Z");
		return { ok: true, fileName: `device-${timestamp}.log`, content: command.content, byteCount };
	}
	if (typeof command.fileName !== "string" || !DEVICE_LOG_FILE_NAME_PATTERN.test(command.fileName)) {
		return {
			ok: false,
			error: 'Invalid RPC command payload: "fileName" must contain only letters, digits, ".", "_", or "-" and must not start with "."',
		};
	}
	return { ok: true, fileName: command.fileName, content: command.content, byteCount };
}
