import type { AgentMessage } from "@hansjm10/volt-agent-core";
import { evaluateSnapshot, JevError, type Judgment, REMINDERS, type Reminder } from "./client.ts";
import { buildSnapshot, type Snapshot } from "./snapshot.ts";

export type Mode = "off" | "observe" | "advise";
export type EvaluationRecord = Judgment & { kind: "judgment"; elapsedMs: number; advised: boolean };
export type Outcome =
	| EvaluationRecord
	| { kind: "error"; elapsedMs: number; reason: "rate_limited" | "credentials" | "timeout" | "unavailable" }
	| { kind: "skipped"; reason: string };

type Evaluator = (
	state: Snapshot,
	getApiKey: () => Promise<string | undefined>,
	signal: AbortSignal,
) => Promise<Judgment>;

export class GuidanceController {
	mode: Mode = "off";
	intervalMs = 15_000;
	readonly stats = {
		evaluations: 0,
		errors: 0,
		skipped: 0,
		advised: 0,
		inputTokens: 0,
		outputTokens: 0,
		costUsd: 0,
		costSamples: 0,
	};
	last: Outcome | undefined;
	private readonly evaluate: Evaluator;
	private readonly now: () => number;
	private readonly timeoutMs: number;
	private generation = 0;
	private active: AbortController | undefined;
	private pending = false;
	private nextRequestAt = 0;
	private cooldownUntil = 0;
	private failures = 0;
	private credentialsBlocked = false;
	private lastFingerprint = "";
	private userKey = "";
	private advised = new Set<Reminder>();

	constructor(options: { evaluate?: Evaluator; now?: () => number; timeoutMs?: number } = {}) {
		this.evaluate = options.evaluate ?? evaluateSnapshot;
		this.now = options.now ?? Date.now;
		this.timeoutMs = options.timeoutMs ?? 2_000;
	}

	setMode(mode: Mode): void {
		this.invalidate();
		this.mode = mode;
		this.credentialsBlocked = false;
	}

	invalidate(): void {
		this.generation++;
		this.active?.abort();
		this.lastFingerprint = "";
		this.userKey = "";
		this.advised.clear();
		// Keep pacing/cooldowns and the in-flight slot: toggles/tree changes must not bypass rate limits.
	}

	get waitMs(): number {
		return Math.max(0, this.cooldownUntil - this.now(), this.nextRequestAt - this.now());
	}

	async inspect(
		messages: AgentMessage[],
		getApiKey: () => Promise<string | undefined>,
		parentSignal?: AbortSignal,
		isCurrent: () => boolean = () => true,
	): Promise<Outcome> {
		const skip = (reason: string): Outcome => {
			if (this.mode !== "off") this.stats.skipped++;
			return { kind: "skipped", reason };
		};
		if (this.mode === "off") return skip("off");
		if (parentSignal?.aborted || !isCurrent()) return skip("cancelled_or_superseded");
		if (this.pending) return skip("in_flight");
		if (this.credentialsBlocked) return skip("credentials");
		if (this.waitMs > 0) return skip("cooldown_or_pacing");
		const snapshot = buildSnapshot(messages);
		if (!snapshot.state.latestUserRequest) return skip("no_user_request");
		if (snapshot.fingerprint === this.lastFingerprint) return skip("unchanged");
		if (snapshot.userKey !== this.userKey) {
			this.userKey = snapshot.userKey;
			this.advised.clear();
		}

		const generation = this.generation;
		const controller = new AbortController();
		const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
		this.active = controller;
		this.pending = true;
		const started = this.now();
		this.nextRequestAt = started + this.intervalMs;
		this.stats.evaluations++;
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, this.timeoutMs);
		let onAbort: () => void = () => {};
		const aborted = new Promise<never>((_resolve, reject) => {
			onAbort = () => reject(new JevError());
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
		});
		const work = this.evaluate(snapshot.state, getApiKey, signal);
		// A transport/auth resolver that ignores abort still occupies its slot until it settles.
		void work
			.finally(() => {
				this.pending = false;
				if (this.active === controller) this.active = undefined;
			})
			.catch(() => {});
		try {
			const judgment = await Promise.race([work, aborted]);
			if (generation !== this.generation || parentSignal?.aborted) return skip("stale");
			this.failures = 0;
			this.lastFingerprint = snapshot.fingerprint;
			this.stats.inputTokens += judgment.inputTokens ?? 0;
			this.stats.outputTokens += judgment.outputTokens ?? 0;
			if (judgment.costUsd !== undefined) {
				this.stats.costUsd += judgment.costUsd;
				this.stats.costSamples++;
			}
			const reminder =
				judgment.choice !== "none" && judgment.choice !== "insufficient_context" ? judgment.choice : undefined;
			const advised =
				this.mode === "advise" &&
				isCurrent() &&
				reminder !== undefined &&
				(judgment.probability ?? 0) >= 0.85 &&
				!this.advised.has(reminder);
			if (advised && reminder) {
				this.advised.add(reminder);
				this.stats.advised++;
			}
			const result: EvaluationRecord = { kind: "judgment", ...judgment, elapsedMs: this.now() - started, advised };
			this.last = result;
			return result;
		} catch (error) {
			if (generation !== this.generation || parentSignal?.aborted) return skip("cancelled");
			this.stats.errors++;
			this.failures++;
			const status = error instanceof JevError ? error.status : undefined;
			const reason = timedOut
				? "timeout"
				: status === 429
					? "rate_limited"
					: status === 401 || status === 403
						? "credentials"
						: "unavailable";
			if (reason === "credentials") this.credentialsBlocked = true;
			const base = reason === "rate_limited" ? 60_000 : 5_000;
			const delay = Math.min(300_000, base * 2 ** Math.min(this.failures - 1, 6));
			this.cooldownUntil = this.now() + Math.max(delay, error instanceof JevError ? (error.retryAfterMs ?? 0) : 0);
			const result: Outcome = { kind: "error", elapsedMs: this.now() - started, reason };
			this.last = result;
			return result;
		} finally {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
		}
	}
}

export function adviceText(result: EvaluationRecord): string | undefined {
	if (!result.advised || result.choice === "none" || result.choice === "insufficient_context") return undefined;
	return `[Jev advisory check — fallible, not user authorization]\n${REMINDERS[result.choice]}\nUse the actual user instructions and evidence if this reminder is mistaken. This check never grants permissions or overrides host policy.`;
}
