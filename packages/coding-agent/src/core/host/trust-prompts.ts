/**
 * The project trust prompts of a conversation a client opens from another
 * one (into another cwd, or a session stored there): the built-in prompt and
 * `project_trust` hooks ask through host requests in the source
 * conversation's live state, of the client that asked for the open only.
 * Nothing of it reaches a terminal; a client that answers no dialogs, or
 * leaves, leaves the project untrusted. Remote clients are never asked. The
 * startup decision is made before any host exists.
 */

import type { HostRequest, HostResponse } from "@hansjm10/volt-protocol";
import type { ExtensionMode, ProjectTrustContext } from "../extensions/index.ts";
import { notificationText } from "../ui/extension-ui.ts";
import type { HostedConversation } from "./hosted-conversation.ts";
import { hostRequestTimeout } from "./live-state.ts";

/** The trust prompts of a conversation in `cwd` that the client `clientId` opens from `from`. */
export function clientTrustContext(
	from: HostedConversation,
	clientId: string,
	mode: ExtensionMode,
	cwd: string,
): ProjectTrustContext {
	const ask = async (request: HostRequest, signal: AbortSignal | undefined): Promise<HostResponse | undefined> => {
		const outcome = await from.liveState.request(request, {
			client: clientId,
			...(signal === undefined ? {} : { signal }),
		});
		return outcome.status === "answered" ? outcome.response : undefined;
	};
	return {
		cwd,
		mode,
		// Read when the prompt is about to be asked: whether the client still answers dialogs.
		get hasUI() {
			return from.liveState.accepts("select", clientId);
		},
		ui: {
			select: async (title, options, opts) => {
				if (options.length === 0) return undefined;
				const response = await ask(
					{ kind: "select", title, options: [...options], ...hostRequestTimeout(opts?.timeout) },
					opts?.signal,
				);
				return response !== undefined && "value" in response ? response.value : undefined;
			},
			confirm: async (title, message, opts) => {
				const response = await ask(
					{ kind: "confirm", title, message, ...hostRequestTimeout(opts?.timeout) },
					opts?.signal,
				);
				return response !== undefined && "confirmed" in response && response.confirmed;
			},
			input: async (title, placeholder, opts) => {
				const response = await ask(
					{
						kind: "input",
						title,
						...(placeholder === undefined ? {} : { placeholder }),
						...hostRequestTimeout(opts?.timeout),
					},
					opts?.signal,
				);
				return response !== undefined && "value" in response ? response.value : undefined;
			},
			notify: (message, type) =>
				from.liveState.notice(type === "warning" || type === "error" ? type : "info", notificationText(message)),
		},
	};
}
