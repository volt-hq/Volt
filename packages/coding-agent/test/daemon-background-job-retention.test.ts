import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createIrohRemotePresetAccess } from "../src/core/remote/iroh/access-grant.ts";
import { IrohRemoteActiveStreamRegistry } from "../src/core/remote/iroh/active-stream-registry.ts";
import { IrohRemoteAuditLogger } from "../src/core/remote/iroh/audit.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../src/core/remote/iroh/authorization.ts";
import type { IrohRemoteHandshakeSuccess, IrohRemoteHello } from "../src/core/remote/iroh/handshake.ts";
import { IrohRemoteHostStateManager } from "../src/core/remote/iroh/state-manager.ts";
import { IntegratedRuntimeRegistry } from "../src/daemon/integrated-runtimes.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.useRealTimers();
});

describe("daemon background job retention", () => {
	it.each([true, false])(
		"retains a detached runtime until jobs settle and the full TTL elapses (active at detach: %s)",
		async (activeAtDetach) => {
			let finish!: () => void;
			const finished = new Promise<void>((resolve) => {
				finish = resolve;
			});
			const session = {
				sessionId: "retained-background-session",
				isBusy: false,
				hasBackgroundJobs: activeAtDetach,
				waitForIdle: vi.fn(async () => {}),
				waitForBackgroundJobs: vi.fn(async () => {
					await finished;
					session.hasBackgroundJobs = false;
				}),
				abort: vi.fn(async () => {}),
			};
			const dispose = vi.fn(async () => {});
			const runtime = { cwd: process.cwd(), session, dispose } as unknown as AgentSessionRuntime;
			const registry = new IntegratedRuntimeRegistry({
				auditLogger: new IrohRemoteAuditLogger({ sink: { write: () => {} } }),
				stateManager: new IrohRemoteHostStateManager(),
				activeStreams: new IrohRemoteActiveStreamRegistry(),
				detachedRuntimeTtlMs: () => 1000,
				getProjectTrustedForWorkspace: () => false,
				setClientLastSessionId: async () => undefined,
				createRuntime: async () => ({
					runtime,
					sessionSelection: {
						kind: "resumed",
						requestedSessionId: session.sessionId,
						sessionId: session.sessionId,
					},
				}),
			});
			cleanups.push(async () => {
				finish();
				await registry.stopAll("test_cleanup");
			});
			const authorization: IrohRemoteClientAuthorizationSuccess = {
				ok: true,
				allowTools: "bash,jobs",
				paired: false,
				pairingSecretConsumed: false,
				client: {
					nodeId: "phone",
					label: "phone",
					allowedWorkspaces: ["workspace"],
					allowedTools: "bash,jobs",
					rpcGrant: createIrohRemotePresetAccess("full").rpcGrant,
					pairedAt: 1,
					lastSeenAt: 2,
				},
				workspace: { name: "workspace", path: process.cwd() },
				workspaceNames: ["workspace"],
				workspaces: [{ name: "workspace", status: "available" }],
			};
			const prepared = await registry.getOrCreateEntry(
				{
					hello: {
						type: "volt_iroh_hello",
						protocol: "volt-rpc/0",
						workspace: "workspace",
						mode: "conversation",
						conversation: { target: "session", sessionId: session.sessionId },
					} as IrohRemoteHello,
					response: {} as IrohRemoteHandshakeSuccess,
				},
				authorization,
			);
			const { entry, attachClaim, sessionSelection } = prepared;
			await registry.commitEntry(entry, sessionSelection, authorization, attachClaim);
			attachClaim.release();

			vi.useFakeTimers();
			await registry.detachWithoutSubscriber(entry, attachClaim, "phone_detached");
			if (!activeAtDetach) {
				await vi.advanceTimersByTimeAsync(500);
				session.hasBackgroundJobs = true;
			}
			await vi.advanceTimersByTimeAsync(5000);
			expect(session.waitForBackgroundJobs).toHaveBeenCalledTimes(1);
			expect(session.waitForIdle).toHaveBeenCalledTimes(1);
			expect(session.abort).not.toHaveBeenCalled();
			expect(dispose).not.toHaveBeenCalled();
			expect(registry.findOwner("workspace", session.sessionId)).toBe(entry);
			expect(entry.lifecycle).toBe("active");

			finish();
			await vi.advanceTimersByTimeAsync(999);
			expect(dispose).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(dispose).toHaveBeenCalledTimes(1);
			expect(registry.findOwner("workspace", session.sessionId)).toBeUndefined();
			expect(session.abort).not.toHaveBeenCalled();
		},
	);
});
