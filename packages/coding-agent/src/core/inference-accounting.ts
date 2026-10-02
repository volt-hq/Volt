import type { StreamFn } from "@hansjm10/volt-agent-core";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type Usage,
} from "@hansjm10/volt-ai";

/** Host-only metadata sink. Unlike UI observers, failures stop further inference. */
export interface InferenceAccountingRequest {
	observe(usage: Usage | undefined, sequence: number, terminal: boolean, response: boolean): Promise<void>;
}

export type InferenceAccounting = (model: Model<Api>) => Promise<InferenceAccountingRequest>;

/** One upstream consumer; no prompts, content, or provider payloads reach the sink. */
export async function accountInference(
	model: Model<Api>,
	start: (signal: AbortSignal) => ReturnType<StreamFn>,
	accounting: InferenceAccounting,
	signal?: AbortSignal,
): Promise<Awaited<ReturnType<StreamFn>>> {
	signal?.throwIfAborted();
	const request = await accounting(model);
	const controller = new AbortController();
	const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
	const output = createAssistantMessageEventStream();
	void (async () => {
		let sequence = -1;
		let usage: Usage | undefined;
		let terminal = false;
		try {
			requestSignal.throwIfAborted();
			const upstream = await start(requestSignal);
			for await (const event of upstream) {
				sequence = event.seq;
				terminal = event.type === "done" || event.type === "error";
				const message: AssistantMessage =
					event.type === "done" ? event.message : event.type === "error" ? event.error : event.snapshot;
				usage = message.usage;
				await request.observe(usage, sequence, terminal, terminal);
				output.push(event);
				if (terminal) return;
			}
			throw new Error("Inference stream ended without a terminal response");
		} catch (error) {
			let failure = error;
			controller.abort();
			try {
				if (!terminal) await request.observe(usage, sequence + 1, true, false);
			} catch (accountingError) {
				failure = accountingError;
			}
			output.fail(failure);
		}
	})();
	return output;
}
