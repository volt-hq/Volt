import { existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { startModelCatalogWatcher } from "../src/core/model-catalog-watcher.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import type { RpcCloseHandler, RpcTransport } from "../src/core/rpc/transport.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";

describe("model catalog watcher", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "volt-model-catalog-"));
		// Keep anthropic availability driven by auth.json alone in this test process.
		vi.stubEnv("ANTHROPIC_API_KEY", "");
		vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(agentDir, { recursive: true, force: true });
	});

	function createRegistry(): ModelRegistry {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		return ModelRegistry.create(authStorage, join(agentDir, "models.json"));
	}

	function saveApiKeyFromAnotherProcess(key: string): void {
		// A separate AuthStorage instance simulates another CLI process writing auth.json.
		AuthStorage.create(join(agentDir, "auth.json")).set("anthropic", { type: "api_key", key });
	}

	test("notifies when a login saved by another process changes the catalog", async () => {
		const registry = createRegistry();
		expect(registry.getAvailable().some((model) => model.provider === "anthropic")).toBe(false);

		const onCatalogChanged = vi.fn();
		const stop = startModelCatalogWatcher({
			agentDir,
			getModelRegistry: () => registry,
			onCatalogChanged,
			debounceMs: 25,
		});

		try {
			saveApiKeyFromAnotherProcess("sk-test");

			await vi.waitFor(
				() => {
					expect(onCatalogChanged).toHaveBeenCalledTimes(1);
				},
				{ timeout: 5000 },
			);
			expect(registry.getAvailable().some((model) => model.provider === "anthropic")).toBe(true);
		} finally {
			stop();
		}
	});

	test("does not notify when an auth.json rewrite keeps the catalog unchanged", async () => {
		const registry = createRegistry();
		saveApiKeyFromAnotherProcess("sk-original");
		registry.refreshFromDisk();

		const refreshFromDisk = vi.spyOn(registry, "refreshFromDisk");
		const onCatalogChanged = vi.fn();
		const stop = startModelCatalogWatcher({
			agentDir,
			getModelRegistry: () => registry,
			onCatalogChanged,
			debounceMs: 25,
		});

		try {
			saveApiKeyFromAnotherProcess("sk-rotated");

			await vi.waitFor(
				() => {
					expect(refreshFromDisk).toHaveBeenCalled();
				},
				{ timeout: 5000 },
			);
			expect(onCatalogChanged).not.toHaveBeenCalled();
		} finally {
			stop();
		}
	});

	test("does not drop the catalog when auth.json is temporarily moved", async () => {
		const registry = createRegistry();
		saveApiKeyFromAnotherProcess("sk-original");
		registry.refreshFromDisk();
		expect(registry.getAvailable().some((model) => model.provider === "anthropic")).toBe(true);

		const refreshFromDisk = vi.spyOn(registry, "refreshFromDisk");
		const onCatalogChanged = vi.fn();
		const stop = startModelCatalogWatcher({
			agentDir,
			getModelRegistry: () => registry,
			onCatalogChanged,
			debounceMs: 25,
		});

		try {
			renameSync(join(agentDir, "auth.json"), join(agentDir, "auth.json.bak"));

			await vi.waitFor(
				() => {
					expect(refreshFromDisk).toHaveBeenCalled();
				},
				{ timeout: 5000 },
			);
			expect(existsSync(join(agentDir, "auth.json"))).toBe(false);
			expect(registry.getAvailable().some((model) => model.provider === "anthropic")).toBe(true);
			expect(onCatalogChanged).not.toHaveBeenCalled();
		} finally {
			stop();
		}
	});

	test("is a no-op without an agent dir", () => {
		const stop = startModelCatalogWatcher({
			agentDir: undefined,
			getModelRegistry: () => createRegistry(),
			onCatalogChanged: vi.fn(),
		});
		stop();
	});

	test("rpc mode pushes models_changed to connected clients when logins change on disk", async () => {
		const registry = createRegistry();
		const session = {
			bindExtensions: vi.fn(async () => {}),
			subscribe: vi.fn(() => () => {}),
			agent: { subscribe: vi.fn(() => () => {}) },
			modelRegistry: registry,
			sessionId: "session-1",
		};
		const runtimeHost = {
			session,
			services: { agentDir },
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;

		let closeHandler: RpcCloseHandler | undefined;
		const writes: Record<string, unknown>[] = [];
		const transport: RpcTransport = {
			write: vi.fn((value) => {
				writes.push(value as Record<string, unknown>);
			}),
			onLine: vi.fn(() => vi.fn()),
			onClose: vi.fn((handler) => {
				closeHandler = handler;
				return vi.fn();
			}),
			waitForBackpressure: vi.fn(async () => {}),
			flush: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		};

		let ready: () => void = () => {};
		const readyPromise = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const modePromise = runRpcMode(runtimeHost, { transport, onReady: ready });
		await readyPromise;

		try {
			saveApiKeyFromAnotherProcess("sk-test");

			await vi.waitFor(
				() => {
					expect(writes).toContainEqual({ type: "models_changed" });
				},
				{ timeout: 5000 },
			);
		} finally {
			closeHandler?.();
			await modePromise;
		}
	});
});
