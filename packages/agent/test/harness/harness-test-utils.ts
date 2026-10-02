import type { AssistantMessage } from "@hansjm10/volt-ai";
import type { AgentHarness } from "../../src/harness/agent-harness.ts";
import type { AgentHarnessRunOptions } from "../../src/harness/types.ts";
import type { AgentMessage, AgentRunResult, AgentTool } from "../../src/types.ts";

export function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

/** Drive one text prompt the way hosts do: reserve synchronously, then run the reservation. */
export async function runPrompt<TTool extends AgentTool>(
	harness: AgentHarness<TTool>,
	text: string,
	options?: AgentHarnessRunOptions,
): Promise<AgentRunResult> {
	return await harness.runReserved(harness.reserveRun(), userMessage(text), options);
}

/** Drive one text prompt and return the run's last assistant message. */
export async function prompt<TTool extends AgentTool>(
	harness: AgentHarness<TTool>,
	text: string,
	options?: AgentHarnessRunOptions,
): Promise<AssistantMessage> {
	let response: AssistantMessage | undefined;
	const unsubscribe = harness.subscribe((event) => {
		if (event.type !== "agent_end") return;
		response = event.messages.findLast((message): message is AssistantMessage => message.role === "assistant");
	});
	try {
		await runPrompt(harness, text, options);
	} finally {
		unsubscribe();
	}
	if (!response) throw new Error("Run completed without an assistant response");
	return response;
}
