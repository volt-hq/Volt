/** Host-owned, ephemeral continuation proposals. Never queue one behind other input. */
import { setImmediate } from "node:timers/promises";
import type { AgentSettledEvent, ExtensionRunner } from "../extensions/index.ts";
import type { SessionPromptingHost } from "./prompting.ts";

export interface SettlementScope {
	readonly controller: AbortController;
	readonly runner: ExtensionRunner;
	readonly abortRevision: number;
	readonly runRevision: number;
	readonly runSignal: AbortSignal | undefined;
	inputRevision: number;
	readonly assertBranch: () => void;
}

export class SessionContinuations {
	private readonly host: SessionPromptingHost;
	private readonly scopes = new Set<SettlementScope>();
	private readonly pending = new Set<Promise<void>>();
	private inputRevision = 0;
	private runRevision = 0;
	private preparing = 0;

	constructor(host: SessionPromptingHost) {
		this.host = host;
	}

	/** Input invalidates proposals synchronously, before any input hook or persistence await. */
	input(scope?: SettlementScope): () => void {
		this.inputRevision++;
		for (const other of this.scopes) {
			if (other !== scope) other.controller.abort("superseded");
		}
		if (scope) scope.inputRevision = this.inputRevision;
		this.preparing++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.preparing--;
		};
	}

	invalidate(reason: "aborted" | "superseded"): void {
		for (const scope of this.scopes) scope.controller.abort(reason);
	}

	capture(): SettlementScope {
		const scope: SettlementScope = {
			controller: new AbortController(),
			runner: this.host.extensionRunner(),
			abortRevision: this.host.abortGeneration(),
			runRevision: ++this.runRevision,
			runSignal: this.host.conversation().operation?.signal,
			inputRevision: this.inputRevision,
			assertBranch: this.host.captureGenerationAssertion(),
		};
		this.scopes.add(scope);
		return scope;
	}

	private current(scope: SettlementScope): boolean {
		try {
			scope.assertBranch();
			return (
				!scope.controller.signal.aborted &&
				!this.host.lifetimeSignal.aborted &&
				scope.runner === this.host.extensionRunner() &&
				scope.abortRevision === this.host.abortGeneration() &&
				scope.runRevision === this.runRevision &&
				scope.inputRevision === this.inputRevision &&
				this.host.admissionGate.isOpen &&
				this.host.canContinue()
			);
		} catch {
			return false;
		}
	}

	settle(scope: SettlementScope, outcome: AgentSettledEvent["outcome"]): void {
		if (!scope.runner.hasHandlers("agent_settled")) {
			this.scopes.delete(scope);
			return;
		}
		const work = this.deliver(scope, outcome)
			.catch((error: unknown) => {
				if (!this.current(scope)) return;
				scope.controller.abort("failed");
				scope.runner.emitError({
					extensionId: "<runtime>",
					event: "agent_settled",
					error: error instanceof Error ? error.message : String(error),
				});
			})
			.finally(() => {
				this.scopes.delete(scope);
				this.pending.delete(work);
			});
		this.pending.add(work);
	}

	private async deliver(scope: SettlementScope, outcome: AgentSettledEvent["outcome"]): Promise<void> {
		// Leave the conversation's serialized notification tail before invoking hooks or starting a turn.
		await setImmediate();
		if (this.host.lifetimeSignal.aborted || scope.runner !== this.host.extensionRunner()) return;
		try {
			scope.assertBranch();
		} catch {
			return;
		}
		const signal = AbortSignal.any([scope.controller.signal, this.host.lifetimeSignal]);
		if (scope.runSignal?.aborted || scope.abortRevision !== this.host.abortGeneration()) outcome = "aborted";
		const proposal = await scope.runner.emitAgentSettled(
			{ type: "agent_settled", outcome, signal },
			this.host.lifetimeSignal,
		);
		if (!proposal) return;
		try {
			const conversation = this.host.conversation();
			if (
				outcome !== "completed" ||
				!this.current(scope) ||
				!proposal.isCurrent() ||
				this.preparing > 0 ||
				conversation.operation !== undefined ||
				this.host.hasSessionOperationBarrier() ||
				this.host.promptingCommandRunning() ||
				this.host.clientInputs().queueAdmissions.size > 0 ||
				Object.values(conversation.queue).some((messages) => messages.length > 0)
			)
				return;
			await this.host.continuePrompt(
				proposal.prompt,
				scope,
				() => {
					if (!this.current(scope) || !proposal.isCurrent()) throw new Error("Continuation proposal was revoked");
				},
				() => {
					// Admission is the handoff: later cancellation belongs to the new run, not this old proposal.
					this.scopes.delete(scope);
					proposal.release();
				},
			);
		} catch (error) {
			if (this.current(scope) && proposal.isCurrent()) throw error;
		} finally {
			proposal.release();
		}
	}

	async wait(): Promise<void> {
		while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
	}
}
