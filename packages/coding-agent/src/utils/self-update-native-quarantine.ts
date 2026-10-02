import { randomUUID } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

const QUARANTINE_DIR_NAME = ".volt-native-quarantine";
/**
 * Written to a quarantine run once every addon in it has a complete copy back in the package.
 * Cleanup removes only runs that have it: any other run may hold the only copy of an addon.
 */
const RESTORED_MARKER = ".restored";

/** An addon could not be copied back or restored, so its only complete copy is in the quarantine. */
export class NativeAddonRestoreError extends Error {
	readonly addonPath: string;
	readonly quarantinePath: string;
	readonly quarantineRunDir: string;

	constructor(
		message: string,
		paths: { addonPath: string; quarantinePath: string; quarantineRunDir: string },
		options: ErrorOptions,
	) {
		super(message, options);
		this.addonPath = paths.addonPath;
		this.quarantinePath = paths.quarantinePath;
		this.quarantineRunDir = paths.quarantineRunDir;
	}
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

function markRunRestored(quarantineRunDir: string): void {
	try {
		writeFileSync(join(quarantineRunDir, RESTORED_MARKER), "");
	} catch {
		// The run is kept. Every addon is complete in the package, so only disk space is lost.
	}
}

/** Removes every quarantine run whose addons all have complete copies back in the package. */
export function cleanupSelfUpdateQuarantine(packageDir: string): void {
	const quarantineRoot = getQuarantineRoot(packageDir);
	if (!quarantineRoot) {
		return;
	}
	let runNames: string[];
	try {
		runNames = readdirSync(quarantineRoot);
	} catch {
		return;
	}
	for (const runName of runNames) {
		const runDir = join(quarantineRoot, runName);
		try {
			if (!existsSync(join(runDir, RESTORED_MARKER))) {
				continue;
			}
			// The marker goes last, so a run that is only partly removed is still removed later.
			for (const name of readdirSync(runDir)) {
				if (name !== RESTORED_MARKER) {
					rmSync(join(runDir, name), { recursive: true, force: true });
				}
			}
			rmSync(runDir, { recursive: true, force: true });
		} catch {
			// A volt process may still hold a quarantined native addon.
		}
	}
	try {
		rmdirSync(quarantineRoot);
	} catch {
		// Runs remain.
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
 * its original path, unless the error is a {@link NativeAddonRestoreError}.
 */
export function quarantineNativeAddons(packageDir: string): void {
	// Not namespaced: these paths reach the user in NativeAddonRestoreError recovery instructions.
	const resolvedPackageDir = resolve(packageDir);
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
			markRunRestored(quarantineRunDir);
			throw new Error(`Could not move native addon ${addon} aside: ${errorMessage(error)}`, { cause: error });
		}
		try {
			copyFileSync(quarantinePath, addon);
		} catch (copyError) {
			try {
				rmSync(addon, { force: true });
				renameSync(quarantinePath, addon);
			} catch (restoreError) {
				throw new NativeAddonRestoreError(
					`Could not copy native addon ${addon} back (${errorMessage(copyError)}), and could not restore it from ${quarantinePath}: ${errorMessage(restoreError)}`,
					{ addonPath: addon, quarantinePath, quarantineRunDir },
					{ cause: copyError },
				);
			}
			markRunRestored(quarantineRunDir);
			throw new Error(`Could not copy native addon ${addon} back: ${errorMessage(copyError)}`, {
				cause: copyError,
			});
		}
	}
	markRunRestored(quarantineRunDir);
}
