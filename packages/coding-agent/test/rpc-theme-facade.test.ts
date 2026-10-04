/**
 * M6 rpc-mode theme facade (§9.4, supersedes the old "returns [] / fails in
 * rpc mode" behavior): extensions bound in rpc mode see the real theme list,
 * can look themes up by name, and setTheme applies + persists.
 */

import { describe, expect, test, vi } from "vitest";
import { BackgroundJobManager } from "../src/core/background-jobs.ts";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import type { RpcCloseHandler, RpcTransport } from "../src/core/rpc/transport.ts";
import { Theme } from "../src/core/theme/runtime.ts";
import { runLegacyRemoteRpcMode } from "../src/modes/rpc/legacy-remote-rpc-mode.ts";
import { createFakeConversation, createFakeHost } from "./utilities/fake-conversation-host.ts";

function createSession() {
	return {
		backgroundJobs: new BackgroundJobManager({ isToolAllowed: () => true, getGeneration: () => 0 }),
		attachExtensionClient: vi.fn(
			(_options: {
				ui: ExtensionUIContext;
				mode: string;
				commandContextActions: { waitForIdle(): Promise<void> };
			}) => ({ ready: Promise.resolve(), detach: () => {} }),
		),
		subscribe: vi.fn(() => () => undefined),
		activeToolExecutions: new Map(),
		subscribeRuntimeEvents: vi.fn(() => () => undefined),
		resourceLoader: {
			getSubagents: () => ({ definitions: [], diagnostics: [] }),
			getThemes: () => ({ themes: [] }),
		},
		getSubagentToolManager: () => undefined,
		getActiveToolNames: () => ["read"],
		waitForIdle: vi.fn(async () => undefined),
		sessionId: "s-theme",
		sessionFile: undefined,
		settingsManager: {
			subscribeCompactionSettings: vi.fn(() => () => {}),
			getTheme: vi.fn(() => undefined),
			setTheme: vi.fn(),
		},
	};
}

/** A host whose rpc-mode conversation binds extensions in rpc mode. */
function createRuntimeHost(session: ReturnType<typeof createSession>) {
	const fake = createFakeHost({ extensionMode: "rpc" });
	const { conversation } = createFakeConversation(session);
	return { ...fake, conversation };
}

function createFakeTransport(): RpcTransport {
	return {
		write: vi.fn(),
		onLine: vi.fn(() => vi.fn()),
		onClose: vi.fn((_handler: RpcCloseHandler) => vi.fn()),
		waitForBackpressure: vi.fn(async () => undefined),
		flush: vi.fn(async () => undefined),
		close: vi.fn(async () => undefined),
	};
}

describe("rpc-mode extension theme facade", () => {
	test("getAllThemes is non-empty, getTheme resolves, setTheme applies and persists", async () => {
		const session = createSession();
		const runtimeHost = createRuntimeHost(session);
		let resolveReady: () => void = () => undefined;
		const ready = new Promise<void>((resolve) => {
			resolveReady = resolve;
		});
		const modePromise = runLegacyRemoteRpcMode(runtimeHost.host, runtimeHost.conversation, {
			transport: createFakeTransport(),
			onReady: resolveReady,
		});
		await ready;
		await vi.waitFor(() => expect(session.attachExtensionClient).toHaveBeenCalled());

		const bindOptions = session.attachExtensionClient.mock.calls[0]?.[0];
		const uiContext = bindOptions?.ui as ExtensionUIContext;
		expect(bindOptions?.mode).toBe("rpc");
		await bindOptions?.commandContextActions.waitForIdle();
		expect(session.waitForIdle).toHaveBeenCalledOnce();

		// Theme rows (§12.3.4): the full list is visible in rpc mode.
		const allThemes = uiContext.getAllThemes();
		const names = allThemes.map((entry) => entry.name);
		expect(names).toContain("dark");
		expect(names).toContain("light");

		const dark = uiContext.getTheme("dark");
		expect(dark).toBeInstanceOf(Theme);

		// setTheme applies to this process's instance and persists the choice.
		const applied = uiContext.setTheme("light");
		expect(applied).toEqual({ success: true });
		expect(session.settingsManager.setTheme).toHaveBeenCalledWith("light");
		expect(uiContext.theme.name).toBe("light");

		// Unknown themes fail without persisting.
		session.settingsManager.setTheme.mockClear();
		const failed = uiContext.setTheme("no-such-theme");
		expect(failed.success).toBe(false);
		expect(session.settingsManager.setTheme).not.toHaveBeenCalled();

		await runtimeHost.close(runtimeHost.conversation);
		// Shut the mode down by closing the conversation; the transport never
		// closes on its own in this harness, so just stop awaiting it.
		void modePromise;
	});
});
