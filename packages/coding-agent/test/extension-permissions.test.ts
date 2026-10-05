/**
 * Extension permissions (RFC §8.2, Q2): fingerprints naming where code came
 * from, the user's acknowledgment store (private, bound to a fingerprint),
 * install and update review, and the API checks an undeclared permission
 * fails.
 */

import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionPermission } from "@hansjm10/volt-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import {
	ExtensionPermissionError,
	ExtensionPermissionStore,
	extensionFingerprint,
	fingerprintIdentity,
	readGitHead,
	reviewPackagePermissions,
} from "../src/core/extensions/permissions.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createHarness } from "./suite/harness.ts";
import { testExtension } from "./utilities.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

describe("extension permissions", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "volt-permissions-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function writePackage(name: string, version: string, permissions?: ExtensionPermission[]): string {
		const root = join(tempDir, name);
		mkdirSync(root, { recursive: true });
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({
				name,
				version,
				volt: { id: name, displayName: name, entry: "index.js", ...(permissions ? { permissions } : {}) },
			}),
		);
		writeFileSync(join(root, "index.js"), "module.exports = function () {};");
		return root;
	}

	describe("fingerprints", () => {
		it("names an npm package by name and version, a git checkout by commit, and a local path by its real path", () => {
			const root = writePackage("pkg", "1.2.3");
			expect(extensionFingerprint({ id: "pkg", path: root, packageSource: "npm:pkg" })).toBe("npm:pkg@1.2.3");
			expect(extensionFingerprint({ id: "pkg", path: "<inline:1>" })).toBe("sdk:pkg");
			const local = extensionFingerprint({ id: "pkg", path: root });
			expect(local).toMatch(/^local:[0-9a-f]{32}$/);
			expect(extensionFingerprint({ id: "pkg", path: root, packageSource: "./pkg" })).toBe(local);

			mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true });
			writeFileSync(join(root, ".git", "HEAD"), `${SHA_A}\n`);
			expect(extensionFingerprint({ id: "pkg", path: root, packageSource: "git:github.com/acme/pkg@v1" })).toBe(
				`git:github.com/acme/pkg@${SHA_A}`,
			);
			writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
			writeFileSync(join(root, ".git", "refs", "heads", "main"), `${SHA_B}\n`);
			expect(readGitHead(root)).toBe(SHA_B);
			rmSync(join(root, ".git", "refs", "heads", "main"));
			writeFileSync(join(root, ".git", "packed-refs"), `# pack-refs\n${SHA_A} refs/heads/main\n`);
			expect(readGitHead(root)).toBe(SHA_A);
			writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/../../escape\n");
			expect(readGitHead(root)).toBeUndefined();
		});

		it("names an npm package by its configured source, not the installed package.json", () => {
			const root = writePackage("legit", "1.0.0");
			expect(extensionFingerprint({ id: "legit", path: root, packageSource: "npm:legit@^1.0.0" })).toBe(
				"npm:legit@1.0.0",
			);
			const tarball = extensionFingerprint({
				id: "legit",
				path: root,
				packageSource: "npm:legit@https://example.com/legit.tgz",
			});
			expect(tarball).toBe("npm:legit@https://example.com/legit.tgz@1.0.0");
			expect(fingerprintIdentity(tarball)).not.toBe("npm:legit");
			mkdirSync(join(root, ".git"), { recursive: true });
			writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/..\\..\\escape\n");
			expect(readGitHead(root)).toBeUndefined();
		});

		it("drops the revision for the package's identity", () => {
			expect(fingerprintIdentity("npm:@scope/pkg@1.2.3")).toBe("npm:@scope/pkg");
			expect(fingerprintIdentity(`git:github.com/acme/pkg@${SHA_A}`)).toBe("git:github.com/acme/pkg");
			expect(fingerprintIdentity("local:abc")).toBe("local:abc");
		});
	});

	describe("acknowledgment store", () => {
		it("keeps acknowledgments in a private file, bound to the fingerprint and the permissions", () => {
			const store = new ExtensionPermissionStore(tempDir);
			const subject = {
				id: "deploy",
				fingerprint: "npm:deploy@1.0.0",
				permissions: ["exec"] as ExtensionPermission[],
			};
			expect(store.review({ ...subject, permissions: [] })).toEqual({ status: "acknowledged" });
			expect(store.review(subject)).toEqual({ status: "ask", added: ["exec"] });
			store.acknowledge({ ...subject, version: "1.0.0" });
			// POSIX modes only: Windows does not enforce them.
			if (process.platform !== "win32") {
				expect(statSync(join(tempDir, "extension-permissions.json")).mode & 0o777).toBe(0o600);
			}
			expect(store.isAcknowledged(subject)).toBe(true);
			expect(store.get("deploy")).toMatchObject({
				fingerprint: "npm:deploy@1.0.0",
				permissions: ["exec"],
				version: "1.0.0",
			});

			// An update of the same package that adds nothing is carried; one that adds a permission asks for it.
			expect(store.review({ ...subject, fingerprint: "npm:deploy@1.1.0" })).toEqual({ status: "carried" });
			expect(
				store.review({ ...subject, fingerprint: "npm:deploy@1.1.0", permissions: ["exec", "network"] }),
			).toEqual({
				status: "ask",
				added: ["network"],
			});
			// Another package taking the id asks for everything.
			expect(store.review({ ...subject, fingerprint: "npm:impostor@1.0.0" })).toEqual({
				status: "ask",
				added: ["exec"],
			});
		});

		it("ignores entries it cannot read and refuses a non-object file", () => {
			const path = join(tempDir, "extension-permissions.json");
			writeFileSync(
				path,
				JSON.stringify({
					good: {
						fingerprint: "local:x",
						permissions: ["exec"],
						version: "1",
						acknowledgedAt: "2026-01-01T00:00:00Z",
					},
					"Bad Id": { fingerprint: "local:x", permissions: [], version: "1", acknowledgedAt: "x" },
					unknown: { fingerprint: "local:x", permissions: ["root"], version: "1", acknowledgedAt: "x" },
				}),
				{ mode: 0o600 },
			);
			const store = new ExtensionPermissionStore(tempDir);
			expect(store.get("good")?.permissions).toEqual(["exec"]);
			expect(store.get("unknown")).toBeUndefined();
			writeFileSync(path, "[]", { mode: 0o600 });
			expect(() => store.get("good")).toThrow("expected an object");
		});
	});

	describe("install and update review", () => {
		it("asks for unacknowledged permissions, records the answer, and carries updates that add none", async () => {
			const store = new ExtensionPermissionStore(tempDir);
			const root = writePackage("deploy", "1.0.0", ["exec", "network"]);
			const asked: string[][] = [];
			const confirm = async (_subject: unknown, added: readonly ExtensionPermission[]) => {
				asked.push([...added]);
				return true;
			};
			expect(await reviewPackagePermissions({ store, root, source: "npm:deploy", confirm })).toMatchObject({
				status: "acknowledged",
			});
			expect(asked).toEqual([["exec", "network"]]);
			expect(await reviewPackagePermissions({ store, root, source: "npm:deploy", confirm })).toMatchObject({
				status: "acknowledged",
			});
			expect(asked).toHaveLength(1);

			writePackage("deploy", "1.1.0", ["exec"]);
			expect(await reviewPackagePermissions({ store, root, source: "npm:deploy" })).toMatchObject({
				status: "acknowledged",
			});
			expect(store.get("deploy")?.fingerprint).toBe("npm:deploy@1.1.0");

			writePackage("deploy", "1.2.0", ["exec", "secrets"]);
			expect(await reviewPackagePermissions({ store, root, source: "npm:deploy" })).toMatchObject({
				status: "unreviewed",
			});
			expect(
				await reviewPackagePermissions({ store, root, source: "npm:deploy", confirm: async () => false }),
			).toMatchObject({
				status: "declined",
			});
			expect(store.get("deploy")?.fingerprint).toBe("npm:deploy@1.1.0");
			expect(
				await reviewPackagePermissions({ store, root: writePackage("plain", "1.0.0"), source: "npm:plain" }),
			).toEqual({
				status: "none",
			});
		});
	});

	describe("API checks", () => {
		async function load(permissions: ExtensionPermission[] | undefined, factory: (volt: ExtensionAPI) => void) {
			return loadExtensionFromFactory(
				testExtension("checked", factory, permissions),
				tempDir,
				createEventBus(),
				createExtensionRuntime(),
			);
		}

		it("refuses volt.exec without exec and provider registration without providers", async () => {
			let api: ExtensionAPI | undefined;
			await load(undefined, (volt) => {
				api = volt;
			});
			await expect(api!.exec("true", [])).rejects.toThrow(
				new ExtensionPermissionError("checked", "exec", "volt.exec"),
			);
			await expect(load(undefined, (volt) => volt.registerProvider("p", { baseUrl: "https://x" }))).rejects.toThrow(
				'Extension "checked" needs the "providers" permission to use volt.registerProvider',
			);
			expect(() => api!.unregisterProvider("p")).toThrow('needs the "providers" permission');

			let permitted: ExtensionAPI | undefined;
			await load(["exec", "providers"], (volt) => {
				permitted = volt;
				volt.registerProvider("p", { baseUrl: "https://x" });
			});
			expect((await permitted!.exec(process.execPath, ["-e", "process.exit(3)"])).code).toBe(3);
		});

		it("shows stored credentials and provider registration through ctx.modelRegistry only to declared extensions", async () => {
			const runtime = createExtensionRuntime();
			const eventBus = createEventBus();
			const plain = await loadExtensionFromFactory(
				testExtension("plain", () => {}),
				tempDir,
				eventBus,
				runtime,
			);
			const trusted = await loadExtensionFromFactory(
				testExtension("trusted", () => {}, ["secrets", "providers"]),
				tempDir,
				eventBus,
				runtime,
			);
			const modelRegistry = ModelRegistry.inMemory(AuthStorage.inMemory());
			const runner = new ExtensionRunner(
				[plain, trusted],
				runtime,
				tempDir,
				SessionManager.inMemory(),
				modelRegistry,
			);

			const plainRegistry = runner.createContext("plain").modelRegistry;
			expect(plainRegistry.getAll()).toEqual(modelRegistry.getAll());
			expect(() => plainRegistry.authStorage).toThrow(
				'Extension "plain" needs the "secrets" permission to use ctx.modelRegistry.authStorage',
			);
			expect(() => plainRegistry.getApiKeyForProvider).toThrow('needs the "secrets" permission');
			expect(() => plainRegistry.registerProvider).toThrow('needs the "providers" permission');
			expect(() => plainRegistry.client.registerProvider).toThrow(
				"to use ctx.modelRegistry.client.registerProvider",
			);
			expect(typeof plainRegistry.client.complete).toBe("function");

			// A descriptor carries the value: it is checked like a read.
			expect(() => Object.getOwnPropertyDescriptor(plainRegistry, "authStorage")).toThrow(
				'needs the "secrets" permission',
			);
			expect(() => Object.getOwnPropertyDescriptor(plainRegistry, "client")?.value.registerProvider).toThrow(
				'needs the "providers" permission',
			);
			// Provider implementations are shared objects: reaching them needs providers.
			expect(() => plainRegistry.client.getProviders).toThrow('needs the "providers" permission');
			expect(() => plainRegistry.client.getOAuthProvider).toThrow('needs the "providers" permission');
			expect(() => plainRegistry.client.generateImages).toThrow('needs the "secrets" permission');

			// Requests carry the provider's credentials, so they go only where the catalog says.
			const [model] = modelRegistry.getAll();
			expect(model).toBeDefined();
			expect(() =>
				plainRegistry.client.complete({ ...model!, baseUrl: "http://127.0.0.1:9/steal" }, { messages: [] }),
			).toThrow(
				'needs the "secrets" permission to use ctx.modelRegistry.client.complete with a model other than the catalog\'s',
			);
			expect(() =>
				plainRegistry.client.streamSimple({ ...model!, id: "not-in-the-catalog" }, { messages: [] }),
			).toThrow("with a model other than the catalog's");
			const unaffordable = new AbortController();
			unaffordable.abort();
			const answer = await plainRegistry.client.complete(
				model!,
				{ messages: [] },
				{ signal: unaffordable.signal, apiKey: "test" },
			);
			expect(answer.role).toBe("assistant");

			const trustedRegistry = runner.createContext("trusted").modelRegistry;
			expect(trustedRegistry.authStorage.list()).toEqual([]);
			expect(typeof trustedRegistry.client.registerProvider).toBe("function");
			expect(runner.createContext().modelRegistry.authStorage.list()).toEqual([]);
		});
	});
});

describe("volt.setModel", () => {
	it("sets the catalog's model, never the caller's copy of it", async () => {
		let api: ExtensionAPI | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					api = volt;
				},
			],
		});
		try {
			const model = harness.getModel();
			expect(await api!.setModel({ ...model, baseUrl: "http://127.0.0.1:9/steal" })).toBe(true);
			expect(harness.session.model?.baseUrl).toBe(model.baseUrl);
			expect(await api!.setModel({ ...model, id: "not-in-the-catalog" })).toBe(false);
		} finally {
			await harness.cleanupAsync();
		}
	});
});
