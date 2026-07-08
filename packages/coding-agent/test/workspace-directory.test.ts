import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listWorkspaceDirectories, resolveWorkspaceDirectory } from "../src/daemon/workspace-directory.ts";

describe("workspace directory validation", () => {
	let root: string;
	let outside: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "volt-workspace-dir-"));
		outside = mkdtempSync(join(tmpdir(), "volt-workspace-outside-"));
		mkdirSync(join(root, "packages", "app"), { recursive: true });
		mkdirSync(join(root, ".github"), { recursive: true });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	});

	it("accepts relative subdirectories and lists only relative child paths", async () => {
		const resolved = await resolveWorkspaceDirectory(root, "packages/app");
		expect(resolved).toMatchObject({ ok: true, value: { relativePath: "packages/app" } });

		const listed = await listWorkspaceDirectories(root);
		expect(listed).toMatchObject({
			ok: true,
			directories: expect.arrayContaining([{ name: "packages", path: "packages" }]),
		});
		if (listed.ok) {
			expect(listed.directories.every((entry) => !entry.path.startsWith("/"))).toBe(true);
		}
	});

	it("rejects absolute, parent, dot, control-character, .git, and symlink-escape selections", async () => {
		symlinkSync(outside, join(root, "escape"));

		await expect(resolveWorkspaceDirectory(root, "/tmp")).resolves.toMatchObject({
			ok: false,
			error: "invalid_working_directory",
		});
		await expect(resolveWorkspaceDirectory(root, "../escape")).resolves.toMatchObject({
			ok: false,
			error: "invalid_working_directory",
		});
		await expect(resolveWorkspaceDirectory(root, ".")).resolves.toMatchObject({
			ok: false,
			error: "invalid_working_directory",
		});
		await expect(resolveWorkspaceDirectory(root, "packages/\tapp")).resolves.toMatchObject({
			ok: false,
			error: "invalid_working_directory",
		});
		await expect(resolveWorkspaceDirectory(root, ".git")).resolves.toMatchObject({
			ok: false,
			error: "invalid_working_directory",
		});
		await expect(resolveWorkspaceDirectory(root, "escape")).resolves.toMatchObject({
			ok: false,
			error: "workspace_directory_escape",
		});
	});
});
