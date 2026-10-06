import type * as fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hardenSessionStoreFiles } from "../../src/core/session-store/artifacts.ts";

// Regression #483: a delete-pending Windows sidecar fails chmod with EPERM.
const fixture = vi.hoisted(() => ({ deletePending: undefined as string | undefined }));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return {
		...actual,
		chmodSync(path: Parameters<typeof actual.chmodSync>[0], mode: Parameters<typeof actual.chmodSync>[1]): void {
			if (path === fixture.deletePending) {
				throw Object.assign(new Error(`EPERM: operation not permitted, chmod '${path}'`), { code: "EPERM" });
			}
			actual.chmodSync(path, mode);
		},
	};
});

const platform = Object.getOwnPropertyDescriptor(process, "platform");
const roots: string[] = [];

function storeWithSidecars(): string {
	const root = mkdtempSync(join(tmpdir(), "volt-delete-pending-"));
	roots.push(root);
	const database = join(root, "sessions.sqlite");
	for (const path of [database, `${database}-wal`, `${database}-shm`]) writeFileSync(path, "");
	return database;
}

function setPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { configurable: true, value });
}

afterEach(() => {
	fixture.deletePending = undefined;
	if (platform) Object.defineProperty(process, "platform", platform);
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("session store hardening of delete-pending sidecars", () => {
	it("treats EPERM on a sidecar as a sidecar going away on Windows", () => {
		const database = storeWithSidecars();
		fixture.deletePending = `${database}-shm`;
		setPlatform("win32");
		expect(() => hardenSessionStoreFiles(database)).not.toThrow();
	});

	it("still rejects EPERM on a sidecar elsewhere", () => {
		const database = storeWithSidecars();
		fixture.deletePending = `${database}-shm`;
		setPlatform("linux");
		expect(() => hardenSessionStoreFiles(database)).toThrow(expect.objectContaining({ code: "EPERM" }));
	});

	it("still rejects EPERM on the database itself on Windows", () => {
		const database = storeWithSidecars();
		fixture.deletePending = database;
		setPlatform("win32");
		expect(() => hardenSessionStoreFiles(database)).toThrow(expect.objectContaining({ code: "EPERM" }));
	});
});
