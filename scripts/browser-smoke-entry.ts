import {
	builtInModels,
	builtInProviders,
	createAiClient,
	createAssistantMessageEventStream,
	getModel,
	getProviders,
	Type,
} from "@hansjm10/volt-ai";
import {
	AgentHarness,
	bashExecutionToText,
	convertToLlm,
	createCustomMessage,
	createSessionId,
	Session,
	streamProxy,
	toError,
} from "@hansjm10/volt-agent-core";
import { CONTRACT_SCHEMA_REGISTRY, CORE_LOG_ENTRY_TYPES, UiNodeSchema } from "@hansjm10/volt-protocol";

// Keep this entry browser-safe. It is bundled by scripts/check-browser-smoke.mjs
// to catch accidental Node-only runtime imports in browser-facing package exports.
const model = getModel("google", "gemini-2.5-flash");
const client = createAiClient({ providers: builtInProviders(), models: builtInModels() });
const schema = Type.Object({ prompt: Type.String() });
const stream = createAssistantMessageEventStream();

const customMessage = createCustomMessage("note", "hello", true, undefined, "2026-01-01T00:00:00.000Z");
const llmMessages = convertToLlm([customMessage]);

console.log(
	model.id,
	getProviders().length,
	typeof client.complete,
	schema.type,
	typeof stream.push,
	typeof AgentHarness,
	typeof Session,
	createSessionId().length,
	llmMessages.length,
	bashExecutionToText({
		role: "bashExecution",
		command: "echo ok",
		output: "ok",
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp: 0,
	}),
	toError("boom").message,
	typeof streamProxy,
	CONTRACT_SCHEMA_REGISTRY.size,
	Object.keys(CORE_LOG_ENTRY_TYPES).length,
	typeof UiNodeSchema,
);
