import type { RenderSuspensionLease } from "@hansjm10/volt-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { HostedConversation } from "../src/core/host/hosted-conversation.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type SessionReplacementContext = {
	ui: {
		suspendRendering(): RenderSuspensionLease;
		requestRender(force?: boolean): void;
	};
	sessionRenderSuspension: RenderSuspensionLease | undefined;
	dismissSubagentInspector?: () => void;
	resetExtensionUI(): void;
	bindDaemonChangeObservation(session: AgentSession): void;
	observeLoss(conversation: HostedConversation): void;
	followSession(session: AgentSession): Promise<void>;
};

type InteractiveModeSessionReplacementPrototype = {
	beginSessionReplacementUi(this: SessionReplacementContext): void;
	followMove(this: SessionReplacementContext, to: HostedConversation): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModeSessionReplacementPrototype;

describe("InteractiveMode session replacement rendering", () => {
	it("suspends before the client leaves and releases once it follows the conversation it moved to", async () => {
		const order: string[] = [];
		const suspension: RenderSuspensionLease = {
			release: vi.fn(() => order.push("release")),
		};
		let finishRebind: () => void = () => undefined;
		const rebindPending = new Promise<void>((resolve) => {
			finishRebind = resolve;
		});
		const context: SessionReplacementContext = {
			ui: {
				suspendRendering: vi.fn(() => {
					order.push("suspend");
					return suspension;
				}),
				requestRender: vi.fn((force?: boolean) => order.push(`render:${String(force)}`)),
			},
			sessionRenderSuspension: undefined,
			dismissSubagentInspector: vi.fn(() => order.push("dismiss")),
			resetExtensionUI: vi.fn(() => order.push("reset")),
			bindDaemonChangeObservation: vi.fn(() => order.push("bind-change")),
			observeLoss: vi.fn(),
			followSession: vi.fn(async () => {
				order.push("rebind");
				await rebindPending;
			}),
		};
		const replacementSession = {} as AgentSession;
		const replacement = { session: replacementSession } as HostedConversation;

		interactiveModePrototype.beginSessionReplacementUi.call(context);
		expect(order).toEqual(["suspend", "dismiss", "reset"]);

		const moved = interactiveModePrototype.followMove.call(context, replacement);
		await Promise.resolve();
		expect(order).toEqual(["suspend", "dismiss", "reset", "bind-change", "rebind"]);

		finishRebind();
		await moved;

		expect(context.observeLoss).toHaveBeenCalledWith(replacement);
		expect(context.bindDaemonChangeObservation).toHaveBeenCalledWith(replacementSession);
		expect(context.followSession).toHaveBeenCalledWith(replacementSession);
		expect(order).toEqual(["suspend", "dismiss", "reset", "bind-change", "rebind", "render:true", "release"]);
		expect(context.sessionRenderSuspension).toBeUndefined();
	});

	it("retains the suspension when following the moved-to session fails", async () => {
		const rebindError = new Error("rebind failed");
		const suspension: RenderSuspensionLease = { release: vi.fn() };
		const context: SessionReplacementContext = {
			ui: {
				suspendRendering: vi.fn(() => suspension),
				requestRender: vi.fn(),
			},
			sessionRenderSuspension: suspension,
			resetExtensionUI: vi.fn(),
			bindDaemonChangeObservation: vi.fn(),
			observeLoss: vi.fn(),
			followSession: vi.fn(async () => {
				throw rebindError;
			}),
		};

		await expect(
			interactiveModePrototype.followMove.call(context, { session: {} as AgentSession } as HostedConversation),
		).rejects.toBe(rebindError);

		expect(context.bindDaemonChangeObservation).toHaveBeenCalledOnce();
		expect(context.ui.requestRender).not.toHaveBeenCalled();
		expect(suspension.release).not.toHaveBeenCalled();
		expect(context.sessionRenderSuspension).toBe(suspension);
	});
});
