import type { LiveState } from "./host/live-state.ts";

/** Structured preference questions. Answers never grant tool or execution authority. */
export interface UserInputOption {
	label: string;
	description: string;
}

export interface UserInputQuestion {
	id: string;
	header: string;
	question: string;
	options: UserInputOption[];
}

export interface UserInputRequest {
	questions: UserInputQuestion[];
}

export interface UserInputAnswer {
	/** Selected label, free-form answer, or selected label followed by notes. */
	answers: string[];
}

export interface UserInputResponse {
	status: "answered" | "skipped" | "cancelled" | "unavailable";
	answers: Record<string, UserInputAnswer>;
}

/**
 * Ask the user a request's questions in a client that shows them: resolves
 * with the response; a call aborted before or while the questions show
 * resolves cancelled.
 */
export type UserInputPrompt = (request: UserInputRequest, signal?: AbortSignal) => Promise<UserInputResponse>;

/**
 * Ask `request`'s questions as a `user_input` host request in `live`: every
 * attached client that accepts the kind shows them, and the first answer
 * wins. Unavailable when no attached client accepts it; cancelled when a
 * client dismisses the questions, `signal` aborts, or the conversation closes.
 */
export async function userInputFromClients(
	live: LiveState,
	request: UserInputRequest,
	signal?: AbortSignal,
): Promise<UserInputResponse> {
	const outcome = await live.request(
		{ kind: "user_input", questions: request.questions },
		signal === undefined ? {} : { signal },
	);
	if (outcome.status === "cancelled") {
		return { status: outcome.reason === "unavailable" ? "unavailable" : "cancelled", answers: {} };
	}
	const response = outcome.response;
	return "status" in response
		? { status: response.status, answers: response.answers }
		: { status: "cancelled", answers: {} };
}
