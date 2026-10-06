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
import type { QueryResult } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionFactory } from "../../src/core/extensions/index.ts";
import type { CustomEditor } from "../../src/modes/interactive/components/custom-editor.ts";
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
	transientUsage: unknown;
	keybindings: { getKeys(action: string): string[] };
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
		"shows the review work and its live pass, then opens its findings (%s)",
		async (tuiMode) => {
			const { harness, tui, access } = await start({ tuiMode });
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

			void tui.submit("/review uncommitted");
			await waitForScreen(tui, "Reviewing uncommitted changes with faux-1", "Discovery pass");
			// The footer shows the review's usage in place of the conversation's.
			expect(access.transientUsage).toMatchObject({ model: { provider: "faux", id: "faux-1" } });
			discovery.resolve();
			await vi.waitFor(() => expect(tui.store.conversation).not.toBe(source), { timeout: 10_000 });
			await waitForScreen(tui, "Uncommitted changes", "Static review only.");
			expect(tui.screen()).not.toContain("Reviewing uncommitted changes with faux-1");
			expect(access.transientUsage).toBeUndefined();
		},
	);

	it("cancels the review's work when Escape stops the loader", async () => {
		const { harness, tui, access } = await start();
		reviewRepository(harness.tempDir);
		const discovery = heldTurn("never");
		harness.faux.setResponses([discovery.response]);
		const source = tui.store.conversation;

		const review = tui.submit("/review uncommitted");
		await discovery.started;
		await waitForScreen(tui, "Reviewing uncommitted changes with faux-1");
		tui.terminal.sendInput(ESC);
		await review;
		await waitForScreen(tui, "Review uncommitted changes cancelled");
		expect(tui.store.conversation).toBe(source);
		const work = [...tui.store.state.work.values()].find((item) => item.kind === "review");
		expect(work).toMatchObject({ outcome: "cancelled" });
		expect(access.transientUsage).toBeUndefined();
		// The editor is back.
		access.defaultEditor.setText("after the review");
		await waitForScreen(tui, "after the review");
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
		await discovery.started;
		await waitForScreen(tui, "Reviewing");
		tui.terminal.sendInput(ESC);
		await review;

		const commit = tui.submit("/review commit");
		await waitForScreen(tui, "Review which commit?", "Add the value");
		tui.terminal.sendInput(ESC);
		await commit;
		await waitForScreen(tui, "Review cancelled");
	});

	it("refuses a second review while one runs, and reviews with the configured auxiliary tools", async () => {
		const { harness, tui } = await start({ globalSettings: { reviewTools: ["bash", "missing-tool"] } });
		reviewRepository(harness.tempDir);
		const discovery = heldTurn("never");
		harness.faux.setResponses([discovery.response]);
		const intent = vi.spyOn(tui.store.client, "intent");

		const review = tui.submit("/review uncommitted");
		await discovery.started;
		await waitForScreen(tui, "Some configured auxiliary review tools are unavailable and were omitted.");
		expect(intent).toHaveBeenCalledWith("review_uncommitted", expect.objectContaining({ tools: ["bash"] }));
		await tui.submit("/review uncommitted");
		await waitForScreen(tui, "A review is already running. Cancel it before starting another.");
		tui.terminal.sendInput(ESC);
		await review;
	});
});
