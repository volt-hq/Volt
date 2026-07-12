import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

export interface DurableAtomicWriteOperations {
	mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
	open(path: string, flags: string, mode?: number): Promise<Pick<FileHandle, "close" | "sync" | "writeFile">>;
	rename(from: string, to: string): Promise<void>;
	rm(path: string, options: { force: true }): Promise<void>;
}

const DEFAULT_OPERATIONS: DurableAtomicWriteOperations = { mkdir, open, rename, rm };

/**
 * Atomically replace a security-sensitive file and make the replacement durable
 * across power loss: fsync the temp file before rename, then fsync its parent.
 */
export async function writeDurableAtomicFile(
	path: string,
	content: string,
	options: { directoryMode?: number; fileMode?: number; operations?: DurableAtomicWriteOperations } = {},
): Promise<void> {
	const operations = options.operations ?? DEFAULT_OPERATIONS;
	const parentPath = dirname(path);
	const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	let tempHandle: Awaited<ReturnType<DurableAtomicWriteOperations["open"]>> | undefined;
	let renamed = false;

	await operations.mkdir(parentPath, { recursive: true, mode: options.directoryMode ?? 0o700 });
	try {
		tempHandle = await operations.open(tempPath, "wx", options.fileMode ?? 0o600);
		await tempHandle.writeFile(content, "utf8");
		await tempHandle.sync();
		await tempHandle.close();
		tempHandle = undefined;

		await operations.rename(tempPath, path);
		renamed = true;

		const parentHandle = await operations.open(parentPath, "r");
		try {
			await parentHandle.sync();
		} finally {
			await parentHandle.close();
		}
	} catch (error) {
		if (tempHandle) {
			await tempHandle.close().catch(() => {});
		}
		if (!renamed) {
			await operations.rm(tempPath, { force: true }).catch(() => {});
		}
		throw error;
	}
}
