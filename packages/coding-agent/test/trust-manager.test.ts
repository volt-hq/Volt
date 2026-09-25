import type * as fs from "node:fs";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "../src/core/trust-manager.ts";

const resourceFixture = vi.hoisted(() => ({ root: undefined as string | undefined }));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return {
		...actual,
		existsSync(path: Parameters<typeof actual.existsSync>[0]): boolean {
			if (resourceFixture.root !== undefined) {
				if (typeof path !== "string") return false;
				const fromFixture = relative(resourceFixture.root, path);
				if (fromFixture === ".." || fromFixture.startsWith(`..${sep}`) || isAbsolute(fromFixture)) return false;
			}
			return actual.existsSync(path);
		},
	};
});

describe("ProjectTrustStore", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `trust-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		tempDir = realpathSync.native(tempDir);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("stores decisions per cwd", () => {
		const store = new ProjectTrustStore(agentDir);

		expect(store.get(cwd)).toBeNull();
		expect(store.getEntry(cwd)).toBeNull();
		store.set(cwd, true);
		expect(store.get(cwd)).toBe(true);
		expect(store.getEntry(cwd)).toEqual({ path: cwd, decision: true });
		store.set(cwd, false);
		expect(store.get(cwd)).toBe(false);
		expect(store.getEntry(cwd)).toEqual({ path: cwd, decision: false });
		store.set(cwd, null);
		expect(store.get(cwd)).toBeNull();
		expect(store.getEntry(cwd)).toBeNull();
	});

	it("inherits the closest saved decision from parent directories", () => {
		const store = new ProjectTrustStore(agentDir);
		const parentDir = join(tempDir, "trusted-parent");
		const childDir = join(parentDir, "project");
		const grandchildDir = join(childDir, "nested");
		mkdirSync(grandchildDir, { recursive: true });

		store.set(parentDir, true);
		expect(store.get(childDir)).toBe(true);
		expect(store.getEntry(childDir)).toEqual({ path: parentDir, decision: true });
		expect(store.get(grandchildDir)).toBe(true);
		expect(store.getEntry(grandchildDir)).toEqual({ path: parentDir, decision: true });

		store.set(childDir, false);
		expect(store.get(grandchildDir)).toBe(false);
		expect(store.getEntry(grandchildDir)).toEqual({ path: childDir, decision: false });
	});

	it("can clear a child override to inherit parent trust", () => {
		const store = new ProjectTrustStore(agentDir);
		const parentDir = join(tempDir, "trusted-parent");
		const childDir = join(parentDir, "project");
		mkdirSync(childDir, { recursive: true });

		store.set(parentDir, true);
		store.set(childDir, false);
		expect(store.getEntry(childDir)).toEqual({ path: childDir, decision: false });

		store.setMany([
			{ path: parentDir, decision: true },
			{ path: childDir, decision: null },
		]);
		expect(store.get(childDir)).toBe(true);
		expect(store.getEntry(childDir)).toEqual({ path: parentDir, decision: true });
	});

	it("fails loudly without overwriting malformed trust stores", () => {
		const trustPath = join(agentDir, "trust.json");
		writeFileSync(trustPath, "{not json", "utf-8");
		const store = new ProjectTrustStore(agentDir);

		expect(() => store.get(cwd)).toThrow(/Failed to read trust store/);
		expect(() => store.set(cwd, true)).toThrow(/Failed to read trust store/);
		expect(readFileSync(trustPath, "utf-8")).toBe("{not json");
	});

	it("detects trust-requiring project resources", () => {
		// Only this fixture's resources participate. The OS temp directory may
		// itself be below a developer's real ~/.agents/skills ancestor.
		resourceFixture.root = tempDir;
		const originalHome = process.env.HOME;
		process.env.HOME = tempDir;
		try {
			mkdirSync(join(tempDir, ".volt", "agent"), { recursive: true });
			mkdirSync(join(tempDir, ".agents", "skills"), { recursive: true });
			expect(hasTrustRequiringProjectResources(tempDir)).toBe(false);
			expect(hasTrustRequiringProjectResources(cwd)).toBe(false);

			writeFileSync(join(tempDir, ".volt", "settings.json"), "{}");
			expect(hasTrustRequiringProjectResources(tempDir)).toBe(true);
			rmSync(join(tempDir, ".volt", "settings.json"), { force: true });

			mkdirSync(join(cwd, ".volt"), { recursive: true });
			writeFileSync(join(cwd, ".volt", "settings.json"), "{}");
			expect(hasTrustRequiringProjectResources(cwd)).toBe(true);
			rmSync(join(cwd, ".volt"), { recursive: true, force: true });

			writeFileSync(join(cwd, "AGENTS.md"), "Project instructions");
			expect(hasTrustRequiringProjectResources(cwd)).toBe(false);
			rmSync(join(cwd, "AGENTS.md"), { force: true });

			writeFileSync(join(cwd, "CLAUDE.md"), "Legacy project instructions");
			expect(hasTrustRequiringProjectResources(cwd)).toBe(false);
			rmSync(join(cwd, "CLAUDE.md"), { force: true });

			mkdirSync(join(cwd, ".agents", "skills"), { recursive: true });
			expect(hasTrustRequiringProjectResources(cwd)).toBe(true);
			const nested = join(cwd, "nested");
			mkdirSync(nested);
			expect(hasTrustRequiringProjectResources(nested)).toBe(true);
		} finally {
			resourceFixture.root = undefined;
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
		}
	});
});
