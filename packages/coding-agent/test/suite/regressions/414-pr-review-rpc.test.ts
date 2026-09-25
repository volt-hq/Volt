import { Buffer } from "node:buffer";
import { Compile } from "typebox/compile";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
	createIrohRemoteRpcGrant,
	getIrohRemoteRpcCommandCapabilities,
	getIrohRemoteStreamCapability,
	type IrohRemoteRpcCapability,
} from "../../../src/core/remote/iroh/access-grant.ts";
import { IrohRemoteAuditLogger } from "../../../src/core/remote/iroh/audit.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../../../src/core/remote/iroh/authorization.ts";
import {
	createIrohRemoteHandshakeSuccess,
	parseIrohRemoteHandshakeResponse,
	parseIrohRemoteHello,
} from "../../../src/core/remote/iroh/handshake.ts";
import {
	handleIrohRemotePrReviewRpcCommand,
	type IrohRemotePrReviewRpcBackend,
	PrReviewPreparationError,
	type PrReviewPullRequest,
} from "../../../src/core/remote/iroh/pr-review-rpc.ts";
import { IROH_REMOTE_HOST_FEATURES } from "../../../src/core/remote/iroh/protocol.ts";
import { getStaticIrohRemoteRpcFilterResult } from "../../../src/core/remote/iroh/rpc-command-filter.ts";
import type { IrohRemoteWorktreeRpcBackend } from "../../../src/core/remote/iroh/worktree-rpc.ts";
import { RPC_COMMAND_SCHEMAS } from "../../../src/core/rpc/schema/commands.ts";
import { RPC_RESPONSE_SCHEMAS } from "../../../src/core/rpc/schema/responses.ts";
import {
	runWorkspaceDiscoveryStream,
	runWorkspaceManagementStream,
	runWorktreeManagementStream,
	type WorkspaceStreamContext,
	type WorkspaceStreamHooks,
} from "../../../src/daemon/workspace-streams.ts";
import { createHarness, type Harness } from "../harness.ts";

const pullRequest: PrReviewPullRequest = {
	provider: "github",
	url: "https://github.com/volt-hq/Volt/pull/414",
	number: 414,
	title: "Isolated PR review",
	repository: "volt-hq/Volt",
	headRefName: "feature/review",
	headRefOid: "a".repeat(40),
};
const resolveCommand = { id: "resolve-1", type: "resolve_pr_review", workspaceName: "volt" };
const prepareCommand = {
	id: "prepare-1",
	type: "prepare_pr_review",
	workspaceName: "volt",
	sessionId: "review-414",
	expectedPullRequest: { url: pullRequest.url, headRefOid: pullRequest.headRefOid },
};
const allCapabilities: IrohRemoteRpcCapability[] = [
	"conversation.observe.v1",
	"conversation.control.v1",
	"worktrees.manage.v1",
];

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

let harness: Harness;
beforeAll(async () => {
	harness = await createHarness();
});
afterAll(async () => {
	await harness?.cleanupAsync();
});

function streamContext(commands: object[], capabilities = allCapabilities) {
	const responses: unknown[] = [];
	const authorization: IrohRemoteClientAuthorizationSuccess = {
		ok: true,
		allowTools: "read",
		client: {
			nodeId: "phone",
			label: "phone",
			allowedWorkspaces: [],
			rpcGrant: createIrohRemoteRpcGrant(capabilities),
			pairedAt: 1,
			lastSeenAt: 1,
		},
		paired: false,
		pairingSecretConsumed: false,
		workspace: { name: "volt", path: harness.tempDir },
		workspaceNames: ["volt"],
		workspaces: [{ name: "volt", status: "available" }],
	};
	const context = {
		stream: {
			recv: { read: async () => undefined },
			send: {
				writeAll: async (bytes: number[]) => {
					responses.push(JSON.parse(Buffer.from(bytes).toString("utf8")));
				},
			},
		},
		initialInput: Buffer.from(commands.map((command) => `${JSON.stringify(command)}\n`).join("")),
		authorization,
		isRpcGrantCurrent: vi.fn(() => true),
		closeStream: vi.fn(),
	} satisfies WorkspaceStreamContext;
	return { context, responses };
}

const worktrees: IrohRemoteWorktreeRpcBackend = {
	createWorktree: async () => {
		throw new Error("unexpected create");
	},
	listWorktrees: async () => ({ ok: true, worktrees: [] }),
	removeWorktree: async () => {
		throw new Error("unexpected remove");
	},
};
const auditLogger = new IrohRemoteAuditLogger();

describe("#414 PR review utility transport", () => {
	test("round trips review discovery handshakes without feature opt-ins", () => {
		const hello = parseIrohRemoteHello({
			type: "volt_iroh_hello",
			protocol: "volt-rpc/0",
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
				protocol: "volt-rpc/0",
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
			const command = { ...resolveCommand, number };
			expect(Compile(RPC_COMMAND_SCHEMAS.resolve_pr_review).Check(command)).toBe(false);
			expect(
				await handleIrohRemotePrReviewRpcCommand(command, { authorizedWorkspaceName: "volt", backend: host }),
			).toMatchObject({
				handled: true,
				response: { success: false, error: "invalid_request" },
			});
			expect(host.resolvePrReview).not.toHaveBeenCalled();
		},
	);

	test.each(["1", "999999999", "1000000000", "2147483640", "2147483647"])(
		"accepts bounded PR decimal %s",
		(number) => {
			expect(Compile(RPC_COMMAND_SCHEMAS.resolve_pr_review).Check({ ...resolveCommand, number })).toBe(true);
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
		{ workspaceName: "a".repeat(256) },
		{ number: null },
		{ path: "/host/path" },
		{ id: "a".repeat(257) },
	])("rejects invalid source payload %j", async (fields) => {
		const host = backend();
		const command = { ...resolveCommand, ...fields };
		expect(Compile(RPC_COMMAND_SCHEMAS.resolve_pr_review).Check(command)).toBe(false);
		expect(
			await handleIrohRemotePrReviewRpcCommand(command, { authorizedWorkspaceName: "volt", backend: host }),
		).toMatchObject({
			response: { success: false, error: "invalid_request" },
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
	])("validates preparation identity %j", (fields) => {
		expect(Compile(RPC_COMMAND_SCHEMAS.prepare_pr_review).Check({ ...prepareCommand, ...fields })).toBe(false);
	});

	test("admits lowercase SHA-256 OIDs and rejects a different workspace before backend access", async () => {
		expect(
			Compile(RPC_COMMAND_SCHEMAS.prepare_pr_review).Check({
				...prepareCommand,
				expectedPullRequest: { url: pullRequest.url, headRefOid: "b".repeat(64) },
			}),
		).toBe(true);
		const host = backend();
		expect(
			await handleIrohRemotePrReviewRpcCommand(
				{ ...resolveCommand, workspaceName: "other" },
				{
					authorizedWorkspaceName: "volt",
					backend: host,
				},
			),
		).toMatchObject({ response: { error: "session_mismatch" } });
		expect(host.resolvePrReview).not.toHaveBeenCalled();
	});

	test("projects only allowlisted backend fields and sanitizes workspace text", async () => {
		const host = backend();
		host.resolvePrReview.mockResolvedValue(
			Object.assign(
				{
					workspaceName: "volt",
					pullRequest: Object.assign(
						{
							...pullRequest,
							title: `Review ${harness.tempDir}/file.ts`,
						},
						{ path: "/private/other", body: "private context" },
					),
				},
				{ checkoutPath: "/private/checkout" },
			),
		);
		const { context, responses } = streamContext([
			{ ...resolveCommand, workingDirectory: "nested/repo", number: "414" },
		]);
		await runWorkspaceDiscoveryStream(context, { purpose: "review", prReviews: host });
		expect(host.resolvePrReview).toHaveBeenCalledWith("volt", { workingDirectory: "nested/repo", number: "414" });
		expect(responses).toEqual([
			{
				id: "resolve-1",
				type: "response",
				command: "resolve_pr_review",
				success: true,
				data: { workspaceName: "volt", pullRequest: { ...pullRequest, title: "Review /workspace/file.ts" } },
			},
		]);
		expect(Compile(RPC_RESPONSE_SCHEMAS.resolve_pr_review).Check(responses[0])).toBe(true);
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
			const { context, responses } = streamContext([{ ...prepareCommand, sourceWorktreeId: "source" }]);
			await runWorktreeManagementStream(context, { auditLogger, worktrees, prReviews: host });
			expect(host.preparePrReview).toHaveBeenCalledWith("volt", {
				sourceWorktreeId: "source",
				sessionId: "review-414",
				expectedPullRequest: prepareCommand.expectedPullRequest,
			});
			expect(responses).toEqual([
				{
					id: "prepare-1",
					type: "response",
					command: "prepare_pr_review",
					success: true,
					data: {
						workspaceName: "volt",
						sessionId: "review-414",
						worktreeId: "pr-414",
						workingDirectory: "nested/repo",
						pullRequest,
						disposition,
					},
				},
			]);
			expect(Compile(RPC_RESPONSE_SCHEMAS.prepare_pr_review).Check(responses[0])).toBe(true);
		},
	);

	test.each(["review_preparation_failed", "review_preparation_stale", "review_preparation_conflict"] as const)(
		"returns stable %s without backend diagnostic text",
		async (code) => {
			const host = backend();
			host.preparePrReview.mockRejectedValue(new PrReviewPreparationError(code, "/secret/checkout git stderr"));
			expect(
				await handleIrohRemotePrReviewRpcCommand(prepareCommand, {
					authorizedWorkspaceName: "volt",
					backend: host,
				}),
			).toMatchObject({
				response: { success: false, error: code, errorCode: code },
			});
		},
	);

	test("maps unknown failures and malformed backend placement to preparation_failed", async () => {
		const host = backend();
		host.resolvePrReview.mockRejectedValue(new Error("/secret/path"));
		expect(
			await handleIrohRemotePrReviewRpcCommand(resolveCommand, { authorizedWorkspaceName: "volt", backend: host }),
		).toMatchObject({
			response: { error: "review_preparation_failed", errorCode: "review_preparation_failed" },
		});
		host.preparePrReview.mockResolvedValue({
			workspaceName: "volt",
			sessionId: "different",
			worktreeId: "pr-414",
			pullRequest,
			disposition: "created",
		});
		expect(
			await handleIrohRemotePrReviewRpcCommand(prepareCommand, { authorizedWorkspaceName: "volt", backend: host }),
		).toMatchObject({
			response: { error: "review_preparation_failed" },
		});
	});

	test("requires observe for discovery and both control and worktree management for preparation", async () => {
		expect(getIrohRemoteRpcCommandCapabilities(resolveCommand)).toEqual(["conversation.observe.v1"]);
		expect(getIrohRemoteRpcCommandCapabilities(prepareCommand)).toEqual([
			"conversation.control.v1",
			"worktrees.manage.v1",
		]);
		const host = backend();
		const discovery = streamContext([resolveCommand], []);
		await runWorkspaceDiscoveryStream(discovery.context, { purpose: "review", prReviews: host });
		expect(discovery.responses).toMatchObject([
			{ error: { code: "rpc_capability_denied", requiredCapability: "conversation.observe.v1" } },
		]);
		for (const capability of ["conversation.control.v1", "worktrees.manage.v1"] as const) {
			const management = streamContext(
				[prepareCommand],
				allCapabilities.filter((entry) => entry !== capability),
			);
			await runWorktreeManagementStream(management.context, { auditLogger, worktrees, prReviews: host });
			expect(management.responses).toMatchObject([
				{ error: { code: "rpc_capability_denied", requiredCapability: capability } },
			]);
		}
		expect(host.resolvePrReview).not.toHaveBeenCalled();
		expect(host.preparePrReview).not.toHaveBeenCalled();
	});

	test.each(["resolve", "prepare"] as const)(
		"checks grant freshness before and after asynchronous %s",
		async (kind) => {
			const host = backend();
			const { context, responses } = streamContext([kind === "resolve" ? resolveCommand : prepareCommand]);
			context.isRpcGrantCurrent.mockReturnValueOnce(true).mockReturnValue(false);
			if (kind === "resolve") await runWorkspaceDiscoveryStream(context, { purpose: "review", prReviews: host });
			else await runWorktreeManagementStream(context, { auditLogger, worktrees, prReviews: host });
			expect(context.isRpcGrantCurrent).toHaveBeenCalledTimes(2);
			expect(context.closeStream).toHaveBeenCalledWith("access_updated");
			expect(responses).toEqual([]);
			const stale = streamContext([kind === "resolve" ? resolveCommand : prepareCommand]);
			stale.context.isRpcGrantCurrent.mockReturnValue(false);
			const untouched = backend();
			if (kind === "resolve")
				await runWorkspaceDiscoveryStream(stale.context, { purpose: "review", prReviews: untouched });
			else await runWorktreeManagementStream(stale.context, { auditLogger, worktrees, prReviews: untouched });
			expect(untouched.resolvePrReview).not.toHaveBeenCalled();
			expect(untouched.preparePrReview).not.toHaveBeenCalled();
		},
	);

	test("rejects preparation on discovery, unrelated management and conversation streams", async () => {
		const host = backend();
		const discovery = streamContext([prepareCommand]);
		await runWorkspaceDiscoveryStream(discovery.context, { purpose: "review", prReviews: host });
		expect(discovery.responses).toMatchObject([{ error: "unsupported_on_workspace_discovery_stream" }]);
		const management = streamContext([prepareCommand]);
		const unrelatedHooks = { auditLogger } as WorkspaceStreamHooks;
		await runWorkspaceManagementStream(management.context, unrelatedHooks, "list_workspace_directories");
		expect(management.responses).toMatchObject([{ error: "unsupported_on_workspace_management_stream" }]);
		const wrongDirection = streamContext([resolveCommand]);
		await runWorktreeManagementStream(wrongDirection.context, { auditLogger, worktrees, prReviews: host });
		expect(wrongDirection.responses).toMatchObject([{ error: "unsupported_on_workspace_management_stream" }]);
		for (const command of [resolveCommand, prepareCommand]) {
			expect(getStaticIrohRemoteRpcFilterResult(JSON.stringify(command))).toMatchObject({ allowed: false });
		}
		expect(host.preparePrReview).not.toHaveBeenCalled();
		expect(host.resolvePrReview).not.toHaveBeenCalled();
	});

	test("keeps existing worktree utility commands usable without a PR review backend", async () => {
		const { context, responses } = streamContext([{ type: "list_worktrees", workspaceName: "volt" }, prepareCommand]);
		await runWorktreeManagementStream(context, { auditLogger, worktrees });
		expect(responses).toMatchObject([
			{ success: true, data: { worktrees: [] } },
			{ success: false, error: "unsupported_on_workspace_management_stream" },
		]);
	});

	test("does not dispatch a trailing partial JSONL command", async () => {
		const host = backend();
		const { context, responses } = streamContext([]);
		context.initialInput = Buffer.from(JSON.stringify(resolveCommand));
		await runWorkspaceDiscoveryStream(context, { purpose: "review", prReviews: host });
		expect(host.resolvePrReview).not.toHaveBeenCalled();
		expect(responses).toEqual([]);
	});
});
