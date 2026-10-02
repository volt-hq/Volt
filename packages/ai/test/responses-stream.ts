import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import {
	mapResponsesStopReason,
	mapResponsesUsage,
	type OpenAIResponsesStreamOptions,
	type ProcessResponsesStreamResult,
	processResponsesStream,
	type ResponsesStop,
	type ResponsesUsageReport,
} from "../src/providers/openai-responses-shared.ts";
import { createProviderStream } from "../src/stream/runner.ts";
import type { Api, Model, StreamOptions } from "../src/types.ts";
import type { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

export interface ResponsesEventsRun {
	stream: AssistantMessageEventStream;
	/** Set once parsing completes: the parser result and the runner signal it parsed under. */
	parsed: { result?: ProcessResponsesStreamResult; signal?: AbortSignal };
}

/** Parse Responses events through the stream runner, as the Responses providers do. */
export function streamResponsesEvents(
	events: AsyncIterable<ResponseStreamEvent>,
	model: Model<Api>,
	options?: StreamOptions,
	pricing?: OpenAIResponsesStreamOptions,
): ResponsesEventsRun {
	const parsed: ResponsesEventsRun["parsed"] = {};
	const stream = createProviderStream<
		Api,
		StreamOptions,
		undefined,
		AsyncIterable<ResponseStreamEvent>,
		ResponsesStop,
		ResponsesUsageReport
	>({
		buildRequest: () => ({ payload: undefined, send: async () => ({ body: events }) }),
		async parse(body, sink, ctx) {
			parsed.signal = ctx.options.signal;
			parsed.result = await processResponsesStream(body, sink);
		},
		mapStopReason: mapResponsesStopReason,
		mapUsage: (report) => mapResponsesUsage(report, model, pricing),
	})(model, { messages: [] }, options);
	return { stream, parsed };
}
