import { Buffer } from "node:buffer";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HostFrame, INTENT_SCHEMAS, QUERY_SCHEMAS } from "@hansjm10/volt-protocol";
import { Compile } from "typebox/compile";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { ConversationHost } from "../../../src/core/host/conversation-host.ts";
import type { AuthorityLoss } from "../../../src/core/protocol/server/connection.ts";
import {
	createIrohRemoteRpcGrant,
	getIrohRemoteStreamCapability,
	type IrohRemoteRpcCapability,
} from "../../../src/core/remote/iroh/access-grant.ts";
import { IrohRemoteAuditLogger } from "../../../src/core/remote/iroh/audit.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../../../src/core/remote/iroh/authorization.ts";
import { serveIrohRemoteConnection } from "../../../src/core/remote/iroh/connection.ts";
import {
	createIrohRemoteHandshakeSuccess,
	parseIrohRemoteHandshakeResponse,
	parseIrohRemoteHello,
} from "../../../src/core/remote/iroh/handshake.ts";
import {
	type IrohRemotePrReviewRpcBackend,
	PrReviewPreparationError,
	type PrReviewPullRequest,
} from "../../../src/core/remote/iroh/pr-review-rpc.ts";
import { IROH_REMOTE_HOST_FEATURES } from "../../../src/core/remote/iroh/protocol.ts";
import { createEmptyIrohRemoteHostState } from "../../../src/core/remote/iroh/state.ts";
import { IrohRemoteHostStateManager } from "../../../src/core/remote/iroh/state-manager.ts";
import type { IrohRemoteWorktreeRpcBackend } from "../../../src/core/remote/iroh/worktree-rpc.ts";
import {
	type RemoteIntentHost,
	type RemoteStreamScope,
	remoteIntentServices,
	remoteStreamAllows,
} from "../../../src/daemon/remote-intents.ts";
import { createIrohStreamPair } from "../../utilities/iroh-stream-pair.ts";
import { connectRemotePhone, type QueryOutcome, type RemotePhone } from "../../utilities/remote-phone.ts";
import { createHostHarness } from "../host-harness.ts";

const pullRequest: PrReviewPullRequest = {
	provider: "github",
	url: "https://github.com/volt-hq/Volt/pull/414",
	number: 414,
	title: "Isolated PR review",
	repository: "volt-hq/Volt",
	headRefName: "feature/review",
	headRefOid: "a".repeat(40),
};
const prepareInput = {
	sessionId: "review-414",
	expectedPullRequest: { url: pullRequest.url, headRefOid: pullRequest.headRefOid },
};
const allCapabilities: IrohRemoteRpcCapability[] = [
	"conversation.observe.v1",
	"conversation.control.v1",
	"worktrees.manage.v1",
];
const review: RemoteStreamScope = { kind: "discovery", purpose: "review" };
const manageWorktrees: RemoteStreamScope = { kind: "management", purpose: "manage_worktrees" };
const resolveParams = Compile(QUERY_SCHEMAS.pr_review.params);
const resolveResult = Compile(QUERY_SCHEMAS.pr_review.result);
const prepareParams = Compile(INTENT_SCHEMAS.prepare_pr_review.input);
const prepareResult = Compile(INTENT_SCHEMAS.prepare_pr_review.output);

function backend() {
	return {
		resolvePrReview: vi.fn<IrohRemotePrReviewRpcBackend["resolvePrReview"]>(async (workspaceName) => ({
			workspaceName,
			pullRequest,
		})),
		preparePrReview: vi.fn<IrohRemotePrReviewRpcBackend["preparePrReview"]>(async (workspaceName, request) => ({
			workspaceName,
			sessionId: request.sessionId,
			worktreeId: "pr-414",
			pullRequest,
			disposition: "created" as const,
		})),
	} satisfies IrohRemotePrReviewRpcBackend;
}

let workspacePath: string;
beforeAll(() => {
	workspacePath = realpathSync(mkdtempSync(join(tmpdir(), "volt-414-rpc-")));
});
afterAll(() => {
	if (workspacePath) rmSync(workspacePath, { recursive: true, force: true });
});
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const worktrees: IrohRemoteWorktreeRpcBackend = {
	createWorktree: async () => {
		throw new Error("unexpected create");
	},
	listWorktrees: async () => ({ ok: true, worktrees: [] }),
	removeWorktree: async () => {
		throw new Error("unexpected remove");
	},
};

interface StreamOptions {
	prReviews?: IrohRemotePrReviewRpcBackend;
	capabilities?: IrohRemoteRpcCapability[];
	revalidate?: () => Promise<boolean>;
	authority?: () => AuthorityLoss | undefined;
	/** The host of a conversation stream's conversation. */
	conversationHost?: ConversationHost;
}

interface Stream {
	readonly device: RemotePhone;
	readonly phone: ReturnType<typeof createIrohStreamPair>["phone"];
}

/** A device stream of `scope`, as the daemon serves it: the remote profile with the daemon's remote services. */
async function stream(scope: RemoteStreamScope, options: StreamOptions = {}): Promise<Stream> {
	const grant = createIrohRemoteRpcGrant(options.capabilities ?? allCapabilities);
	const authorization: IrohRemoteClientAuthorizationSuccess = {
		ok: true,
		allowTools: "read",
		client: {
			nodeId: "phone",
			label: "phone",
			allowedWorkspaces: [],
			rpcGrant: grant,
			pairedAt: 1,
			lastSeenAt: 1,
		},
		paired: false,
		pairingSecretConsumed: false,
		workspace: { name: "volt", path: workspacePath },
		workspaceNames: ["volt"],
		workspaces: [{ name: "volt", status: "available" }],
	};
	const unexpected = (): never => {
		throw new Error("unexpected backend");
	};
	const auditLogger = new IrohRemoteAuditLogger();
	const host: RemoteIntentHost = {
		agentDir: workspacePath,
		auditLogger,
		stateManager: new IrohRemoteHostStateManager({ initialState: createEmptyIrohRemoteHostState() }),
		pushTargets: () => ({ register: unexpected }),
		worktrees: () => worktrees,
		agentOptions: unexpected,
		sessionContexts: unexpected,
		prReviews: () => options.prReviews ?? unexpected(),
		unregisterWorkspace: unexpected,
	};
	const allows = remoteStreamAllows(scope);
	const conversation = scope.kind === "conversation" ? scope.conversation : undefined;
	const pair = createIrohStreamPair();
	const connection = serveIrohRemoteConnection({
		...(conversation === undefined || options.conversationHost === undefined
			? {}
			: { conversation, host: options.conversationHost }),
		stream: pair.host,
		grant,
		redaction: { workspacePath, remoteWorkspacePath: "/workspace" },
		...(conversation === undefined ? {} : { redirect: {} }),
		services: () => remoteIntentServices(host, authorization, scope, { keep: {} }),
		...(allows === undefined ? {} : { allows }),
		...(options.revalidate === undefined ? {} : { revalidate: options.revalidate }),
		...(options.authority === undefined ? {} : { authority: options.authority }),
	});
	const device = connectRemotePhone(pair.phone);
	cleanups.push(async () => {
		await connection.close().catch(() => undefined);
		await device.close();
		await auditLogger.flush();
	});
	await device.hello();
	return { device, phone: pair.phone };
}

/** A host workspace operation is not a branch intent: no position. */
function prepare(device: RemotePhone, input: object) {
	return device.intent("prepare_pr_review", input, { expectedOrdinal: null });
}

function resolve(device: RemotePhone, params: object = {}): Promise<QueryOutcome> {
	return device.query("pr_review", params);
}

describe("#414 PR review utility transport", () => {
	test("round trips review discovery handshakes without feature opt-ins", () => {
		const hello = parseIrohRemoteHello({
			type: "volt_iroh_hello",
			protocol: "volt/1",
			workspace: "volt",
			workspaceDiscovery: { purpose: "review" },
		});
		expect(hello).toMatchObject({ mode: "workspaceDiscovery", workspaceDiscovery: { purpose: "review" } });
		const success = createIrohRemoteHandshakeSuccess({
			workspace: "volt",
			hostNodeId: "host",
			clientNodeId: "phone",
			features: [...IROH_REMOTE_HOST_FEATURES],
			workspaceDiscovery: { purpose: "review" },
		});
		expect(parseIrohRemoteHandshakeResponse(success)).toMatchObject({ workspaceDiscovery: { purpose: "review" } });
		expect(() =>
			parseIrohRemoteHello({
				type: "volt_iroh_hello",
				protocol: "volt/1",
				workspace: "volt",
				workspaceDiscovery: { purpose: "review", path: "/private" },
			}),
		).toThrow();
		expect(getIrohRemoteStreamCapability({ mode: "workspaceDiscovery", purpose: "review" })).toBe(
			"conversation.observe.v1",
		);
	});

	test.each(["0", "01", "+1", " 1", "1 ", "1.0", "1e2", "2147483648", "9999999999", "1\n"])(
		"rejects noncanonical/out-of-range PR number %j",
		async (number) => {
			const host = backend();
			expect(resolveParams.Check({ number })).toBe(false);
			const { device } = await stream(review, { prReviews: host });
			expect(await resolve(device, { number })).toMatchObject({
				type: "query_error",
				reason: { code: "invalid_input" },
			});
			expect(host.resolvePrReview).not.toHaveBeenCalled();
		},
	);

	test.each(["1", "999999999", "1000000000", "2147483640", "2147483647"])(
		"accepts bounded PR decimal %s",
		(number) => {
			expect(resolveParams.Check({ number })).toBe(true);
		},
	);

	test.each([
		{ workingDirectory: "../escape" },
		{ workingDirectory: "/absolute" },
		{ workingDirectory: "C:drive" },
		{ workingDirectory: "folder\\child" },
		{ workingDirectory: "a//b" },
		{ workingDirectory: "a/./b" },
		{ workingDirectory: "a/.GiT/b" },
		{ workingDirectory: "a\n" },
		{ workingDirectory: "" },
		{ workingDirectory: "a".repeat(4097) },
		{ sourceWorktreeId: "../escape" },
		{ sourceWorktreeId: "UPPER" },
		{ sourceWorktreeId: "a".repeat(65) },
		{ sourceWorktreeId: "source", workingDirectory: "folder" },
		{ number: null },
		{ path: "/host/path" },
	])("rejects invalid source payload %j", async (fields) => {
		const host = backend();
		expect(resolveParams.Check(fields)).toBe(false);
		const { device } = await stream(review, { prReviews: host });
		expect(await resolve(device, fields)).toMatchObject({
			type: "query_error",
			reason: { code: "invalid_input" },
		});
		expect(host.resolvePrReview).not.toHaveBeenCalled();
	});

	test.each([
		{ sessionId: "UPPER" },
		{ sessionId: "a".repeat(129) },
		{ sessionId: "" },
		{ expectedPullRequest: { url: pullRequest.url, headRefOid: "A".repeat(40) } },
		{ expectedPullRequest: { url: pullRequest.url, headRefOid: "a".repeat(41) } },
		{ expectedPullRequest: { url: pullRequest.url, headRefOid: "a".repeat(39) } },
		{ expectedPullRequest: { url: pullRequest.url, headRefOid: "a".repeat(40), path: "/secret" } },
	])("validates preparation identity %j", async (fields) => {
		const host = backend();
		expect(prepareParams.Check({ ...prepareInput, ...fields })).toBe(false);
		const { device } = await stream(manageWorktrees, { prReviews: host });
		expect(await prepare(device, { ...prepareInput, ...fields })).toMatchObject({
			type: "rejected",
			reason: { code: "invalid_input" },
		});
		expect(host.preparePrReview).not.toHaveBeenCalled();
	});

	test("admits lowercase SHA-256 OIDs and rejects naming another workspace before backend access", async () => {
		expect(
			prepareParams.Check({
				...prepareInput,
				expectedPullRequest: { url: pullRequest.url, headRefOid: "b".repeat(64) },
			}),
		).toBe(true);
		const host = backend();
		// The stream's workspace is implied: a device cannot name another one.
		const { device } = await stream(review, { prReviews: host });
		expect(await resolve(device, { workspaceName: "other" })).toMatchObject({
			type: "query_error",
			reason: { code: "invalid_input" },
		});
		expect(host.resolvePrReview).not.toHaveBeenCalled();
	});

	test("projects only allowlisted backend fields and redacts workspace text", async () => {
		const host = backend();
		host.resolvePrReview.mockResolvedValue(
			Object.assign(
				{
					workspaceName: "volt",
					pullRequest: Object.assign(
						{
							...pullRequest,
							title: `Review ${workspacePath}/file.ts`,
						},
						{ path: "/private/other", body: "private context" },
					),
				},
				{ checkoutPath: "/private/checkout" },
			),
		);
		const { device } = await stream(review, { prReviews: host });
		const outcome = await resolve(device, { workingDirectory: "nested/repo", number: "414" });
		expect(host.resolvePrReview).toHaveBeenCalledWith("volt", { workingDirectory: "nested/repo", number: "414" });
		expect(outcome).toEqual({
			type: "result",
			queryId: outcome.queryId,
			data: { workspaceName: "volt", pullRequest: { ...pullRequest, title: "Review /workspace/file.ts" } },
		});
		if (outcome.type !== "result") throw new Error("Expected a result");
		expect(resolveResult.Check(outcome.data)).toBe(true);
		expect(JSON.stringify(device.frames)).not.toContain("/private");
	});

	test.each(["created", "reused"] as const)(
		"returns %s preparation using a source worktree without leaking backend paths",
		async (disposition) => {
			const host = backend();
			host.preparePrReview.mockImplementation(async (workspaceName, request) =>
				Object.assign(
					{
						workspaceName,
						sessionId: request.sessionId,
						worktreeId: "pr-414",
						pullRequest,
						disposition,
						workingDirectory: "nested/repo",
					},
					{ path: "/private/checkout" },
				),
			);
			const { device } = await stream(manageWorktrees, { prReviews: host });
			const outcome = await prepare(device, { ...prepareInput, sourceWorktreeId: "source" });
			expect(host.preparePrReview).toHaveBeenCalledWith("volt", {
				sourceWorktreeId: "source",
				sessionId: "review-414",
				expectedPullRequest: prepareInput.expectedPullRequest,
			});
			expect(outcome).toEqual({
				type: "accepted",
				intentId: outcome.intentId,
				ordinals: [],
				result: {
					workspaceName: "volt",
					sessionId: "review-414",
					worktreeId: "pr-414",
					workingDirectory: "nested/repo",
					pullRequest,
					disposition,
				},
			});
			if (outcome.type !== "accepted") throw new Error("Expected acceptance");
			expect(prepareResult.Check(outcome.result)).toBe(true);
			expect(JSON.stringify(device.frames)).not.toContain("/private");
		},
	);

	test.each(["review_preparation_failed", "review_preparation_stale", "review_preparation_conflict"] as const)(
		"returns stable %s without backend diagnostic text",
		async (code) => {
			const host = backend();
			host.preparePrReview.mockRejectedValue(new PrReviewPreparationError(code, "/secret/checkout git stderr"));
			const { device } = await stream(manageWorktrees, { prReviews: host });
			expect(await prepare(device, prepareInput)).toMatchObject({
				type: "rejected",
				reason: { code: "failed", message: code },
			});
			expect(JSON.stringify(device.frames)).not.toContain("stderr");
		},
	);

	test("maps unknown failures and malformed backend placement to preparation_failed", async () => {
		const host = backend();
		host.resolvePrReview.mockRejectedValue(new Error("/secret/path"));
		const discovery = await stream(review, { prReviews: host });
		expect(await resolve(discovery.device)).toMatchObject({
			type: "query_error",
			reason: { code: "failed", message: "review_preparation_failed" },
		});
		host.preparePrReview.mockResolvedValue({
			workspaceName: "volt",
			sessionId: "different",
			worktreeId: "pr-414",
			pullRequest,
			disposition: "created",
		});
		const management = await stream(manageWorktrees, { prReviews: host });
		expect(await prepare(management.device, prepareInput)).toMatchObject({
			type: "rejected",
			reason: { code: "failed", message: "review_preparation_failed" },
		});
		expect(JSON.stringify([...discovery.device.frames, ...management.device.frames])).not.toContain("/secret");
	});

	test("requires observe for discovery and both control and worktree management for preparation", async () => {
		const host = backend();
		const discovery = await stream(review, { prReviews: host, capabilities: [] });
		expect(await resolve(discovery.device)).toMatchObject({
			type: "query_error",
			reason: { code: "not_allowed", requiredCapability: "conversation.observe.v1" },
		});
		for (const capability of ["conversation.control.v1", "worktrees.manage.v1"] as const) {
			const management = await stream(manageWorktrees, {
				prReviews: host,
				capabilities: allCapabilities.filter((entry) => entry !== capability),
			});
			expect(await prepare(management.device, prepareInput)).toMatchObject({
				type: "rejected",
				reason: { code: "not_allowed", requiredCapability: capability },
			});
		}
		expect(host.resolvePrReview).not.toHaveBeenCalled();
		expect(host.preparePrReview).not.toHaveBeenCalled();
	});

	test.each(["resolve", "prepare"] as const)(
		"checks grant freshness before and after asynchronous %s",
		async (kind) => {
			const scope = kind === "resolve" ? review : manageWorktrees;
			const send = (device: RemotePhone): void => {
				if (kind === "resolve") device.send({ type: "query", queryId: "q-1", query: "pr_review", params: {} });
				else device.send({ type: "prepare_pr_review", intentId: "i-1", input: prepareInput });
			};
			const outcomes = (device: RemotePhone): HostFrame[] =>
				device.frames.filter(
					(frame) =>
						frame.type === "result" ||
						frame.type === "query_error" ||
						frame.type === "accepted" ||
						frame.type === "rejected",
				);

			// The grant changed while the backend ran: the outcome is withheld and the stream ends revoked.
			const host = backend();
			let loss: AuthorityLoss | undefined;
			const revoke = async () => {
				loss = "revoked";
			};
			host.resolvePrReview.mockImplementationOnce(async (workspaceName) => {
				await revoke();
				return { workspaceName, pullRequest };
			});
			host.preparePrReview.mockImplementationOnce(async (workspaceName, request) => {
				await revoke();
				return {
					workspaceName,
					sessionId: request.sessionId,
					worktreeId: "pr-414",
					pullRequest,
					disposition: "created",
				};
			});
			const revalidate = vi.fn(async () => true);
			const changed = await stream(scope, { prReviews: host, revalidate, authority: () => loss });
			send(changed.device);
			await changed.device.ended;
			expect(revalidate).toHaveBeenCalledOnce();
			expect(kind === "resolve" ? host.resolvePrReview : host.preparePrReview).toHaveBeenCalledOnce();
			expect(outcomes(changed.device)).toEqual([]);
			expect(changed.device.frames.at(-1)).toMatchObject({ type: "fatal", code: "revoked" });

			// A stale grant never reaches the backend.
			const untouched = backend();
			const stale = await stream(scope, { prReviews: untouched, revalidate: async () => false });
			send(stale.device);
			await stale.device.ended;
			expect(untouched.resolvePrReview).not.toHaveBeenCalled();
			expect(untouched.preparePrReview).not.toHaveBeenCalled();
			expect(outcomes(stale.device)).toEqual([]);
			expect(stale.device.frames.at(-1)).toMatchObject({ type: "fatal", code: "revoked" });
		},
	);

	test("rejects preparation on discovery, unrelated management and conversation streams", async () => {
		const host = backend();
		const discovery = await stream(review, { prReviews: host });
		expect(await prepare(discovery.device, prepareInput)).toMatchObject({
			type: "rejected",
			reason: { code: "unavailable" },
		});
		const management = await stream(
			{ kind: "management", purpose: "list_workspace_directories" },
			{ prReviews: host },
		);
		expect(await prepare(management.device, prepareInput)).toMatchObject({
			type: "rejected",
			reason: { code: "unavailable" },
		});
		const wrongDirection = await stream(manageWorktrees, { prReviews: host });
		expect(await resolve(wrongDirection.device)).toMatchObject({
			type: "query_error",
			reason: { code: "unavailable" },
		});

		const harness = await createHostHarness({ whenUnattached: "keep" });
		cleanups.push(() => harness.cleanup());
		const conversation = await harness.openStartup();
		const conversationStream = await stream(
			{ kind: "conversation", conversation },
			{ prReviews: host, conversationHost: harness.host },
		);
		expect(await resolve(conversationStream.device)).toMatchObject({
			type: "query_error",
			reason: { code: "unavailable" },
		});
		expect(await prepare(conversationStream.device, prepareInput)).toMatchObject({
			type: "rejected",
			reason: { code: "unavailable" },
		});
		expect(host.preparePrReview).not.toHaveBeenCalled();
		expect(host.resolvePrReview).not.toHaveBeenCalled();
	});

	test("keeps worktree listing usable on the worktree management stream", async () => {
		const { device } = await stream(manageWorktrees, { prReviews: backend() });
		expect(await device.query("worktrees")).toMatchObject({ type: "result", data: { worktrees: [] } });
	});

	test("does not dispatch a trailing partial JSONL frame", async () => {
		const host = backend();
		const { device, phone } = await stream(review, { prReviews: host });
		await phone.send.writeAll(
			Array.from(Buffer.from(JSON.stringify({ type: "query", queryId: "q-1", query: "pr_review" }), "utf8")),
		);
		await phone.send.finish?.();
		await device.ended;
		expect(host.resolvePrReview).not.toHaveBeenCalled();
		expect(device.frames.filter((frame) => frame.type === "result" || frame.type === "query_error")).toEqual([]);
	});
});
