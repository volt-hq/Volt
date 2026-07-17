import type { Api, AssistantMessage, Provider, StopReason, ToolCall, Usage } from "../types.ts";
import type { AssistantMessageDiagnostic } from "../utils/diagnostics.ts";

export interface AssistantMessageInit {
	api: Api;
	provider: Provider;
	model: string;
	timestamp: number;
	responseId?: string;
	responseModel?: string;
	usage?: Usage;
	diagnostics?: AssistantMessageDiagnostic[];
}

export interface AssistantMessageMetaPatch {
	responseId?: string;
	responseModel?: string;
	usage?: Partial<Omit<Usage, "cost">> & { cost?: Partial<Usage["cost"]> };
	diagnostics?: AssistantMessageDiagnostic[];
}

export type AssistantStreamFragment =
	| { type: "start"; init: AssistantMessageInit }
	| { type: "meta"; patch: AssistantMessageMetaPatch }
	| { type: "text_start"; contentIndex: number }
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "text_end"; contentIndex: number; content?: string; textSignature?: string }
	| {
			type: "thinking_start";
			contentIndex: number;
			content?: string;
			thinkingSignature?: string;
			redacted?: boolean;
	  }
	| { type: "thinking_delta"; contentIndex: number; delta: string; signatureDelta?: string }
	| {
			type: "thinking_end";
			contentIndex: number;
			content?: string;
			thinkingSignature?: string;
			redacted?: boolean;
	  }
	| { type: "toolcall_start"; contentIndex: number; id?: string; name?: string }
	| { type: "toolcall_delta"; contentIndex: number; argsTextDelta: string; id?: string; name?: string }
	| { type: "toolcall_end"; contentIndex: number; toolCall?: ToolCall; thoughtSignature?: string }
	| {
			type: "done";
			reason: Extract<StopReason, "stop" | "length" | "toolUse">;
			usage?: Usage;
	  }
	| {
			type: "error";
			reason: Extract<StopReason, "aborted" | "error">;
			errorMessage: string;
			diagnostics?: AssistantMessageDiagnostic[];
			usage?: AssistantMessage["usage"];
	  };
