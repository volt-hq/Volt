import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";

describe("project trust store security", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
		tempDirs.length = 0;
	});

	function makeRoot(): string {
		const root = mkdtempSync(join(tmpdir(), "volt-trust-security-"));
		tempDirs.push(root);
		return root;
	}

	test("atomically replaces an owner-only trust store", () => {
		const root = makeRoot();
		const agentDir = join(root, "agent");
		const workspace = join(root, "workspace");
		mkdirSync(workspace);
		const store = new ProjectTrustStore(agentDir);
		store.set(workspace, true);
		const trustPath = join(agentDir, "trust.json");
		const firstInode = statSync(trustPath).ino;

		store.set(workspace, false);

		expect(store.get(workspace)).toBe(false);
		expect(statSync(trustPath).mode & 0o777).toBe(0o600);
		expect(statSync(agentDir).mode & 0o777).toBe(0o700);
		expect(statSync(trustPath).ino).not.toBe(firstInode);
	});

	test("refuses a symlinked trust store without modifying its referent", () => {
		const root = makeRoot();
		const agentDir = join(root, "agent");
		const workspace = join(root, "workspace");
		mkdirSync(agentDir);
		mkdirSync(workspace);
		const referent = join(root, "referent.json");
		writeFileSync(referent, '{"keep":true}');
		symlinkSync(referent, join(agentDir, "trust.json"));

		const store = new ProjectTrustStore(agentDir);
		expect(() => store.set(workspace, true)).toThrow("non-regular private file");
		expect(readFileSync(referent, "utf8")).toBe('{"keep":true}');
	});
});
