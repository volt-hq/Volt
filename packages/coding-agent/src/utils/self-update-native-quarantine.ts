import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, resolve, toNamespacedPath } from "node:path";

const QUARANTINE_DIR_NAME = ".volt-native-quarantine";

function normalizePath(path: string): string {
	return toNamespacedPath(resolve(path));
}

function getQuarantineRoot(packageDir: string): string | undefined {
	let current = resolve(packageDir);
	while (true) {
		if (basename(current).toLowerCase() === "node_modules") {
			return join(current, QUARANTINE_DIR_NAME);
		}
		const parent = dirname(current);
		if (parent === current) {
			return undefined;
		}
		current = parent;
	}
}

/** Every regular `.node` file below `directory`. Symlinks and junctions are not followed. */
function findNativeAddons(directory: string, found: string[] = []): string[] {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const entryPath = join(directory, entry.name);
		if (entry.isDirectory()) {
			findNativeAddons(entryPath, found);
		} else if (entry.isFile() && entry.name.toLowerCase().endsWith(".node")) {
			found.push(entryPath);
		}
	}
	return found;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function cleanupSelfUpdateQuarantine(packageDir: string): void {
	const quarantineRoot = getQuarantineRoot(packageDir);
	if (!quarantineRoot) {
		return;
	}
	try {
		rmSync(quarantineRoot, { recursive: true, force: true });
	} catch {
		// A volt process may still hold a quarantined native addon.
	}
}

/**
 * Moves every native addon out of the installed package and puts a copy back in its place.
 *
 * Other volt processes (a daemon for another agent directory, open sessions) can hold these
 * files open. Deleting an open file fails on Windows and leaves `.fuse_hidden*` or `.nfs*`
 * placeholders on FUSE and NFS, which stops npm from removing the old package. Renaming an
 * open file works on all of them, so npm only ever deletes the copies.
 *
 * Throws if a file cannot be moved aside or copied back. Every file is then still complete at
 * its original path.
 */
export function quarantineNativeAddons(packageDir: string): void {
	const resolvedPackageDir = normalizePath(packageDir);
	const quarantineRoot = getQuarantineRoot(resolvedPackageDir);
	if (!quarantineRoot) {
		return;
	}

	const addons = findNativeAddons(resolvedPackageDir);
	if (addons.length === 0) {
		return;
	}

	const quarantineRunDir = join(quarantineRoot, `${Date.now()}-${process.pid}-${randomUUID()}`);
	for (const addon of addons) {
		const quarantinePath = join(quarantineRunDir, relative(resolvedPackageDir, addon));
		try {
			mkdirSync(dirname(quarantinePath), { recursive: true });
			renameSync(addon, quarantinePath);
		} catch (error) {
			throw new Error(`Could not move native addon ${addon} aside: ${errorMessage(error)}`, { cause: error });
		}
		try {
			copyFileSync(quarantinePath, addon);
		} catch (copyError) {
			try {
				rmSync(addon, { force: true });
				renameSync(quarantinePath, addon);
			} catch (restoreError) {
				throw new Error(
					`Could not copy native addon ${addon} back (${errorMessage(copyError)}), and could not restore it from ${quarantinePath}: ${errorMessage(restoreError)}`,
					{ cause: copyError },
				);
			}
			throw new Error(`Could not copy native addon ${addon} back: ${errorMessage(copyError)}`, {
				cause: copyError,
			});
		}
	}
}
