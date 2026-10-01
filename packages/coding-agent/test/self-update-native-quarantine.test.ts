import type * as fs from "node:fs";
import {
	closeSync,
	existsSync,
	fstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupSelfUpdateQuarantine, quarantineNativeAddons } from "../src/utils/self-update-native-quarantine.ts";

const copyFault = vi.hoisted(() => ({ failForSuffix: undefined as string | undefined }));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return {
		...actual,
		copyFileSync(...args: Parameters<typeof actual.copyFileSync>): void {
			const [, destination] = args;
			if (copyFault.failForSuffix !== undefined && String(destination).endsWith(copyFault.failForSuffix)) {
				// A disk that fills up mid-copy leaves a truncated destination behind.
				actual.writeFileSync(destination, "partial");
				throw Object.assign(new Error("ENOSPC: no space left on device, copyfile"), { code: "ENOSPC" });
			}
			actual.copyFileSync(...args);
		},
	};
});

const ADDONS = {
	workspaceFs: join("native", "workspace-fs", "prebuilds", "linux-x64-gnu", "workspace-fs.node"),
	iroh: join("node_modules", "@scope", "dep", "dep.linux-x64-gnu.node"),
	upperCase: join("node_modules", "@scope", "dep", "prebuilds", "Upper.NODE"),
} as const;

let tempDir: string;
let globalRoot: string;
let packageDir: string;
let quarantineRoot: string;
let heldDescriptors: number[];

function writeFile(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

function hold(path: string): number {
	const fd = openSync(path, "r");
	heldDescriptors.push(fd);
	return fd;
}

function identity(path: string): bigint {
	return statSync(path, { bigint: true }).ino;
}

function heldIdentity(fd: number): bigint {
	return fstatSync(fd, { bigint: true }).ino;
}

function quarantineRunDirs(): string[] {
	return existsSync(quarantineRoot) ? readdirSync(quarantineRoot).map((name) => join(quarantineRoot, name)) : [];
}

beforeEach(() => {
	tempDir = realpathSync.native(mkdtempSync(join(tmpdir(), "volt-native-quarantine-")));
	globalRoot = join(tempDir, "lib", "node_modules");
	packageDir = join(globalRoot, "@scope", "pkg");
	quarantineRoot = join(globalRoot, ".volt-native-quarantine");
	heldDescriptors = [];
	writeFile(join(packageDir, "package.json"), JSON.stringify({ name: "@scope/pkg" }));
	writeFile(join(packageDir, "dist", "cli.js"), "cli");
	for (const [name, relativePath] of Object.entries(ADDONS)) {
		writeFile(join(packageDir, relativePath), `addon:${name}`);
	}
	writeFile(join(tempDir, "outside", "outside.node"), "outside");
	symlinkSync(join(tempDir, "outside"), join(packageDir, "linked"), "junction");
});

afterEach(() => {
	copyFault.failForSuffix = undefined;
	// Windows cannot remove directories that contain open files.
	for (const fd of heldDescriptors) closeSync(fd);
	rmSync(tempDir, { recursive: true, force: true });
});

describe("quarantineNativeAddons", () => {
	it("moves every held native addon out of the package and leaves identical copies in place", () => {
		const held = Object.fromEntries(
			Object.entries(ADDONS).map(([name, relativePath]) => [name, hold(join(packageDir, relativePath))]),
		);
		const cliIdentity = identity(join(packageDir, "dist", "cli.js"));
		const outsideIdentity = identity(join(tempDir, "outside", "outside.node"));

		quarantineNativeAddons(packageDir);

		const runDirs = quarantineRunDirs();
		expect(runDirs).toHaveLength(1);
		for (const [name, relativePath] of Object.entries(ADDONS)) {
			const fd = held[name];
			const packagePath = join(packageDir, relativePath);
			expect(readFileSync(packagePath, "utf8")).toBe(`addon:${name}`);
			// npm will delete the file at the package path, which is no longer the held one.
			expect(identity(packagePath)).not.toBe(heldIdentity(fd));
			expect(identity(join(runDirs[0], relativePath))).toBe(heldIdentity(fd));
		}
		expect(identity(join(packageDir, "dist", "cli.js"))).toBe(cliIdentity);
		expect(identity(join(tempDir, "outside", "outside.node"))).toBe(outsideIdentity);
		expect(existsSync(join(runDirs[0], "linked"))).toBe(false);

		// What npm does to the retired package. Nothing in it is held open anymore.
		rmSync(packageDir, { recursive: true });
		for (const [name, fd] of Object.entries(held)) {
			expect(readFileSync(fd, "utf8")).toBe(`addon:${name}`);
		}
	});

	it("does nothing when the package is not inside node_modules", () => {
		const standaloneDir = join(tempDir, "standalone", "pkg");
		writeFile(join(standaloneDir, "addon.node"), "addon");
		const fd = hold(join(standaloneDir, "addon.node"));

		quarantineNativeAddons(standaloneDir);

		expect(identity(join(standaloneDir, "addon.node"))).toBe(heldIdentity(fd));
		expect(readdirSync(join(tempDir, "standalone"))).toEqual(["pkg"]);
	});

	it("puts the original back and throws when an addon cannot be copied back", () => {
		const held = Object.fromEntries(
			Object.entries(ADDONS).map(([name, relativePath]) => [name, hold(join(packageDir, relativePath))]),
		);
		copyFault.failForSuffix = ADDONS.iroh;

		expect(() => quarantineNativeAddons(packageDir)).toThrow(
			/^Could not copy native addon .*dep\.linux-x64-gnu\.node back: ENOSPC/,
		);

		const irohPath = join(packageDir, ADDONS.iroh);
		expect(identity(irohPath)).toBe(heldIdentity(held.iroh));
		expect(readFileSync(irohPath, "utf8")).toBe("addon:iroh");
		// Addons handled before the failure keep complete copies; the rest were not touched.
		for (const [name, relativePath] of Object.entries(ADDONS)) {
			expect(readFileSync(join(packageDir, relativePath), "utf8")).toBe(`addon:${name}`);
		}
	});
});

describe("cleanupSelfUpdateQuarantine", () => {
	it("removes the quarantine when no process holds the addons", () => {
		quarantineNativeAddons(packageDir);
		expect(quarantineRunDirs()).toHaveLength(1);

		cleanupSelfUpdateQuarantine(packageDir);

		expect(existsSync(quarantineRoot)).toBe(false);
		for (const [name, relativePath] of Object.entries(ADDONS)) {
			expect(readFileSync(join(packageDir, relativePath), "utf8")).toBe(`addon:${name}`);
		}
	});
});
