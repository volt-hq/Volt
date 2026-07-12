import { Buffer } from "node:buffer";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { writeDurableAtomicFile } from "../../../utils/durable-atomic-write.ts";
import { createIrohRemoteRpcErrorResponse, type IrohRemoteRpcErrorResponse } from "./rpc-command-filter.ts";

export const IROH_REMOTE_UPLOAD_DEVICE_LOGS_RPC_TYPE = "upload_device_logs";

export const IROH_REMOTE_DEVICE_LOGS_DIR_SEGMENTS = [".volt", "device-logs"] as const;

export const DEFAULT_IROH_REMOTE_DEVICE_LOG_MAX_CONTENT_BYTES = 4 * 1024 * 1024;

const DEVICE_LOG_FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEVICE_LOG_DIRECTORY_MODE = 0o700;
const DEVICE_LOG_FILE_MODE = 0o600;

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

	try {
		const directory = await resolveSafeDeviceLogDirectory(options.workspacePath);
		const targetPath = join(directory, request.fileName);
		await writeDurableAtomicFile(targetPath, request.content, {
			directoryMode: DEVICE_LOG_DIRECTORY_MODE,
			fileMode: DEVICE_LOG_FILE_MODE,
		});
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

async function resolveSafeDeviceLogDirectory(workspacePath: string): Promise<string> {
	const workspaceRoot = await realpath(workspacePath);
	await assertRealDirectory(workspaceRoot, "workspace");

	let parent = workspaceRoot;
	const verifiedComponents: Array<{ canonicalPath: string; label: string; parentPath: string; path: string }> = [];
	for (const segment of IROH_REMOTE_DEVICE_LOGS_DIR_SEGMENTS) {
		const candidate = join(parent, segment);
		await ensureRealDirectory(candidate, segment);
		const canonicalCandidate = await realpath(candidate);

		// Recheck after realpath so swapping an existing directory for a symlink
		// during validation is caught before any client content is written.
		await assertRealDirectory(candidate, segment);
		if (canonicalCandidate === parent || !isPathInside(parent, canonicalCandidate)) {
			throw new Error(`${segment} directory escapes its verified parent`);
		}
		verifiedComponents.push({
			canonicalPath: canonicalCandidate,
			label: segment,
			parentPath: parent,
			path: candidate,
		});
		parent = canonicalCandidate;
	}

	if (!isPathInside(workspaceRoot, parent)) {
		throw new Error("device log directory escapes the workspace");
	}
	// Node does not expose portable openat/renameat APIs tied to a verified
	// directory fd. Rechecking each component immediately before the atomic
	// write rejects stable swaps and narrows the residual same-user race window.
	for (const component of verifiedComponents) {
		await hardenRealDirectory(component.path, component.label);
		const currentCanonicalPath = await realpath(component.path);
		if (
			currentCanonicalPath !== component.canonicalPath ||
			currentCanonicalPath === component.parentPath ||
			!isPathInside(component.parentPath, currentCanonicalPath)
		) {
			throw new Error(`${component.label} directory changed during validation`);
		}
	}
	return parent;
}

async function hardenRealDirectory(path: string, label: string): Promise<void> {
	await assertRealDirectory(path, label);
	await chmod(path, DEVICE_LOG_DIRECTORY_MODE);
	const info = await assertRealDirectory(path, label);
	if (process.platform !== "win32" && (info.mode & 0o777) !== DEVICE_LOG_DIRECTORY_MODE) {
		throw new Error(`${label} directory must use owner-only permissions`);
	}
}

async function ensureRealDirectory(path: string, label: string): Promise<void> {
	try {
		await assertRealDirectory(path, label);
		return;
	} catch (error) {
		if (!isErrnoException(error, "ENOENT")) {
			throw error;
		}
	}

	try {
		await mkdir(path, { mode: DEVICE_LOG_DIRECTORY_MODE });
	} catch (error) {
		// Another upload may have created the directory after our lstat. Validate
		// the winning entry below; anything other than that race is a real failure.
		if (!isErrnoException(error, "EEXIST")) {
			throw error;
		}
	}
	await assertRealDirectory(path, label);
}

async function assertRealDirectory(path: string, label: string): Promise<Stats> {
	const info = await lstat(path);
	if (info.isSymbolicLink()) {
		throw new Error(`${label} directory must not be a symbolic link`);
	}
	if (!info.isDirectory()) {
		throw new Error(`${label} path must be a directory`);
	}
	return info;
}

function isPathInside(root: string, candidate: string): boolean {
	const relativePath = relative(root, candidate);
	return (
		relativePath === "" ||
		(relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
	);
}

function isErrnoException(error: unknown, code: string): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
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
