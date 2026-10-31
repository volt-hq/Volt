/**
 * Host-owned, ephemeral continuation proposals. Never queue one behind other input.
 *
 * Every proposal gets exactly one disposition: its prompt is admitted (handed off to the new run), or its
 * settlement's controller aborts with a reason: `refused` (host policy or an admission gate), `superseded`
 * (newer input, work, or session state), `aborted` (a stop), or `failed` (its dispatch failed; also reported).
 */
import { setImmediate } from "node:timers/promises";
import type { AgentSettledEvent, ExtensionRunner } from "../extensions/index.ts";
import type { SessionPromptingHost } from "./prompting.ts";

type Proposal = NonNullable<Awaited<ReturnType<ExtensionRunner["emitAgentSettled"]>>>;

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

	/** Why the settlement can no longer continue, if it cannot: host policy refuses it, or newer state superseded it. */
	private revocation(scope: SettlementScope, proposal?: Proposal): "refused" | "superseded" | undefined {
		if (!this.host.admissionGate.isOpen || !this.host.canContinue()) return "refused";
		try {
			scope.assertBranch();
		} catch {
			return "superseded";
		}
		return scope.controller.signal.aborted ||
			this.host.lifetimeSignal.aborted ||
			scope.runner !== this.host.extensionRunner() ||
			scope.abortRevision !== this.host.abortGeneration() ||
			scope.runRevision !== this.runRevision ||
			scope.inputRevision !== this.inputRevision ||
			(proposal !== undefined && !proposal.isCurrent())
			? "superseded"
			: undefined;
	}

	private current(scope: SettlementScope): boolean {
		return this.revocation(scope) === undefined;
	}

	/** The proposal's dispatch failed: revoke it, then report the failure. */
	private fail(scope: SettlementScope, error: unknown): void {
		scope.controller.abort("failed");
		scope.runner.emitError({
			extensionId: "<runtime>",
			event: "agent_settled",
			error: error instanceof Error ? error.message : String(error),
		});
	}

	settle(scope: SettlementScope, outcome: AgentSettledEvent["outcome"]): void {
		if (!scope.runner.hasHandlers("agent_settled")) {
			this.scopes.delete(scope);
			return;
		}
		const work = this.deliver(scope, outcome)
			.catch((error: unknown) => {
				if (this.current(scope)) this.fail(scope, error);
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
		let handedOff = false;
		try {
			const conversation = this.host.conversation();
			// The runner proposes only for completed settlements; the outcome check is defensive.
			const refused =
				outcome !== "completed" || this.host.hasSessionOperationBarrier() || this.host.promptingCommandRunning();
			const newer =
				this.preparing > 0 ||
				conversation.operation !== undefined ||
				this.host.clientInputs().queueAdmissions.size > 0 ||
				Object.values(conversation.queue).some((messages) => messages.length > 0);
			const revoked = this.revocation(scope, proposal) ?? (refused ? "refused" : newer ? "superseded" : undefined);
			if (revoked) {
				// An earlier reason (an abort, newer input) is kept.
				scope.controller.abort(revoked);
				return;
			}
			await this.host.continuePrompt(
				proposal.prompt,
				scope,
				() => {
					if (this.revocation(scope, proposal)) throw new Error("Continuation proposal was revoked");
				},
				(result) => {
					if (!result.success) return;
					// Admission is the handoff: later cancellation belongs to the new run, not this old proposal.
					handedOff = true;
					this.scopes.delete(scope);
					proposal.release();
				},
			);
		} catch (error) {
			// The admitted run reports its own failures.
			if (handedOff) return;
			const revoked = this.revocation(scope, proposal);
			if (revoked) scope.controller.abort(revoked);
			else this.fail(scope, error);
		} finally {
			proposal.release();
		}
	}

	async wait(): Promise<void> {
		while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
	}
}
