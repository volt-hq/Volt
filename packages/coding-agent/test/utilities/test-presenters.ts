import { SessionPresenters } from "../../src/core/session/presenters.ts";

/** The presenters of a session double that registers no tools: the built-in tools' presenters. */
export function builtinSessionPresenters(): SessionPresenters {
	return new SessionPresenters({ tool: () => undefined, message: () => undefined, ownsWork: () => false });
}
