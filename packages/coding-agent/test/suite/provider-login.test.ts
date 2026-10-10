/**
 * Provider sign-in on the host over loopback (`auth.providers`, `auth.login`,
 * `auth.logout`): an API key is asked as a secret input, and a subscription
 * login shows its sign-in as a `provider_auth` request, both of the invoking
 * client only; no other client sees or answers them, no frame carries the
 * key, and the models and providers catalogs follow. Test providers only.
 */

import type { OAuthCredentials, OAuthLoginCallbacks } from "@hansjm10/volt-ai";
import type { HostFrame, HostRequest } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLoopbackClient, type LoopbackClient, ProtocolRejectedError } from "../../src/client/protocol-client.ts";
import type { ExtensionAPI } from "../../src/core/extensions/index.ts";
import type { HostedConversation } from "../../src/core/host/hosted-conversation.ts";
import { createHostHarness, type HostHarness } from "./host-harness.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

const SECRET = "sk-test-not-a-real-key";

function testModels(id: string) {
	return [
		{
			id,
			name: id,
			reasoning: false,
			input: ["text" as const],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8_192,
			maxTokens: 1_024,
		},
	];
}

interface Setup {
	harness: HostHarness;
	conversation: HostedConversation;
	invoker: LoopbackClient;
	other: LoopbackClient;
	frames: HostFrame[];
	/** The subscription login the test provider runs. */
	setLogin(login: (callbacks: OAuthLoginCallbacks) => Promise<OAuthCredentials>): void;
}

async function setup(): Promise<Setup> {
	let login: (callbacks: OAuthLoginCallbacks) => Promise<OAuthCredentials> = () =>
		Promise.reject(new Error("No login set"));
	const harness = await createHostHarness({
		extension: (volt: ExtensionAPI) => {
			// A key provider the host has no credentials for.
			volt.registerProvider("test-keyed", {
				baseUrl: "https://keyed.invalid",
				apiKey: "$VOLT_TEST_UNSET_KEYED_API_KEY",
				api: "openai-completions",
				models: testModels("keyed-1"),
			});
			volt.registerProvider("test-sub", {
				baseUrl: "https://sub.invalid",
				api: "openai-completions",
				oauth: {
					name: "Test Subscription",
					login: (callbacks) => login(callbacks),
					refreshToken: async (credentials) => credentials,
					getApiKey: (credentials) => credentials.access,
				},
				models: testModels("sub-1"),
			});
		},
	});
	cleanups.push(() => harness.cleanup());
	const conversation = await harness.openStartup();
	const frames: HostFrame[] = [];
	const accepts = ["input", "select", "provider_auth"] as const;
	const invoker = await createLoopbackClient(harness.host, conversation, {
		hostRequests: accepts,
		onFrame: (frame) => frames.push(frame),
	});
	const other = await createLoopbackClient(harness.host, conversation, {
		anchor: false,
		hostRequests: accepts,
		onFrame: (frame) => frames.push(frame),
	});
	cleanups.push(async () => {
		await other.stop();
		await invoker.stop();
	});
	return {
		harness,
		conversation,
		invoker,
		other,
		frames,
		setLogin: (next) => {
			login = next;
		},
	};
}

/** The host requests a client holds, oldest first. */
function requests(client: LoopbackClient): Array<{ requestId: string; request: HostRequest }> {
	return [...client.live.values.values()].flatMap((value) =>
		value.kind === "host_request" ? [{ requestId: value.requestId, request: value.request }] : [],
	);
}

/** Wait until `client` holds a host request of `kind`. */
async function nextRequest(
	client: LoopbackClient,
	kind: HostRequest["kind"],
): Promise<{ requestId: string; request: HostRequest }> {
	let found: { requestId: string; request: HostRequest } | undefined;
	await vi.waitFor(() => {
		found = requests(client).find((entry) => entry.request.kind === kind);
		expect(found).toBeDefined();
	});
	return found!;
}

async function rejection(promise: Promise<unknown>): Promise<ProtocolRejectedError["reason"]> {
	const error = await promise.then(
		() => undefined,
		(caught: unknown) => caught,
	);
	if (!(error instanceof ProtocolRejectedError)) throw new Error(`Expected a rejection, got ${String(error)}`);
	return error.reason;
}

describe("auth.login with an API key", () => {
	it("asks only the invoking client for the key, stores it, and never sends it in a frame", async () => {
		const { conversation, invoker, other, frames } = await setup();
		const registry = conversation.session.modelRegistry;
		const before = (await invoker.query("auth.providers")).providers.find((provider) => provider.id === "test-keyed");
		expect(before).toEqual({ id: "test-keyed", name: "test-keyed", oauth: false, apiKey: true, configured: false });
		expect((await invoker.query("models")).models.some((model) => model.provider === "test-keyed")).toBe(false);

		const login = invoker.intent("auth.login", { provider: "test-keyed", method: "api_key" });
		const { requestId, request } = await nextRequest(invoker, "input");
		expect(request).toMatchObject({ kind: "input", title: "API key for test-keyed", secret: true });
		expect(requests(other)).toEqual([]);
		// Another client cannot answer it.
		other.answer(requestId, { value: "not-the-invoker" });
		await other.caughtUp();
		expect(requests(invoker).map((entry) => entry.requestId)).toEqual([requestId]);

		invoker.answer(requestId, { value: `  ${SECRET}  ` });
		expect((await login).result).toEqual({});
		expect(registry.authStorage.get("test-keyed")).toEqual({ type: "api_key", key: SECRET });
		await vi.waitFor(() => expect(requests(invoker)).toEqual([]));

		const after = (await invoker.query("auth.providers")).providers.find((provider) => provider.id === "test-keyed");
		expect(after).toEqual({
			id: "test-keyed",
			name: "test-keyed",
			oauth: false,
			apiKey: true,
			configured: true,
			source: "stored",
			stored: "api_key",
		});
		expect((await invoker.query("models")).models).toContainEqual(
			expect.objectContaining({ provider: "test-keyed", id: "keyed-1", auth: "api_key" }),
		);
		expect(frames).toContainEqual({ type: "changed", catalog: "models" });
		expect(JSON.stringify(frames)).not.toContain(SECRET);

		expect((await invoker.intent("auth.logout", { provider: "test-keyed" })).result).toEqual({ removed: "api_key" });
		expect(registry.authStorage.get("test-keyed")).toBeUndefined();
		for (const provider of ["test-keyed", "constructor", "__proto__"]) {
			expect(await rejection(invoker.intent("auth.logout", { provider })), provider).toMatchObject({
				code: "invalid_input",
			});
		}
	});

	it("is cancelled by the client, and refused without a client that answers it or for a provider without keys", async () => {
		const { harness, conversation, invoker } = await setup();
		const login = invoker.intent("auth.login", { provider: "test-keyed", method: "api_key" });
		const { requestId } = await nextRequest(invoker, "input");
		invoker.answer(requestId, { cancelled: true });
		expect((await login).result).toEqual({ cancelled: true });
		expect(conversation.session.modelRegistry.authStorage.get("test-keyed")).toBeUndefined();

		expect(await rejection(invoker.intent("auth.login", { provider: "test-sub", method: "api_key" }))).toMatchObject({
			code: "invalid_input",
		});
		expect(await rejection(invoker.intent("auth.login", { provider: "nowhere", method: "api_key" }))).toMatchObject({
			code: "invalid_input",
		});
		const silent = await createLoopbackClient(harness.host, conversation, { anchor: false });
		cleanups.push(() => silent.stop());
		expect(await rejection(silent.intent("auth.login", { provider: "test-keyed", method: "api_key" }))).toMatchObject(
			{
				code: "unavailable",
			},
		);
	});
});

describe("auth.login with a subscription", () => {
	it("shows the sign-in page and the provider's prompt to the invoking client, then stores the login", async () => {
		const { conversation, invoker, other, setLogin } = await setup();
		setLogin(async (callbacks) => {
			callbacks.onAuth({ url: "https://sub.invalid/authorize", instructions: "Sign in to continue" });
			const code = await callbacks.onPrompt({ message: "Paste the authorization code" });
			return { refresh: "refresh", access: `access-${code}`, expires: Date.now() + 3_600_000 };
		});
		const login = invoker.intent("auth.login", { provider: "test-sub", method: "oauth" });
		const signIn = await nextRequest(invoker, "provider_auth");
		expect(signIn.request).toEqual({
			kind: "provider_auth",
			provider: "test-sub",
			flow: "browser",
			url: "https://sub.invalid/authorize",
			instructions: "Sign in to continue",
		});
		// A sign-in page completes on the host: a client can only cancel it.
		invoker.answer(signIn.requestId, { value: "not-a-manual-flow" });
		const prompt = await nextRequest(invoker, "input");
		expect(prompt.request).toMatchObject({ kind: "input", title: "Paste the authorization code" });
		expect(prompt.request).not.toHaveProperty("secret");
		expect(requests(other)).toEqual([]);

		invoker.answer(prompt.requestId, { value: "code-1" });
		expect((await login).result).toEqual({});
		expect(conversation.session.modelRegistry.authStorage.get("test-sub")).toMatchObject({
			type: "oauth",
			access: "access-code-1",
		});
		await vi.waitFor(() => expect(requests(invoker)).toEqual([]));
		expect((await invoker.query("models")).models).toContainEqual(
			expect.objectContaining({ provider: "test-sub", id: "sub-1", auth: "oauth" }),
		);
		const provider = (await invoker.query("auth.providers")).providers.find((entry) => entry.id === "test-sub");
		expect(provider).toMatchObject({ name: "Test Subscription", oauth: true, apiKey: false, stored: "oauth" });
	});

	it("cancels a device sign-in the client dismisses, and stores nothing the provider finishes later", async () => {
		const { conversation, invoker, setLogin } = await setup();
		const finished = Promise.withResolvers<void>();
		setLogin(
			(callbacks) =>
				new Promise((resolve) => {
					callbacks.onDeviceCode({ userCode: "ABCD-1234", verificationUri: "https://sub.invalid/device" });
					// A provider that ignores the cancellation and finishes anyway.
					callbacks.signal?.addEventListener(
						"abort",
						() => {
							resolve({ refresh: "late", access: "late", expires: Date.now() + 3_600_000 });
							finished.resolve();
						},
						{ once: true },
					);
				}),
		);
		const login = invoker.intent("auth.login", { provider: "test-sub", method: "oauth" });
		const signIn = await nextRequest(invoker, "provider_auth");
		expect(signIn.request).toEqual({
			kind: "provider_auth",
			provider: "test-sub",
			flow: "device",
			url: "https://sub.invalid/device",
			userCode: "ABCD-1234",
		});
		invoker.answer(signIn.requestId, { cancelled: true });
		expect((await login).result).toEqual({ cancelled: true });
		await finished.promise;
		expect(conversation.session.modelRegistry.authStorage.get("test-sub")).toBeUndefined();
		await vi.waitFor(() => expect(requests(invoker)).toEqual([]));
	});

	it("cancels a sign-in whose client leaves, and refuses a sign-in page that is not a web address", async () => {
		const { harness, conversation, setLogin } = await setup();
		const leaving = await createLoopbackClient(harness.host, conversation, {
			anchor: false,
			hostRequests: ["provider_auth"],
		});
		const ended = Promise.withResolvers<void>();
		setLogin(
			(callbacks) =>
				new Promise((_resolve, reject) => {
					callbacks.onAuth({ url: "https://sub.invalid/authorize" });
					callbacks.signal?.addEventListener(
						"abort",
						() => {
							ended.resolve();
							reject(new Error("Login cancelled"));
						},
						{ once: true },
					);
				}),
		);
		const login = leaving.intent("auth.login", { provider: "test-sub", method: "oauth" });
		void login.catch(() => undefined);
		await nextRequest(leaving, "provider_auth");
		await leaving.stop();
		// Nobody can finish the sign-in: it ends at once instead of waiting for its timeout.
		await ended.promise;
		expect(conversation.liveState.pendingRequests()).toEqual([]);

		const { invoker, setLogin: setOther } = await setup();
		setOther(async (callbacks) => {
			callbacks.onAuth({ url: "file:///etc/passwd" });
			return { refresh: "r", access: "a", expires: Date.now() + 3_600_000 };
		});
		expect(await rejection(invoker.intent("auth.login", { provider: "test-sub", method: "oauth" }))).toMatchObject({
			code: "failed",
			message: "The provider's sign-in address is not an http or https URL",
		});
	});

	it("answers the queries and intents sent while a sign-in waits for the user", async () => {
		const { conversation, invoker, setLogin } = await setup();
		const finish = Promise.withResolvers<void>();
		setLogin(async (callbacks) => {
			callbacks.onAuth({ url: "https://sub.invalid/authorize" });
			await finish.promise;
			return { refresh: "refresh", access: "access", expires: Date.now() + 3_600_000 };
		});
		const login = invoker.intent("auth.login", { provider: "test-sub", method: "oauth" });
		void login.catch(() => undefined);
		await nextRequest(invoker, "provider_auth");
		// Each answers while the sign-in waits; more of them, over time, than a connection holds for its lane (256).
		for (let index = 0; index < 300; index++) {
			if (index % 2 === 0) expect((await invoker.query("settings")).profile).toBeDefined();
			else expect((await invoker.query("conversation_info")).cwd).toBeDefined();
		}
		expect((await invoker.intent("set_session_name", { name: "while signing in" })).type).toBe("accepted");
		expect(conversation.session.modelRegistry.authStorage.get("test-sub")).toBeUndefined();

		finish.resolve();
		expect((await login).result).toEqual({});
		expect(conversation.session.modelRegistry.authStorage.get("test-sub")).toMatchObject({ type: "oauth" });
	});

	it("takes a pasted redirect URL as the answer to a manual sign-in", async () => {
		const { conversation, invoker } = await setup();
		let pasted: string | undefined;
		conversation.session.modelRegistry.client.registerOAuthProvider({
			id: "test-callback",
			name: "Test Callback",
			usesCallbackServer: true,
			login: async (callbacks) => {
				callbacks.onAuth({ url: "https://callback.invalid/authorize" });
				pasted = await callbacks.onManualCodeInput?.();
				return { refresh: "refresh", access: "access", expires: Date.now() + 3_600_000 };
			},
			refreshToken: async (credentials) => credentials,
			getApiKey: (credentials) => credentials.access,
		});
		const login = invoker.intent("auth.login", { provider: "test-callback", method: "oauth" });
		const signIn = await nextRequest(invoker, "provider_auth");
		expect(signIn.request).toMatchObject({ flow: "manual", url: "https://callback.invalid/authorize" });
		invoker.answer(signIn.requestId, { value: "http://localhost/callback?code=pasted" });
		expect((await login).result).toEqual({});
		expect(pasted).toBe("http://localhost/callback?code=pasted");
		expect(conversation.session.modelRegistry.authStorage.get("test-callback")).toMatchObject({ type: "oauth" });
	});
});
