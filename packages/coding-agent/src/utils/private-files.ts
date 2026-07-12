import {
	chmodSync,
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

function assertPrivateRegularFile(stat: ReturnType<typeof fstatSync>, filePath: string): void {
	if (!stat.isFile()) {
		throw new Error(`Refusing to use non-regular private file: ${filePath}`);
	}
	if (stat.nlink !== 1) {
		throw new Error(`Refusing to use multiply-linked private file: ${filePath}`);
	}
}

/**
 * Create a directory if needed, reject a symlink leaf, and make it owner-only.
 *
 * Set `hardenExisting` to false for a caller-provided parent directory. This
 * still creates a missing leaf privately without unexpectedly chmodding a
 * shared directory such as the process temp root.
 */
export function ensurePrivateDirectorySync(directoryPath: string, options: { hardenExisting?: boolean } = {}): void {
	let existed = true;
	try {
		lstatSync(directoryPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		existed = false;
	}
	mkdirSync(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
	const stat = lstatSync(directoryPath);
	if (stat.isSymbolicLink() || !stat.isDirectory()) {
		throw new Error(`Refusing to use non-directory private path: ${directoryPath}`);
	}
	if (!existed || options.hardenExisting !== false) {
		chmodSync(directoryPath, PRIVATE_DIRECTORY_MODE);
	}
}

/** Reject links and tighten an existing sensitive file to owner-only access. */
export function hardenPrivateRegularFileSync(filePath: string): void {
	const stat = lstatSync(filePath);
	if (stat.isSymbolicLink() || !stat.isFile()) {
		throw new Error(`Refusing to use non-regular private file: ${filePath}`);
	}
	if (stat.nlink !== 1) {
		throw new Error(`Refusing to use multiply-linked private file: ${filePath}`);
	}
	chmodSync(filePath, PRIVATE_FILE_MODE);
}

/** Append through an owner-only, no-follow handle. The file must already exist. */
export function appendPrivateFileSync(filePath: string, content: string): void {
	const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
	const fd = openSync(filePath, constants.O_WRONLY | constants.O_APPEND | noFollow);
	try {
		assertPrivateRegularFile(fstatSync(fd), filePath);
		fchmodSync(fd, PRIVATE_FILE_MODE);
		writeFileSync(fd, content, "utf8");
	} finally {
		closeSync(fd);
	}
}

/** Create a collision-resistant owner-only directory beneath a caller-provided prefix. */
export function createPrivateTempDirectorySync(prefixPath: string): string {
	const directoryPath = mkdtempSync(prefixPath);
	chmodSync(directoryPath, PRIVATE_DIRECTORY_MODE);
	return directoryPath;
}

/** Create a new owner-only scratch file without ever replacing an existing path. */
export function writePrivateNewFileSync(filePath: string, content: string | NodeJS.ArrayBufferView): void {
	const fd = openSync(filePath, "wx", PRIVATE_FILE_MODE);
	try {
		fchmodSync(fd, PRIVATE_FILE_MODE);
		writeFileSync(fd, content);
		fsyncSync(fd);
		closeSync(fd);
		if (process.platform !== "win32") {
			const parentFd = openSync(dirname(filePath), "r");
			try {
				fsyncSync(parentFd);
			} finally {
				closeSync(parentFd);
			}
		}
	} catch (error) {
		try {
			closeSync(fd);
		} catch {
			// Preserve the original creation error.
		}
		try {
			rmSync(filePath, { force: true });
		} catch {
			// Preserve the original creation error.
		}
		throw error;
	}
}
