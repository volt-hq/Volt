/**
 * LSP protocol tracing.
 *
 * Appends timestamped JSON-RPC traffic, server stderr, and lifecycle events
 * to a log file. The file handle is opened once and kept open (per-line
 * open/append/close is prohibitively slow under antivirus scanning). Writes
 * are serialized and best-effort: tracing must never affect the operations
 * it observes.
 */

import { closeSync, constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { PRIVATE_FILE_MODE } from "../../utils/private-files.ts";

export type LspTraceDirection = "send" | "recv" | "stderr" | "info";

/** Cap per-entry payload size so didOpen/didChange of large files stay readable. */
const MAX_ENTRY_LENGTH = 4000;

export class LspTracer {
	readonly filePath: string;
	private handle: FileHandle | undefined;
	private failed = false;
	private accepting = true;
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(filePath: string) {
		this.filePath = filePath;
	}

	log(serverName: string, direction: LspTraceDirection, text: string): void {
		if (!this.accepting) {
			return;
		}
		let payload = text.replace(/\r?\n$/, "");
		if (payload.length > MAX_ENTRY_LENGTH) {
			payload = `${payload.slice(0, MAX_ENTRY_LENGTH)}... (${payload.length - MAX_ENTRY_LENGTH} more chars)`;
		}
		const line = `${new Date().toISOString()} [${serverName}] ${direction}: ${payload}\n`;
		this.writeQueue = this.writeQueue.then(async () => {
			if (this.failed) {
				return;
			}
			try {
				if (!this.handle) {
					const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
					const handle = await open(
						this.filePath,
						constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | noFollow,
						PRIVATE_FILE_MODE,
					);
					try {
						const stat = await handle.stat();
						if (!stat.isFile() || stat.nlink !== 1) {
							throw new Error(`Refusing to trace to linked or non-regular file: ${this.filePath}`);
						}
						await handle.chmod(PRIVATE_FILE_MODE);
						this.handle = handle;
					} catch (error) {
						await handle.close().catch(() => {});
						throw error;
					}
				}
				await this.handle.write(line);
			} catch {
				// Tracing is best-effort; disable on the first write failure
				// (e.g. unwritable path) instead of retrying every entry.
				this.failed = true;
			}
		});
	}

	/** Wait for queued writes to land (used by tests). */
	flush(): Promise<void> {
		return this.writeQueue;
	}

	/** Close the trace file after pending writes complete. */
	dispose(): Promise<void> {
		this.accepting = false;
		this.writeQueue = this.writeQueue
			.then(async () => {
				await this.handle?.close();
				this.handle = undefined;
				this.failed = true;
			})
			.catch(() => {
				this.handle = undefined;
				this.failed = true;
			});
		return this.writeQueue;
	}

	/** Best-effort emergency close for synchronous process teardown paths. */
	disposeSync(): void {
		this.accepting = false;
		this.failed = true;
		const handle = this.handle;
		this.handle = undefined;
		if (handle) {
			try {
				closeSync(handle.fd);
			} catch {
				// The handle may already have closed through the queued async path.
			}
		}
	}
}
