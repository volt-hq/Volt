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
