import type { AssistantStreamFragment } from "../src/stream/fragments.ts";
import type { AssistantStreamNormalizer } from "../src/stream/normalizer.ts";
import type { AssistantMessageEvent } from "../src/types.ts";
import type { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

/** Read the events a stream already holds, without waiting for more. */
export async function readQueued(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const iterator = stream[Symbol.asyncIterator]();
	const events: AssistantMessageEvent[] = [];
	while (stream.getQueueMetrics().queuedEvents > 0) {
		const next = await iterator.next();
		if (next.done) break;
		events.push(next.value);
	}
	return events;
}

/**
 * Push fragments one at a time and read what each one queued. A stream combines queued deltas for
 * one block, so only a consumer that keeps up sees every event the normalizer emits.
 */
export async function pushAndRead(
	normalizer: AssistantStreamNormalizer,
	fragments: Iterable<AssistantStreamFragment>,
): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for (const fragment of fragments) {
		normalizer.push(fragment);
		events.push(...(await readQueued(normalizer.stream)));
	}
	return events;
}
