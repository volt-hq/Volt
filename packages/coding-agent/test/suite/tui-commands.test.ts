/**
 * The TUI's commands as its protocol client's intents and queries
 * (architecture rewrite §10, Phase 6 slice 9): the model, scope, settings,
 * profile, sign-in, language server, MCP, extension, usage, debug, review,
 * plan, and Fast mode commands. Host settings change through the host's
 * intents and the TUI's display settings in its own settings manager; a
 * provider sign-in shows its page and prompts in the TUI (a key masked, never
 * in the editor's history); a review runs as the conversation's detached
 * `review` work, which the loader shows with its passes until it opens the
 * findings, or Escape cancels it.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxToolCall,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
} from "@hansjm10/volt-ai";
import type { IntentDescriptor, QueryResult } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionFactory } from "../../src/core/extensions/index.ts";
import type { CustomEditor } from "../../src/modes/interactive/components/custom-editor.ts";
import { workOutcomeLine } from "../../src/modes/interactive/components/work-notice.ts";
import { openBrowser } from "../../src/utils/open-browser.ts";
import {
	choose,
	createTuiHarness,
	renderedScreen,
	type TuiHarness,
	type TuiHarnessOptions,
	type TuiModeFixture,
	waitForScreen,
} from "./tui-harness.ts";

vi.mock("../../src/utils/open-browser.ts", () => ({ openBrowser: vi.fn() }));

const SETTINGS = {
	theme: "dark",
	quietStartup: true,
	lsp: { enabled: false },
	compaction: { enabled: false },
	retry: { enabled: false },
};

const SECRET = "sk-test-not-a-real-key";
const ESC = "\x1b";

type ModeAccess = {
	defaultEditor: CustomEditor;
	dismissWorkInspector?: () => void;
	keybindings: { getKeys(action: string): string[] };
	input: { readonly catalog: { readonly intents: readonly IntentDescriptor[] }; load(): Promise<boolean> };
};

const harnesses: TuiHarness[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.cleanup();
	vi.restoreAllMocks();
	vi.mocked(openBrowser).mockReset();
});

async function start(
	options: TuiHarnessOptions & { tuiMode?: "regular" | "fullscreen" } = {},
): Promise<{ harness: TuiHarness; tui: TuiModeFixture; access: ModeAccess }> {
	const { tuiMode, globalSettings, ...harnessOptions } = options;
	const harness = await createTuiHarness({ globalSettings: { ...SETTINGS, ...globalSettings }, ...harnessOptions });
	harnesses.push(harness);
	const tui = await harness.startMode({ tuiMode: tuiMode ?? "regular", columns: 110, rows: 40 });
	return { harness, tui, access: tui.mode as unknown as ModeAccess };
}

/** The global settings file the host and the TUI share. */
function settingsFile(harness: TuiHarness): Record<string, unknown> {
	return JSON.parse(readFileSync(join(harness.tempDir, "settings.json"), "utf8")) as Record<string, unknown>;
}

const MODEL_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** A Fast-mode capable model provider: no request ever reaches it. */
const fastProvider: ExtensionFactory = (volt: ExtensionAPI) => {
	volt.registerProvider("openai-codex", {
		baseUrl: "https://chatgpt.com/backend-api",
		apiKey: "codex-key",
		api: "openai-codex-responses",
		models: [
			{
				id: "gpt-5.6-sol",
				name: "GPT-5.6 Sol",
				reasoning: true,
				input: ["text"],
				cost: MODEL_COST,
				contextWindow: 128_000,
				maxTokens: 16_384,
			},
		],
	});
};

/**
 * Stop the reviews that run the way the job list does (cancel the work), and close the list a started review
 * opens, so the next command meets the conversation and not the list.
 */
async function stopReviews(tui: TuiModeFixture): Promise<void> {
	const stopped: string[] = [];
	for (const item of tui.store.state.work.values()) {
		if (item.kind === "review" && item.outcome === undefined) {
			await tui.store.client.intent("cancel_work", { workId: item.workId });
			stopped.push(item.workId);
		}
	}
	(tui.mode as unknown as ModeAccess).dismissWorkInspector?.();
	if (stopped.length === 0) return;
	// A review ends after the cancel is sent, and the TUI says so in a status line a moment later. Wait for that
	// line: a status the test waits for next would otherwise be replaced by it, as the TUI keeps one status line.
	await vi.waitFor(
		() => {
			const lines = stopped.flatMap((workId) => {
				const item = tui.store.state.work.get(workId);
				return item?.outcome === undefined ? [] : [workOutcomeLine(item).text];
			});
			const screen = tui.screen().replace(/\s+/g, " ");
			expect(lines.some((line) => screen.includes(line))).toBe(true);
		},
		{ timeout: 5_000 },
	);
}

/**
 * Close the job list a started review opens, so the status lines behind it show. The review may be running before
 * the TUI has opened the list on it, so wait for the list first.
 */
async function closeJobList(tui: TuiModeFixture): Promise<void> {
	const access = tui.mode as unknown as ModeAccess;
	await vi.waitFor(() => expect(access.dismissWorkInspector).toBeDefined());
	access.dismissWorkInspector?.();
}

/** Wait for `text` on the screen, wherever the terminal wrapped it. */
async function waitForWrappedText(tui: TuiModeFixture, text: string): Promise<void> {
	await vi.waitFor(() => expect(tui.screen().replace(/\s+/g, " ")).toContain(text), { timeout: 5_000 });
}

/** A turn the faux provider holds open until it is released. */
function heldTurn(text: string) {
	const started = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	return {
		started: started.promise,
		release: () => released.resolve(),
		response: (_context: unknown, options: { signal?: AbortSignal } | undefined) =>
			new Promise<AssistantMessage>((resolve, reject) => {
				started.resolve();
				options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				void released.promise.then(() => resolve(fauxAssistantMessage(text)));
			}),
	};
}

describe("TUI model, mode, and settings commands", () => {
	it.each(["regular", "fullscreen"] as const)(
		"switches Fast mode through the host and shows its reasons (%s)",
		async (tuiMode) => {
			const { tui } = await start({ tuiMode, extension: fastProvider });

			await tui.submit("/fast toggle");
			await waitForScreen(tui, "Usage: /fast [on|off]");
			// The faux model has no Fast mode: the host says so.
			await tui.submit("/fast on");
			await waitForScreen(tui, "Fast mode is not supported for the current provider and model");
			await tui.submit("/fast off");
			await waitForScreen(tui, "Fast mode already disabled");

			await tui.submit("/model openai-codex/gpt-5.6-sol");
			await waitForScreen(tui, "Model: gpt-5.6-sol");
			await tui.submit("/fast");
			await waitForScreen(tui, "Fast mode enabled. Priority processing may cost more.");
			await vi.waitFor(() => expect(tui.store.state.fastMode).toBe(true));
			await tui.submit("/fast on");
			await waitForScreen(tui, "Fast mode already enabled. Priority processing may cost more.");
			await tui.submit("/fast");
			await waitForScreen(tui, "Fast mode disabled");
			await vi.waitFor(() => expect(tui.store.state.fastMode).toBe(false));
		},
	);

	it("switches Build and Plan mode through the host, showing a refusal's reason", async () => {
		const { harness, tui } = await start();
		await tui.submit("/plan");
		await waitForScreen(tui, "Plan mode: agent tools are read-only");
		await vi.waitFor(() => expect(tui.store.state.planning?.mode).toBe("plan"));
		await tui.submit("/build");
		await waitForScreen(tui, "Build mode");
		await vi.waitFor(() => expect(tui.store.state.planning?.mode).toBe("build"));

		vi.spyOn(harness.startup.session, "setAgentMode").mockRejectedValueOnce(
			new Error("Cannot enter Plan mode while background jobs are active; abort or wait for them to finish"),
		);
		await tui.submit("/plan");
		await waitForScreen(tui, "Cannot enter Plan mode while background jobs are active");
		expect(tui.store.state.planning?.mode).toBe("build");
	});

	it("selects a model by reference or in the selector, keeping it as the default", async () => {
		const { harness, tui } = await start({
			extension: fastProvider,
			models: [
				{ id: "faux-1", reasoning: false },
				{ id: "faux-2", reasoning: true },
			],
		});
		await tui.submit("/model faux-2");
		await waitForScreen(tui, "Model: faux-2");
		expect(tui.store.state.model).toEqual({ provider: "faux", modelId: "faux-2" });
		await vi.waitFor(() =>
			expect(settingsFile(harness)).toMatchObject({ defaultProvider: "faux", defaultModel: "faux-2" }),
		);

		// No exact match: the selector opens filtered by the text.
		void tui.submit("/model sol");
		await waitForScreen(tui, "gpt-5.6-sol", "Model Name: GPT-5.6 Sol");
		tui.terminal.sendInput("\r");
		await waitForScreen(tui, "Model: gpt-5.6-sol");
		expect(tui.store.state.model).toEqual({ provider: "openai-codex", modelId: "gpt-5.6-sol" });
		await vi.waitFor(() =>
			expect(settingsFile(harness)).toMatchObject({ defaultProvider: "openai-codex", defaultModel: "gpt-5.6-sol" }),
		);
	});

	it("scopes the model cycle through the host, and saves the scope", async () => {
		const { harness, tui } = await start({
			models: [
				{ id: "faux-1", reasoning: false },
				{ id: "faux-2", reasoning: false },
			],
		});
		void tui.submit("/scoped-models");
		await waitForScreen(tui, "faux-1", "faux-2");
		// Enter enables only the highlighted model: the cycle steps through it alone.
		tui.terminal.sendInput("\r");
		await vi.waitFor(async () =>
			expect((await tui.store.client.query("models")).cycleScope).toEqual([{ provider: "faux", modelId: "faux-1" }]),
		);
		expect(settingsFile(harness).enabledModels).toBeUndefined();
		tui.terminal.sendInput("\x13");
		await vi.waitFor(() => expect(settingsFile(harness).enabledModels).toEqual(["faux/faux-1"]));
		tui.terminal.sendInput(ESC);
		await waitForScreen(tui, "Model selection saved to settings");
		expect(harness.startup.session.scopedModels.map((scoped) => scoped.model.id)).toEqual(["faux-1"]);
	});

	it("changes host settings through the host and display settings in the TUI's own settings", async () => {
		const { harness, tui } = await start();
		const hostSettings = harness.startup.session.settingsManager;
		void tui.submit("/settings");
		await waitForScreen(tui, "Personality");
		tui.terminal.sendInput("Personality");
		tui.terminal.sendInput("\r");
		await vi.waitFor(() => expect(hostSettings.getPersonality()).toBe("pragmatic"));
		expect((await tui.store.client.query("settings")).personality).toBe("pragmatic");

		// A display setting is the TUI's own: written to the settings file, never through the host.
		// (A space would change the highlighted setting: the search is typed without one.)
		for (let index = 0; index < "Personality".length; index++) tui.terminal.sendInput("\x7f");
		tui.terminal.sendInput("Quiet");
		await waitForScreen(tui, "Quiet startup");
		tui.terminal.sendInput("\r");
		await vi.waitFor(() => expect(settingsFile(harness)).toMatchObject({ quietStartup: false }));
		expect(hostSettings.getQuietStartup()).toBe(true);
		expect(settingsFile(harness)).toMatchObject({ personality: "pragmatic" });
		tui.terminal.sendInput(ESC);
		await waitForScreen(tui, "Personality: pragmatic");
	});

	it("switches the settings profile through the host, creating it", async () => {
		const { tui } = await start();
		void tui.submit("/profile");
		await choose(tui, "Create new profile");
		await waitForScreen(tui, "Create profile");
		tui.terminal.sendInput("work");
		tui.terminal.sendInput("\r");
		await waitForScreen(tui, "Created profile work. Profile: work.");
		expect((await tui.store.client.query("settings")).profile).toBe("work");
		await tui.submit("/profile work");
		await waitForScreen(tui, "Current profile: work");
		await tui.submit("/profile missing");
		await waitForScreen(tui, 'Profile "missing" is not defined. Run /profile to create it.');
	});

	it("reloads the TUI's keybindings and theme as an extension's command reloads the conversation", async () => {
		const { harness, tui, access } = await start({
			extension: (volt: ExtensionAPI) => {
				volt.registerCommand("reload-all", {
					description: "Reload",
					handler: async (_args, ctx) => {
						await ctx.reload();
					},
				});
			},
		});
		expect(access.keybindings.getKeys("app.debug")).toEqual(["f12"]);
		writeFileSync(join(harness.tempDir, "keybindings.json"), JSON.stringify({ "app.debug": "f10" }));
		await tui.submit("/reload-all");
		await vi.waitFor(() => expect(access.keybindings.getKeys("app.debug")).toEqual(["f10"]));
	});
});

/** The subscription login a test runs. */
interface TestLogin {
	current: (callbacks: OAuthLoginCallbacks) => Promise<OAuthCredentials>;
}

/** Test providers: one that takes an API key, one with a subscription login and quota usage. */
function signInProviders(login: TestLogin) {
	return (volt: ExtensionAPI) => {
		volt.registerProvider("test-keyed", {
			baseUrl: "https://keyed.invalid",
			apiKey: "$VOLT_TEST_UNSET_KEYED_API_KEY",
			api: "openai-completions",
			models: [
				{
					id: "keyed-1",
					name: "Keyed One",
					reasoning: false,
					input: ["text"],
					cost: MODEL_COST,
					contextWindow: 8_192,
					maxTokens: 1_024,
				},
			],
		});
		volt.registerProvider("test-sub", {
			baseUrl: "https://sub.invalid",
			api: "openai-completions",
			oauth: {
				name: "Test Subscription",
				login: (callbacks) => login.current(callbacks),
				refreshToken: async (credentials) => credentials,
				getApiKey: (credentials) => credentials.access,
				fetchSubscriptionUsage: async () => ({
					status: "success",
					snapshot: {
						providerId: "test-sub",
						fetchedAt: Date.now(),
						plan: "pro_plus",
						limits: [{ id: "weekly", label: "Weekly", usedPercent: 25, limitReached: false }],
					},
				}),
			},
			models: [
				{
					id: "sub-1",
					name: "Sub One",
					reasoning: false,
					input: ["text"],
					cost: MODEL_COST,
					contextWindow: 8_192,
					maxTokens: 1_024,
				},
			],
		});
	};
}

describe("TUI sign-in commands", () => {
	it.each(["regular", "fullscreen"] as const)(
		"saves an API key the TUI masked and kept out of the editor's history, and removes it (%s)",
		async (tuiMode) => {
			const login: TestLogin = { current: () => Promise.reject(new Error("No login")) };
			const { harness, tui, access } = await start({ tuiMode, extension: signInProviders(login) });
			const authStorage = harness.startup.session.modelRegistry.authStorage;

			void tui.submit("/login");
			await choose(tui, "Use an API key");
			await waitForScreen(tui, "Select provider to configure:");
			tui.terminal.sendInput("test-keyed");
			await waitForScreen(tui, "test-keyed");
			tui.terminal.sendInput("\r");
			await waitForScreen(tui, "API key for test-keyed");
			tui.terminal.sendInput(SECRET);
			const typing = await renderedScreen(tui);
			expect(typing).not.toContain(SECRET);
			expect(typing).toContain("•".repeat(SECRET.length));
			tui.terminal.sendInput("\r");
			await waitForScreen(tui, "Saved API key for test-keyed. Credentials saved to");
			expect(authStorage.get("test-keyed")).toEqual({ type: "api_key", key: SECRET });
			expect(tui.screen()).not.toContain(SECRET);

			// The key never reached the editor or its history.
			expect(access.defaultEditor.getText()).toBe("");
			tui.terminal.sendInput("\x1b[A");
			await renderedScreen(tui);
			expect(access.defaultEditor.getText()).not.toContain(SECRET);

			access.defaultEditor.setText("");
			void tui.submit("/logout");
			await waitForScreen(tui, "Select provider to logout:");
			tui.terminal.sendInput("test-keyed");
			await waitForScreen(tui, "test-keyed");
			tui.terminal.sendInput("\r");
			await waitForScreen(tui, "Removed stored API key for test-keyed.");
			expect(authStorage.get("test-keyed")).toBeUndefined();
		},
	);

	it("signs in through a provider_auth sign-in page it opens only as https, then shows subscription usage", async () => {
		const login: TestLogin = {
			current: async (callbacks) => {
				callbacks.onAuth({ url: "https://sub.invalid/authorize?client=volt", instructions: "Authorize Volt" });
				const code = await callbacks.onPrompt({ message: "Paste the authorization code" });
				return { access: `token-${code}`, refresh: "refresh", expires: Date.now() + 3_600_000 };
			},
		};
		const { harness, tui } = await start({ extension: signInProviders(login) });

		await tui.submit("/usage");
		await waitForScreen(tui, "No subscription login is configured.");

		void tui.submit("/login");
		await choose(tui, "Use a subscription");
		await waitForScreen(tui, "Select provider to configure:");
		tui.terminal.sendInput("Test Subscription");
		await waitForScreen(tui, "Test Subscription");
		tui.terminal.sendInput("\r");
		await waitForScreen(
			tui,
			"Login to Test Subscription",
			"https://sub.invalid/authorize?client=volt",
			"Authorize Volt",
			"Paste the authorization code",
		);
		expect(openBrowser).toHaveBeenCalledExactlyOnceWith("https://sub.invalid/authorize?client=volt");
		tui.terminal.sendInput("abc123");
		tui.terminal.sendInput("\r");
		await waitForScreen(tui, "Logged in to Test Subscription. Credentials saved to");
		expect(tui.screen()).not.toContain("Login to Test Subscription");
		expect(harness.startup.session.modelRegistry.authStorage.get("test-sub")).toMatchObject({
			type: "oauth",
			access: "token-abc123",
		});

		await tui.submit("/usage");
		await waitForScreen(tui, "Subscription Usage", "Test Subscription · Pro Plus", "Weekly: 75% remaining");
	});

	it("answers a pasted sign-in code, or the sign-in's cancellation, to a provider_auth request it did not start", async () => {
		const { harness, tui } = await start();
		const live = harness.startup.liveState;
		// The TUI's client, as its host attached it: the anchor of the conversation it shows.
		const client = harness.host.clientsOf(harness.connector.conversation).find((attached) => attached.anchor)?.id;
		if (client === undefined) throw new Error("The TUI's client is not attached");
		const ask = (url: string) =>
			live.request({ kind: "provider_auth", provider: "acme", flow: "manual", url }, { client });

		const pasted = ask("https://acme.invalid/login");
		await waitForScreen(tui, "Login to acme", "https://acme.invalid/login", "Paste redirect URL below");
		tui.terminal.sendInput("http://localhost/callback?code=xyz");
		tui.terminal.sendInput("\r");
		expect(await pasted).toMatchObject({
			status: "answered",
			response: { value: "http://localhost/callback?code=xyz" },
		});

		// Only a sign-in /login started opens its page; only an http or https address shows as one.
		expect(openBrowser).not.toHaveBeenCalled();
		const cancelled = ask("file:///etc/passwd");
		await waitForScreen(tui, "The sign-in address is not an http or https URL.");
		tui.terminal.sendInput(ESC);
		expect(await cancelled).toMatchObject({ status: "answered", response: { cancelled: true } });
		await vi.waitFor(async () => expect(await renderedScreen(tui)).not.toContain("Login to acme"));
	});
});

describe("TUI status commands", () => {
	it("shows language server health from the host's lsp.status, and restarts lazily", async () => {
		const { tui } = await start();
		await tui.submit("/lsp");
		await waitForScreen(tui, "LSP Health", "LSP is disabled. Enable with --lsp or lsp.enabled=true.");
		await tui.submit("/lsp restart");
		await waitForScreen(tui, "LSP is disabled. Run with --lsp or set lsp.enabled=true in settings.");

		const status: QueryResult<"lsp.status"> = {
			enabled: true,
			workspaceRoot: "/workspace",
			servers: [
				{
					name: "typescript",
					workspaceRoot: "/workspace",
					root: "/workspace",
					alive: true,
					openDocuments: 2,
					idleMs: 61_000,
					resolvedExecutable: "/usr/bin/tsserver",
					launchSource: "path",
					attempts: 1,
					state: "ready",
					version: "5.9.0",
					capabilities: ["hover", "definition"],
					breaker: "closed",
					operations: 4,
					failures: 0,
				},
				{
					name: "sourcekit",
					workspaceRoot: "/workspace",
					root: "/workspace",
					alive: false,
					openDocuments: 0,
					idleMs: 0,
					launchSource: "toolchain",
					attempts: 0,
					state: "unused",
					projectContext: "swiftpm-detected",
				},
			],
		};
		const client = tui.store.client;
		const query = client.query.bind(client);
		vi.spyOn(client, "query").mockImplementation(((name: string, params?: unknown) =>
			name === "lsp.status"
				? Promise.resolve(status)
				: query(name as "models", params as undefined)) as typeof client.query);
		const restart = vi.spyOn(client, "intent");
		await tui.submit("/lsp");
		await waitForScreen(
			tui,
			"typescript ready · version 5.9.0 · breaker closed",
			"Capabilities: hover, definition",
			"idle 1m 1s",
			"sourcekit unused · capabilities unknown; not started",
			"Project context: swiftpm-detected",
		);
		expect(restart).not.toHaveBeenCalled();
	});

	it("says MCP is not configured, from the host's mcp.servers", async () => {
		const { tui } = await start();
		await tui.submit("/mcp");
		await waitForScreen(tui, "MCP is not configured.");
	});

	it("lists, disables, enables, and details extensions through the host", async () => {
		const { tui } = await start({
			extensions: [
				{
					manifest: { id: "demo-ext", displayName: "Demo Extension", description: "A demo" },
					factory: () => {},
				},
			],
		});
		const state = async () =>
			(await tui.store.client.query("extensions")).extensions.find((extension) => extension.id === "demo-ext");
		await tui.submit("/extensions disable demo-ext");
		await waitForScreen(tui, "Disabled demo-ext");
		expect(await state()).toMatchObject({ enabled: false });
		await tui.submit("/extensions enable demo-ext");
		await waitForScreen(tui, "Enabled demo-ext");
		expect(await state()).toMatchObject({ enabled: true, state: "active" });

		void tui.submit("/extensions");
		await choose(tui, "Demo Extension (demo-ext) · enabled");
		await choose(tui, "Details");
		await waitForScreen(tui, "Demo Extension", "A demo");
		tui.terminal.sendInput(ESC);
		await tui.submit("/extensions missing-ext");
		await waitForScreen(tui, 'No extension "missing-ext" in this conversation');
	});

	it("captures diagnostics with F12 and /debug without stopping a turn, and reports a failed capture", async () => {
		const { harness, tui, access } = await start();
		const turn = heldTurn("Done");
		harness.faux.setResponses([turn.response]);
		await tui.submit("Keep working");
		await turn.started;
		access.defaultEditor.setText("draft");
		tui.terminal.sendInput("\x1b[24~");
		await waitForScreen(tui, "✓ Tool progress captured", join(harness.tempDir, "debug", "tool-progress-latest.json"));
		expect(access.defaultEditor.getText()).toBe("draft");
		vi.spyOn(harness.startup.session, "captureToolProgressDiagnostics").mockRejectedValueOnce(
			new Error("fixture capture failure"),
		);
		await tui.submit("/debug");
		await waitForScreen(tui, "Failed to write debug log: fixture capture failure");
		expect(tui.store.phase?.operation).toBe("turn");
		turn.release();
		await vi.waitFor(() => expect(tui.store.phase?.operation ?? null).toBeNull());
	});
});

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, stdio: "pipe" });
}

/** A repository with one commit and an uncommitted change in the harness's temp dir. */
function reviewRepository(cwd: string): void {
	mkdirSync(join(cwd, "src"), { recursive: true });
	git(cwd, "init", "--initial-branch=main");
	git(cwd, "config", "user.email", "review@example.com");
	git(cwd, "config", "user.name", "Review Test");
	git(cwd, "config", "commit.gpgsign", "false");
	writeFileSync(join(cwd, "src", "value.ts"), "export const value = 1;\n");
	git(cwd, "add", ".");
	git(cwd, "commit", "-m", "Add the value");
	writeFileSync(join(cwd, "src", "value.ts"), "export const value = 2;\n");
}

/** The review's discovery and verification passes, reporting nothing. */
function quietReview() {
	return [
		fauxAssistantMessage(
			fauxToolCall("report_review_candidates", { summary: "No candidates.", candidates: [], limitations: [] }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(
			fauxToolCall("report_review_verification", {
				summary: "Nothing to verify.",
				assessment: "complete",
				decisions: [],
				priorFindingDecisions: [],
				limitations: [],
			}),
			{ stopReason: "toolUse" },
		),
	];
}

describe("TUI reviews", () => {
	it.each(["regular", "fullscreen"] as const)(
		"shows the review in the job list, and opens its findings when it completes there (%s)",
		async (tuiMode) => {
			const { harness, tui } = await start({ tuiMode });
			reviewRepository(harness.tempDir);
			const discovery = Promise.withResolvers<void>();
			const [candidates, verification] = quietReview();
			harness.faux.setResponses([
				async () => {
					await discovery.promise;
					return candidates!;
				},
				verification!,
			]);
			const source = tui.store.conversation;

			// The command returns once the review started; the job list is on it, with its progress.
			await tui.submit("/review uncommitted");
			await waitForScreen(tui, "Review uncommitted changes", "Discovery pass");
			expect(tui.store.conversation).toBe(source);
			discovery.resolve();
			await vi.waitFor(() => expect(tui.store.conversation).not.toBe(source), { timeout: 10_000 });
			await waitForScreen(tui, "Uncommitted changes", "Static review only.");
		},
	);

	it("leaves a completed review's findings to /work when the job list was closed before it ended", async () => {
		const { harness, tui, access } = await start();
		reviewRepository(harness.tempDir);
		const discovery = Promise.withResolvers<void>();
		const [candidates, verification] = quietReview();
		harness.faux.setResponses([
			async () => {
				await discovery.promise;
				return candidates!;
			},
			verification!,
		]);
		const source = tui.store.conversation;
		const intent = vi.spyOn(tui.store.client, "intent");

		await tui.submit("/review uncommitted");
		await waitForScreen(tui, "Discovery pass");
		// Close the list: the conversation is the user's again, and the footer's work line follows the review.
		access.dismissWorkInspector?.();
		await waitForScreen(tui, "Work · ● running · review");
		access.defaultEditor.setText("typing while it runs");
		await waitForScreen(tui, "typing while it runs");
		discovery.resolve();
		await waitForScreen(tui, "Review uncommitted changes completed");
		// Nothing opens or moves: opening the findings is a round trip, so give one the time to show itself.
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(intent.mock.calls.filter(([name]) => name === "review_open_session")).toEqual([]);
		expect(tui.store.conversation).toBe(source);
		const work = [...tui.store.state.work.values()].find((item) => item.kind === "review");
		expect(work).toMatchObject({ outcome: "completed" });
		// The findings open from the item in /work.
		const opened = await tui.store.client.intent("review_open_session", { runId: work!.workId });
		expect(opened.conversation).toBeDefined();
	});

	it("cancels the review's work from the job list", async () => {
		const { harness, tui, access } = await start();
		reviewRepository(harness.tempDir);
		const discovery = heldTurn("never");
		harness.faux.setResponses([discovery.response]);
		const source = tui.store.conversation;
		const intent = vi.spyOn(tui.store.client, "intent");

		await tui.submit("/review uncommitted");
		await discovery.started;
		await waitForScreen(tui, "Review uncommitted changes", "Discovery pass");
		// Ctrl+K asks, and Enter confirms.
		tui.terminal.sendInput("\x0b");
		await waitForScreen(tui, "Cancel this work?");
		tui.terminal.sendInput("\r");
		await vi.waitFor(() => {
			const work = [...tui.store.state.work.values()].find((item) => item.kind === "review");
			expect(work).toMatchObject({ outcome: "cancelled" });
		});
		expect(tui.store.conversation).toBe(source);
		access.dismissWorkInspector?.();
		await waitForScreen(tui, "Review uncommitted changes cancelled");
		// A cancelled review has no findings to open, and the list showing it does not try.
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(intent.mock.calls.filter(([name]) => name === "review_open_session")).toEqual([]);
		access.defaultEditor.setText("after the review");
		await waitForScreen(tui, "after the review");
	});

	it("runs several reviews at once, each its own work", async () => {
		const { harness, tui } = await start();
		reviewRepository(harness.tempDir);
		const first = heldTurn("never");
		const second = heldTurn("never");
		harness.faux.setResponses([first.response, second.response]);

		await tui.submit("/review uncommitted");
		await first.started;
		(tui.mode as unknown as ModeAccess).dismissWorkInspector?.();
		await tui.submit("/review uncommitted --focus second");
		await second.started;
		const running = [...tui.store.state.work.values()].filter(
			(item) => item.kind === "review" && item.outcome === undefined,
		);
		expect(running).toHaveLength(2);
		await stopReviews(tui);
		await vi.waitFor(() =>
			expect(
				[...tui.store.state.work.values()].filter((item) => item.kind === "review").map((item) => item.outcome),
			).toEqual(["cancelled", "cancelled"]),
		);
	});

	it("offers base branches and recent commits from the host's review completions", async () => {
		const { harness, tui } = await start();
		reviewRepository(harness.tempDir);
		git(harness.tempDir, "checkout", "-q", "-b", "topic");
		git(harness.tempDir, "commit", "-q", "-am", "Change the value");
		const discovery = heldTurn("never");
		harness.faux.setResponses([discovery.response]);
		const review = tui.submit("/review");
		await choose(tui, "Against base branch");
		await choose(tui, "main");
		// The pickers are followed by one form for the options; Enter starts with their defaults.
		await waitForScreen(tui, "Review options");
		tui.terminal.sendInput("\r");
		await discovery.started;
		await waitForScreen(tui, "Discovery pass");
		await stopReviews(tui);
		await review;

		const commit = tui.submit("/review commit");
		await waitForScreen(tui, "Review which commit?", "Add the value");
		tui.terminal.sendInput(ESC);
		await commit;
		await waitForScreen(tui, "Review cancelled");
	});

	/** The inputs the TUI sent to the review intent. */
	const reviewInputs = (intent: { mock: { calls: unknown[][] } }): unknown[] =>
		intent.mock.calls.filter(([name]) => name === "review").map(([, input]) => input);

	it("asks for the options in one form after the target, and starts with the ones it changed", async () => {
		const { harness, tui } = await start();
		reviewRepository(harness.tempDir);
		const discovery = heldTurn("never");
		harness.faux.setResponses([discovery.response]);
		const intent = vi.spyOn(tui.store.client, "intent");

		const review = tui.submit("/review");
		await choose(tui, "Uncommitted changes");
		await waitForScreen(
			tui,
			"Review options",
			"Focus",
			"Scope",
			"Effort",
			"standard",
			"Include optional findings",
			"Scope mode",
			"incremental",
		);
		const DOWN = "\x1b[B";
		const RIGHT = "\x1b[C";
		tui.terminal.sendInput("auth");
		tui.terminal.sendInput(DOWN);
		tui.terminal.sendInput("src/**");
		tui.terminal.sendInput(DOWN);
		// Effort: standard to high.
		tui.terminal.sendInput(RIGHT);
		tui.terminal.sendInput(DOWN);
		tui.terminal.sendInput(RIGHT);
		tui.terminal.sendInput(DOWN);
		// Scope mode: incremental to full.
		tui.terminal.sendInput(RIGHT);
		tui.terminal.sendInput("\r");
		await discovery.started;
		await closeJobList(tui);
		await waitForScreen(tui, "Equivalent command: /review uncommitted --focus auth");
		expect(reviewInputs(intent)).toEqual([
			{
				target: "uncommitted",
				focus: "auth",
				scope: "src/**",
				effort: "high",
				includeOptional: true,
				scopeMode: "full",
			},
		]);
		await stopReviews(tui);
		await review;
	});

	it("starts with no extra fields when the form is submitted as it opened", async () => {
		const { harness, tui } = await start();
		reviewRepository(harness.tempDir);
		const discovery = heldTurn("never");
		harness.faux.setResponses([discovery.response]);
		const intent = vi.spyOn(tui.store.client, "intent");

		const review = tui.submit("/review");
		await choose(tui, "Uncommitted changes");
		await waitForScreen(tui, "Review options");
		tui.terminal.sendInput("\r");
		await discovery.started;
		await closeJobList(tui);
		await waitForScreen(tui, "Equivalent command: /review uncommitted");
		expect(reviewInputs(intent)).toEqual([{ target: "uncommitted" }]);
		await stopReviews(tui);
		await review;
	});

	it("cancels the review when the options form is cancelled", async () => {
		const { harness, tui, access } = await start();
		reviewRepository(harness.tempDir);
		const intent = vi.spyOn(tui.store.client, "intent");

		const review = tui.submit("/review");
		await choose(tui, "Uncommitted changes");
		await waitForScreen(tui, "Review options");
		tui.terminal.sendInput(ESC);
		await review;
		await waitForScreen(tui, "Review cancelled");
		expect(reviewInputs(intent)).toEqual([]);
		// The editor is back.
		access.defaultEditor.setText("after the form");
		await waitForScreen(tui, "after the form");
	});

	it("skips the pickers and the form when the command line says everything", async () => {
		const { harness, tui } = await start();
		reviewRepository(harness.tempDir);
		git(harness.tempDir, "checkout", "-q", "-b", "topic");
		git(harness.tempDir, "commit", "-q", "-am", "Change the value");
		const discovery = heldTurn("never");
		harness.faux.setResponses([discovery.response]);
		const intent = vi.spyOn(tui.store.client, "intent");

		const review = tui.submit('/review branch main --effort high --scope "src/**"');
		await discovery.started;
		expect(tui.screen()).not.toContain("Review options");
		expect(tui.screen()).not.toContain("Equivalent command");
		expect(reviewInputs(intent)).toEqual([{ target: "branch", base: "main", effort: "high", scope: "src/**" }]);
		await stopReviews(tui);
		await review;
	});

	it("keeps /review tools local, and refuses arguments after it", async () => {
		const { tui } = await start();
		const intent = vi.spyOn(tui.store.client, "intent");

		const tools = tui.submit("/review tools");
		await waitForScreen(tui, "Auxiliary review tools");
		tui.terminal.sendInput(ESC);
		await tools;
		await waitForScreen(tui, "Review tool selection cancelled");

		await tui.submit("/review tools now");
		await waitForScreen(tui, 'Unexpected arguments after "tools"', "Usage: /review");
		expect(reviewInputs(intent)).toEqual([]);
	});

	it("shows a bad flag with the usage line, and starts nothing", async () => {
		const { tui } = await start();
		const intent = vi.spyOn(tui.store.client, "intent");

		await tui.submit("/review uncommitted --effort extreme");
		await waitForScreen(tui, "--effort must be low, standard, or high", "Usage: /review");
		await tui.submit("/review uncommitted --tools bash");
		await waitForScreen(tui, 'Unknown or misplaced argument "--tools"');
		expect(reviewInputs(intent)).toEqual([]);
	});

	it("says so when the host does not describe how /review reads its arguments, or describes it wrongly", async () => {
		const { tui, access } = await start();
		const intent = vi.spyOn(tui.store.client, "intent");
		const real = access.input.catalog;
		const withReview = (change: (descriptor: IntentDescriptor) => IntentDescriptor | undefined) =>
			vi.spyOn(access.input, "catalog", "get").mockReturnValue({
				...real,
				intents: real.intents.flatMap((i) => (i.name === "review" ? (change(i) ?? []) : [i])),
			});
		vi.spyOn(access.input, "load").mockResolvedValue(false);

		withReview(() => undefined);
		await tui.submit("/review uncommitted");
		await waitForScreen(tui, "does not describe how /review reads its arguments");

		withReview((descriptor) => {
			const input = structuredClone(descriptor.input) as { "x-volt-command": { keyword: { field: string } } };
			input["x-volt-command"].keyword.field = "nope";
			return { ...descriptor, input };
		});
		await tui.submit("/review uncommitted");
		await waitForScreen(tui, "describes /review wrongly", "not a property of the input");
		expect(reviewInputs(intent)).toEqual([]);
	});

	describe("on an extension's engine", () => {
		const ENGINE = "ext:test-extension/swarm";

		/** What each run of the extension's engine was given, and a way to hold it until it is told to finish. */
		function swarmExtension() {
			const runs: Array<{ params: Readonly<Record<string, unknown>>; workId: string }> = [];
			const entered = Promise.withResolvers<void>();
			const extension = (volt: ExtensionAPI): void => {
				volt.registerReviewEngine("swarm", {
					label: "Swarm",
					description: "Many reviewers.",
					cost: "Much slower than standard.",
					targets: ["uncommitted", "branch"],
					parameters: {
						type: "object",
						properties: {
							workers: { type: "integer", minimum: 1, maximum: 32, default: 30 },
							waveSize: { type: "integer", minimum: 1, maximum: 32 },
							thinking: { type: "string", enum: ["low", "high"], default: "high" },
						},
					},
					async run(ctx) {
						runs.push({ params: ctx.params, workId: ctx.workId });
						entered.resolve();
						ctx.progress({ text: "Wave 1 of 3" });
						await new Promise<void>((resolve) =>
							ctx.signal.addEventListener("abort", () => resolve(), { once: true }),
						);
					},
				});
			};
			return { extension, runs, entered: entered.promise };
		}

		it("asks which engine after the target, with what each costs, and adds its options to the form", async () => {
			const swarm = swarmExtension();
			const { harness, tui } = await start({ extension: swarm.extension });
			reviewRepository(harness.tempDir);
			const intent = vi.spyOn(tui.store.client, "intent");

			const review = tui.submit("/review");
			await choose(tui, "Uncommitted changes");
			// The standard review is the default, so it is first; each engine says what it costs.
			await waitForScreen(
				tui,
				"Review with which engine?",
				"Standard: the built-in review (default)",
				"Swarm: Many reviewers. Much slower than standard.",
			);
			await choose(tui, "Swarm: Many reviewers.");
			// The review's own options, then the engine's.
			await waitForScreen(tui, "Review options", "Focus", "Effort", "workers", "waveSize", "thinking");
			// Down through focus, scope, effort, optional findings, scope mode, workers, and wave size to thinking.
			for (let field = 0; field < 7; field++) tui.terminal.sendInput("\x1b[B");
			tui.terminal.sendInput("\x1b[D");
			tui.terminal.sendInput("\r");
			await swarm.entered;
			await closeJobList(tui);
			await waitForScreen(tui, "Equivalent command: /review uncommitted --engine swarm --thinking low");
			expect(reviewInputs(intent)).toEqual([
				{ target: "uncommitted", engine: ENGINE, engineParams: { thinking: "low" } },
			]);
			expect(swarm.runs[0]?.params).toEqual({ workers: 30, thinking: "low" });
			await stopReviews(tui);
			await review;
		});

		it("offers only the engines that review the chosen target, and no row when none does", async () => {
			const swarm = swarmExtension();
			const { harness, tui } = await start({ extension: swarm.extension });
			reviewRepository(harness.tempDir);

			// The engine reviews uncommitted changes and branches, not a commit: straight to the form.
			const review = tui.submit("/review");
			await choose(tui, "Specific commit");
			await choose(tui, "Add the value");
			await waitForScreen(tui, "Review options");
			expect(tui.screen()).not.toContain("Review with which engine?");
			tui.terminal.sendInput(ESC);
			await review;
			await waitForScreen(tui, "Review cancelled");
		});

		it("runs the engine the reviewEngine setting names, with its flags, unless the line says standard", async () => {
			const swarm = swarmExtension();
			const { harness, tui } = await start({
				extension: swarm.extension,
				globalSettings: { reviewEngine: "swarm" },
			});
			reviewRepository(harness.tempDir);
			const discovery = heldTurn("never");
			harness.faux.setResponses([discovery.response]);
			const intent = vi.spyOn(tui.store.client, "intent");

			// The engine's flags work without --engine, and the status line names where the engine came from.
			await tui.submit("/review uncommitted --workers 4");
			await swarm.entered;
			await closeJobList(tui);
			await waitForScreen(
				tui,
				"Reviewing with the Swarm engine (the reviewEngine setting). Much slower than standard.",
			);
			expect(reviewInputs(intent)).toEqual([
				{ target: "uncommitted", engine: ENGINE, engineParams: { workers: 4 } },
			]);
			await stopReviews(tui);

			// The line overrides the setting, and the engine's flags are then the review's own flags only.
			await tui.submit("/review uncommitted --engine standard --workers 4");
			await waitForScreen(tui, 'Unknown or misplaced argument "--workers"');
			await tui.submit("/review uncommitted --engine standard");
			await discovery.started;
			expect(reviewInputs(intent).at(-1)).toEqual({ target: "uncommitted" });
			await stopReviews(tui);
		});

		it("puts the engine the setting names first in the launcher", async () => {
			const swarm = swarmExtension();
			const { harness, tui } = await start({
				extension: swarm.extension,
				globalSettings: { reviewEngine: "swarm" },
			});
			reviewRepository(harness.tempDir);

			const review = tui.submit("/review");
			await choose(tui, "Uncommitted changes");
			await waitForScreen(tui, "Review with which engine?", "Much slower than standard. (default)");
			const lines = tui.screen().split("\n");
			const swarmRow = lines.findIndex((line) => line.includes("Swarm: Many reviewers."));
			const standardRow = lines.findIndex((line) => line.includes("Standard: the built-in review"));
			expect(swarmRow).toBeGreaterThan(-1);
			expect(swarmRow).toBeLessThan(standardRow);
			expect(lines[standardRow]).not.toContain("(default)");
			tui.terminal.sendInput(ESC);
			await review;
			await waitForScreen(tui, "Review cancelled");
		});

		it("warns and runs the standard engine when the setting names one the host does not offer", async () => {
			const swarm = swarmExtension();
			const { harness, tui } = await start({
				extension: swarm.extension,
				globalSettings: { reviewEngine: "nothing" },
			});
			reviewRepository(harness.tempDir);
			const discovery = heldTurn("never");
			harness.faux.setResponses([discovery.response]);
			const intent = vi.spyOn(tui.store.client, "intent");

			await tui.submit("/review uncommitted");
			await discovery.started;
			await closeJobList(tui);
			await waitForWrappedText(
				tui,
				'The reviewEngine setting names "nothing", which this host does not offer. Available: standard, swarm. Reviewing with the standard engine.',
			);
			expect(reviewInputs(intent)).toEqual([{ target: "uncommitted" }]);
			await stopReviews(tui);
		});

		it("starts the engine the line names, with its own flags, and sends no auxiliary tools", async () => {
			const swarm = swarmExtension();
			// A tool configured for the built-in review is not the engine's: its passes are its own.
			const { harness, tui } = await start({
				extension: swarm.extension,
				globalSettings: { reviewTools: ["bash"] },
			});
			reviewRepository(harness.tempDir);
			const intent = vi.spyOn(tui.store.client, "intent");

			const review = tui.submit("/review uncommitted --engine swarm --workers 4 --wave-size 2 --focus auth");
			await swarm.entered;
			await waitForScreen(tui, "Wave 1 of 3");
			expect(reviewInputs(intent)).toEqual([
				{ target: "uncommitted", engine: ENGINE, focus: "auth", engineParams: { workers: 4, waveSize: 2 } },
			]);
			expect(swarm.runs[0]?.params).toEqual({ workers: 4, waveSize: 2, thinking: "high" });
			await stopReviews(tui);
			await review;
			await vi.waitFor(() =>
				expect(harness.startup.session.work.get(swarm.runs[0]!.workId)).toMatchObject({ outcome: "cancelled" }),
			);
		});

		it("opens its findings in a new conversation, as any review's", async () => {
			const entered = Promise.withResolvers<void>();
			const { harness, tui } = await start({
				extension: (volt) => {
					volt.registerReviewEngine("quick", {
						label: "Quick",
						description: "Finds nothing.",
						targets: ["uncommitted"],
						async run(ctx) {
							entered.resolve();
							const hunks = ctx.changedFiles().flatMap((file) => file.hunks.map((hunk) => hunk.id));
							ctx.pass().diff(hunks, 64 * 1024);
							await ctx.submit({
								candidates: { summary: "Nothing found.", candidates: [], limitations: [] },
								verification: {
									summary: "Nothing to verify.",
									assessment: "complete",
									decisions: [],
									priorFindingDecisions: [],
									limitations: [],
								},
							});
						},
					});
				},
			});
			reviewRepository(harness.tempDir);
			const source = tui.store.conversation;

			void tui.submit("/review uncommitted --engine quick");
			await entered.promise;
			await vi.waitFor(() => expect(tui.store.conversation).not.toBe(source), { timeout: 10_000 });
			await waitForScreen(tui, "Uncommitted changes", "Static review only.");
		});

		it("names the engines the host offers when the line names one it does not, and runs standard the built-in way", async () => {
			const swarm = swarmExtension();
			const { harness, tui } = await start({ extension: swarm.extension });
			reviewRepository(harness.tempDir);
			const discovery = heldTurn("never");
			harness.faux.setResponses([discovery.response]);
			const intent = vi.spyOn(tui.store.client, "intent");

			await tui.submit("/review uncommitted --engine nothing");
			await waitForScreen(tui, 'Unknown review engine "nothing". Available: standard, swarm.');
			await tui.submit("/review uncommitted --engine swarm --colour red");
			await waitForScreen(tui, 'Unknown or misplaced argument "--colour"');
			// The engine's flags are not the built-in review's.
			await tui.submit("/review uncommitted --engine standard --workers 4");
			await waitForScreen(tui, 'Unknown or misplaced argument "--workers"');
			expect(reviewInputs(intent)).toEqual([]);
			expect(swarm.runs).toEqual([]);

			const review = tui.submit("/review uncommitted --engine standard");
			await discovery.started;
			expect(reviewInputs(intent)).toEqual([{ target: "uncommitted" }]);
			await stopReviews(tui);
			await review;
		});

		it("says what the engine refuses by name, before anything starts", async () => {
			const swarm = swarmExtension();
			const { harness, tui } = await start({ extension: swarm.extension });
			reviewRepository(harness.tempDir);
			await tui.submit("/review uncommitted --engine swarm --workers 99");
			await waitForScreen(tui, "--workers must be an integer from 1 to 32");
			await tui.submit("/review pr --engine swarm");
			await waitForScreen(tui, "The Swarm engine does not review a pr target");
			expect(swarm.runs).toEqual([]);
		});
	});

	it("reviews the branch together with its uncommitted changes", async () => {
		const { harness, tui } = await start();
		// A committed file on main, edited in the workspace: the branch has no commits of its own.
		reviewRepository(harness.tempDir);
		git(harness.tempDir, "checkout", "-q", "-b", "topic");
		const discovery = heldTurn("never");
		harness.faux.setResponses([discovery.response]);
		const intent = vi.spyOn(tui.store.client, "intent");

		const review = tui.submit("/review branch-uncommitted main");
		await discovery.started;
		await waitForScreen(tui, "Review branch and uncommitted changes");
		expect(intent).toHaveBeenCalledWith(
			"review",
			expect.objectContaining({ target: "branch_uncommitted", base: "main" }),
		);
		await stopReviews(tui);
		await review;
	});

	it("reviews with the configured auxiliary tools, and says which it omitted", async () => {
		const { harness, tui } = await start({ globalSettings: { reviewTools: ["bash", "missing-tool"] } });
		reviewRepository(harness.tempDir);
		const discovery = heldTurn("never");
		harness.faux.setResponses([discovery.response]);
		const intent = vi.spyOn(tui.store.client, "intent");

		const review = tui.submit("/review uncommitted");
		await discovery.started;
		await closeJobList(tui);
		await waitForScreen(tui, "Some configured auxiliary review tools are unavailable and were omitted.");
		expect(intent).toHaveBeenCalledWith(
			"review",
			expect.objectContaining({ target: "uncommitted", tools: ["bash"] }),
		);
		await stopReviews(tui);
		await review;
	});
});
