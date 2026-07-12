import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";

const cleanups: string[] = [];

afterEach(() => {
	for (const path of cleanups.splice(0)) {
		rmSync(path, { recursive: true, force: true });
	}
});

function createHarness(): { authPath: string; root: string } {
	const root = mkdtempSync(join(tmpdir(), "volt-auth-private-"));
	cleanups.push(root);
	return { authPath: join(root, "agent", "auth.json"), root };
}

describe("private auth storage", () => {
	test.runIf(process.platform !== "win32")("tightens existing credentials and atomically replaces their inode", () => {
		const { authPath } = createHarness();
		mkdirSync(join(authPath, ".."), { recursive: true });
		writeFileSync(authPath, "{}", { mode: 0o644 });
		const originalInode = statSync(authPath).ino;

		const storage = AuthStorage.create(authPath);
		storage.set("anthropic", { type: "api_key", key: "secret" });

		expect(statSync(authPath).mode & 0o777).toBe(0o600);
		expect(statSync(join(authPath, "..")).mode & 0o777).toBe(0o700);
		expect(statSync(authPath).ino).not.toBe(originalInode);
		expect(JSON.parse(readFileSync(authPath, "utf8"))).toEqual({
			anthropic: { type: "api_key", key: "secret" },
		});
	});

	test.runIf(process.platform !== "win32")("rejects a linked credential file without touching its referent", () => {
		const { authPath, root } = createHarness();
		mkdirSync(join(authPath, ".."), { recursive: true });
		const referent = join(root, "outside.json");
		writeFileSync(referent, "outside", { mode: 0o600 });
		symlinkSync(referent, authPath);

		const storage = AuthStorage.create(authPath);
		expect(
			storage
				.drainErrors()
				.map((error) => error.message)
				.join("\n"),
		).toContain("Refusing to use non-regular private file");
		storage.set("anthropic", { type: "api_key", key: "must-not-write" });

		expect(readFileSync(referent, "utf8")).toBe("outside");
		expect(lstatSync(authPath).isSymbolicLink()).toBe(true);
	});
});
