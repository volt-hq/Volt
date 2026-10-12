import { type Context, fauxAssistantMessage, type Model, type StreamOptions } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createReadToolDefinition } from "../../../src/core/tools/read.ts";
import type { ExtensionAPI } from "../../../src/index.ts";
import { createHarness, type Harness } from "../harness.ts";

interface ObjectSchema {
	properties: Record<string, { description?: string }>;
	required: string[];
}

interface WirePayload {
	tools: { type: "function"; function: { name: string; description: string; parameters: unknown } }[];
	arguments: unknown;
	config: { abortSignal: AbortSignal | undefined };
}

interface Request {
	/** The `read` schema the session offered, serialized when the request was made. */
	offered: string;
	/** The payload as built, before the request hooks. */
	built: WirePayload;
	/** The built payload, serialized before the request hooks. */
	builtJson: string;
	/** The payload as sent after the request hooks. */
	sent: WirePayload;
}

function readParameters(payload: WirePayload): ObjectSchema {
	const read = payload.tools.find((tool) => tool.function.name === "read");
	if (!read) throw new Error("read is not in the payload");
	return read.function.parameters as ObjectSchema;
}

/**
 * Hands the request hooks a payload built the way providers build theirs: each tool's schema by
 * reference, parsed tool-call arguments, and an object that is not plain data (Google's
 * `config.abortSignal`).
 */
function respond(requests: Request[]) {
	return async (context: Context, options: StreamOptions | undefined, _state: unknown, model: Model<string>) => {
		const read = context.tools?.find((tool) => tool.name === "read");
		const built: WirePayload = {
			tools: (context.tools ?? []).map((tool) => ({
				type: "function",
				function: { name: tool.name, description: tool.description, parameters: tool.parameters },
			})),
			arguments: JSON.parse('{"__proto__":{"path":"a.txt"}}'),
			config: { abortSignal: options?.signal },
		};
		const builtJson = JSON.stringify(built);
		const replacement = await options?.onPayload?.(built, model);
		requests.push({
			offered: JSON.stringify(read?.parameters),
			built,
			builtJson,
			sent: (replacement ?? built) as WirePayload,
		});
		return fauxAssistantMessage("done");
	};
}

function editReadSchema(volt: ExtensionAPI): void {
	volt.on("before_provider_request", (event) => {
		const schema = readParameters(event.payload as WirePayload);
		schema.properties.path.description = "Edited by an extension";
		schema.properties.injected = { description: "Injected by an extension" };
		schema.required.push("injected");
	});
}

describe("regression #806: before_provider_request payload edits stay in their request", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("applies an in-place edit of a tool schema to that request only", async () => {
		const original = JSON.stringify(createReadToolDefinition(".").parameters);
		harness = await createHarness({ extensionFactories: [editReadSchema] });
		const requests: Request[] = [];
		harness.setResponses([respond(requests), respond(requests)]);

		await harness.session.prompt("first");
		await harness.session.prompt("second");

		expect(requests).toHaveLength(2);
		for (const request of requests) {
			expect(request.offered).toBe(original);
			const sent = readParameters(request.sent);
			expect(sent.properties.path.description).toBe("Edited by an extension");
			expect(sent.required).toEqual(["path", "injected"]);
		}
		expect(JSON.stringify(createReadToolDefinition(".").parameters)).toBe(original);
	});

	it("hands handlers a copy that serializes like the payload and keeps other objects as they are", async () => {
		const seen: unknown[] = [];
		harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.on("before_provider_request", (event) => {
						seen.push(event.payload);
					});
				},
			],
		});
		const requests: Request[] = [];
		harness.setResponses([respond(requests)]);

		await harness.session.prompt("inspect the payload");

		expect(requests).toHaveLength(1);
		const [{ built, builtJson, sent }] = requests as [Request];
		expect(seen).toEqual([sent]);
		expect(seen[0]).toBe(sent);
		expect(sent).not.toBe(built);
		expect(sent.tools[0]?.function.parameters).not.toBe(built.tools[0]?.function.parameters);
		expect(JSON.stringify(sent)).toBe(builtJson);
		expect(sent.config.abortSignal).toBeInstanceOf(AbortSignal);
		expect(sent.config.abortSignal).toBe(built.config.abortSignal);
	});
});
