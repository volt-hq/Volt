import type { JsonValue } from "@hansjm10/volt-coding-agent";

export type JevQuestion =
	| { type: "choice"; instructions: string; criteria: Record<string, string> }
	| { type: "boolean"; instructions: string }
	| { type: "score"; instructions: string; criteria: string[] };
export type JevAnswer =
	| { type: "choice"; choice: string; probabilities: Record<string, number> }
	| { type: "boolean"; probability: number }
	| { type: "score"; score: number; probabilities: Record<string, number> };

export interface JevCallMetadata {
	elapsedMs: number;
	requestBytes: number;
	httpStatus?: number;
	inputTokens?: number;
	outputTokens?: number;
	cost?: string;
}

export type JevResult = JevCallMetadata &
	(
		| { status: "ok"; answers: Record<string, JevAnswer> }
		| {
				status: "unavailable" | "cancelled";
				reason: "credentials" | "size" | "http" | "response" | "transport" | "timeout" | "aborted" | "budget";
		  }
	);

export interface JevTransportOptions {
	fetch?: typeof globalThis.fetch;
	zeroDataRetention?: boolean;
}

const MAX_BYTES = 65_536;

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function probability(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Validate the entire batch before exposing any decision. Rounded distributions need not sum exactly to one. */
function parseAnswers(value: unknown, questions: Record<string, JevQuestion>): Record<string, JevAnswer> | undefined {
	if (!record(value) || Object.keys(value).length !== Object.keys(questions).length) return;
	const answers: Record<string, JevAnswer> = {};
	for (const [id, question] of Object.entries(questions)) {
		const answer = value[id];
		if (!record(answer) || answer.type !== question.type) return;
		if (question.type === "boolean") {
			if (!probability(answer.probability)) return;
			answers[id] = { type: "boolean", probability: answer.probability };
			continue;
		}
		const keys = Object.keys(question.criteria);
		const distribution = answer.probabilities;
		if (!record(distribution) || Object.keys(distribution).length !== keys.length) return;
		const probabilities: Record<string, number> = {};
		for (const key of keys) {
			const value = distribution[key];
			if (!Object.hasOwn(distribution, key) || !probability(value)) return;
			probabilities[key] = value;
		}
		if (question.type === "choice") {
			if (typeof answer.choice !== "string" || !Object.hasOwn(question.criteria, answer.choice)) return;
			answers[id] = { type: "choice", choice: answer.choice, probabilities };
		} else {
			if (
				typeof answer.score !== "number" ||
				!Number.isFinite(answer.score) ||
				answer.score < 0 ||
				answer.score > keys.length - 1
			)
				return;
			answers[id] = { type: "score", score: answer.score, probabilities };
		}
	}
	return answers;
}

/** Public Gateway evaluation API. No chat adapter, SDK dependency, retry, or alternate endpoint. */
export async function evaluateAhead(
	state: JsonValue,
	questions: Record<string, JevQuestion>,
	resolveKey: () => Promise<string | undefined>,
	parentSignal: AbortSignal,
	options: JevTransportOptions = {},
	observeRequest?: (body: string) => void,
): Promise<JevResult> {
	const started = performance.now();
	const timeout = AbortSignal.timeout(2000);
	const signal = AbortSignal.any([parentSignal, timeout]);
	const metadata: Omit<JevCallMetadata, "elapsedMs"> = { requestBytes: 0 };
	const finish = (
		outcome:
			| Omit<Extract<JevResult, { status: "unavailable" | "cancelled" }>, keyof JevCallMetadata>
			| { status: "ok"; answers: Record<string, JevAnswer> },
	): JevResult => ({
		...metadata,
		elapsedMs: performance.now() - started,
		...outcome,
	});
	try {
		signal.throwIfAborted();
		if (!Object.keys(questions).length || Object.keys(questions).length > 64)
			return finish({ status: "unavailable", reason: "size" });
		const body = JSON.stringify({
			model: "typesafe-ai/jev",
			state,
			questions,
			...(options.zeroDataRetention ? { providerOptions: { gateway: { zeroDataRetention: true } } } : {}),
		});
		metadata.requestBytes = Buffer.byteLength(body);
		if (metadata.requestBytes > MAX_BYTES) return finish({ status: "unavailable", reason: "size" });
		try {
			observeRequest?.(body);
		} catch {
			/* Audit failures never control optional preparation. */
		}
		const key = await resolveKey();
		signal.throwIfAborted();
		if (!key) return finish({ status: "unavailable", reason: "credentials" });
		const response = await (options.fetch ?? globalThis.fetch)("https://ai-gateway.vercel.sh/v1/evaluate", {
			method: "POST",
			redirect: "error",
			credentials: "omit",
			signal,
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Cache-Control": "no-store" },
			body,
		});
		metadata.httpStatus = response.status;
		if (signal.aborted || !response.ok || !response.body) {
			await response.body?.cancel();
			signal.throwIfAborted();
			return finish({ status: "unavailable", reason: "http" });
		}
		const reader = response.body.getReader();
		const cancel = () => {
			void reader.cancel().catch(() => {});
		};
		signal.addEventListener("abort", cancel, { once: true });
		const chunks: Uint8Array[] = [];
		let bytes = 0;
		try {
			for (;;) {
				signal.throwIfAborted();
				const { done, value } = await reader.read();
				signal.throwIfAborted();
				if (done) break;
				bytes += value.byteLength;
				if (bytes > MAX_BYTES) return finish({ status: "unavailable", reason: "size" });
				chunks.push(value);
			}
		} finally {
			signal.removeEventListener("abort", cancel);
			await reader.cancel();
			reader.releaseLock();
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} catch {
			return finish({ status: "unavailable", reason: "response" });
		}
		if (!record(parsed)) return finish({ status: "unavailable", reason: "response" });
		const answers = parseAnswers(parsed.answers, questions);
		if (!answers) return finish({ status: "unavailable", reason: "response" });
		if (record(parsed.usage)) {
			for (const key of ["inputTokens", "outputTokens"] as const) {
				const value = parsed.usage[key];
				if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) metadata[key] = value;
			}
		}
		const gateway = record(parsed.providerMetadata) ? parsed.providerMetadata.gateway : undefined;
		if (record(gateway) && typeof gateway.cost === "string" && /^\d{1,12}(?:\.\d{1,12})?$/.test(gateway.cost))
			metadata.cost = gateway.cost;
		signal.throwIfAborted();
		return finish({ status: "ok", answers });
	} catch {
		return finish(
			parentSignal.aborted
				? { status: "cancelled", reason: "aborted" }
				: { status: "unavailable", reason: timeout.aborted ? "timeout" : "transport" },
		);
	}
}
