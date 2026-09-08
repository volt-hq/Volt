/**
 * Offline argument-processing measurements, separate from #220 canonical cloning.
 * Run: node packages/ai/benchmarks/tool-argument-processing.ts
 * Parsed characters are derived from the raw tool state on each emitted delta;
 * the normalizer parses once per such event. Slow consumers must either preserve
 * all arguments or receive the explicit queue-limit terminal.
 */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "../src/providers/faux.ts";
import { stream } from "../src/stream.ts";
import { AssistantStreamNormalizer } from "../src/stream/normalizer.ts";

for (const argumentChars of [16 * 1024, 64 * 1024, 256 * 1024]) {
	for (const chunkChars of [4, 256, 4096]) {
		for (const calls of [1, 2]) {
			for (const consumerDelayMs of [0, 1]) {
				const faux = registerFauxProvider({ tokenSize: { min: chunkChars / 4, max: chunkChars / 4 } });
				const argumentsValue = { newText: "x".repeat(argumentChars) };
				faux.setResponses([fauxAssistantMessage(
					Array.from({ length: calls }, (_, index) => fauxToolCall("edit", argumentsValue, { id: `call-${index}` })),
					{ stopReason: "toolUse" },
				)]);
				let previews = 0;
				let parsedChars = 0;
				const start = performance.now();
				try {
					const response = stream(faux.getModel(), { messages: [] });
					for await (const event of response) {
						if (event.type === "toolcall_delta") {
							previews++;
							parsedChars += event.toolState.find((state) => state.contentIndex === event.contentIndex)?.argsText.length ?? 0;
						}
						if (consumerDelayMs) await new Promise((resolve) => setTimeout(resolve, consumerDelayMs));
					}
					const result = await response.result();
					if (result.stopReason === "error") {
						assert(result.diagnostics?.some((diagnostic) => diagnostic.type === "assistant_stream_queue_limit"));
					} else {
						assert.equal(result.stopReason, "toolUse");
						assert.deepEqual(result.content, Array.from({ length: calls }, (_, index) => ({
							type: "toolCall", id: `call-${index}`, name: "edit", arguments: argumentsValue,
						})));
					}
					console.log(JSON.stringify({
						argumentChars, chunkChars, calls, consumerDelayMs, observedPreviews: previews, observedParsedChars: parsedChars,
						elapsedMs: Math.round(performance.now() - start), stopReason: result.stopReason,
						failure: result.diagnostics?.at(-1)?.type,
					}));
				} finally {
					faux.unregister();
				}
			}
		}
	}
}

// Alternating calls cannot be merged across each other's semantic updates.
// Measure that boundary explicitly instead of attributing sequential-call gains to it.
for (const argumentChars of [16 * 1024, 64 * 1024]) {
	for (const chunkChars of [256, 4096]) {
		const normalizer = new AssistantStreamNormalizer();
		const argumentsValue = { newText: "x".repeat(argumentChars) };
		const raw = JSON.stringify(argumentsValue);
		let previews = 0;
		let parsedChars = 0;
		const consume = (async () => {
			for await (const event of normalizer.stream) {
				if (event.type === "toolcall_delta") {
					previews++;
					parsedChars += event.toolState.find((state) => state.contentIndex === event.contentIndex)?.argsText.length ?? 0;
				}
			}
		})();
		const start = performance.now();
		normalizer.push({ type: "start", init: { api: "faux", provider: "faux", model: "benchmark", timestamp: 0 } });
		for (const contentIndex of [0, 1]) normalizer.push({ type: "toolcall_start", contentIndex, id: `call-${contentIndex}`, name: "edit" });
		for (let offset = 0; offset < raw.length; offset += chunkChars) {
			for (const contentIndex of [0, 1]) {
				normalizer.push({ type: "toolcall_delta", contentIndex, argsTextDelta: raw.slice(offset, offset + chunkChars) });
				await Promise.resolve();
				await Promise.resolve();
			}
		}
		for (const contentIndex of [0, 1]) normalizer.push({ type: "toolcall_end", contentIndex });
		normalizer.push({ type: "done", reason: "toolUse" });
		await consume;
		const result = await normalizer.stream.result();
		assert.equal(result.stopReason, "toolUse");
		assert.deepEqual(result.content, [0, 1].map((contentIndex) => ({
			type: "toolCall", id: `call-${contentIndex}`, name: "edit", arguments: argumentsValue,
		})));
		console.log(JSON.stringify({ argumentChars, chunkChars, calls: 2, interleaved: true, consumerDelayMs: 0,
			observedPreviews: previews, observedParsedChars: parsedChars, elapsedMs: Math.round(performance.now() - start), stopReason: result.stopReason }));
	}
}
