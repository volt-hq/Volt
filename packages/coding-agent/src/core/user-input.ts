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
 * Ask the user a request's questions in a client that shows them (the local
 * TUI): resolves with the response; a call aborted before or while the
 * questions show resolves cancelled.
 */
export type UserInputPrompt = (request: UserInputRequest, signal?: AbortSignal) => Promise<UserInputResponse>;
