/**
 * Project trust prompts asked through host requests: the built-in trust
 * prompt and the dialogs of `project_trust` hooks become `select`, `confirm`,
 * and `input` requests of one client, whose answer decides.
 *
 * A conversation a client opens from another one (into another cwd, or a
 * session stored there) asks in the source conversation's live state, of the
 * client that asked for the open only (`clientTrustContext`). Nothing of it
 * reaches a terminal; a client that answers no dialogs, or leaves, leaves the
 * project untrusted. Remote clients are never asked. A conversation a TUI
 * opens in a daemon worker asks that TUI through the daemon
 * (`hostRequestTrustContext`, from the worker).
 */

import type { HostPromptRequest, HostResponse, UiNodeStyledText } from "@hansjm10/volt-protocol";
import type { ExtensionMode, ProjectTrustContext } from "../extensions/index.ts";
import { notificationText } from "../ui/extension-ui.ts";
import type { HostedConversation } from "./hosted-conversation.ts";
import { hostRequestTimeout } from "./live-state.ts";

/** How a trust context asks its one client. */
export interface TrustPromptChannel {
	readonly cwd: string;
	readonly mode: ExtensionMode;
	/** Read when a prompt is about to be asked: whether the client answers it. */
	hasUI(): boolean;
	/** Ask the client: its answer, or undefined when it gave none. */
	ask(request: HostPromptRequest, signal: AbortSignal | undefined): Promise<HostResponse | undefined>;
	notify(message: UiNodeStyledText, level: "info" | "warning" | "error"): void;
}

/** A trust context whose prompts are host requests on `channel`. */
export function hostRequestTrustContext(channel: TrustPromptChannel): ProjectTrustContext {
	return {
		cwd: channel.cwd,
		mode: channel.mode,
		get hasUI() {
			return channel.hasUI();
		},
		ui: {
			select: async (title, options, opts) => {
				if (options.length === 0) return undefined;
				const response = await channel.ask(
					{ kind: "select", title, options: [...options], ...hostRequestTimeout(opts?.timeout) },
					opts?.signal,
				);
				return response !== undefined && "value" in response ? response.value : undefined;
			},
			confirm: async (title, message, opts) => {
				const response = await channel.ask(
					{ kind: "confirm", title, message, ...hostRequestTimeout(opts?.timeout) },
					opts?.signal,
				);
				return response !== undefined && "confirmed" in response && response.confirmed;
			},
			input: async (title, placeholder, opts) => {
				const response = await channel.ask(
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
				channel.notify(notificationText(message), type === "warning" || type === "error" ? type : "info"),
		},
	};
}

/** The trust prompts of a conversation in `cwd` that the client `clientId` opens from `from`. */
export function clientTrustContext(
	from: HostedConversation,
	clientId: string,
	mode: ExtensionMode,
	cwd: string,
): ProjectTrustContext {
	return hostRequestTrustContext({
		cwd,
		mode,
		hasUI: () => from.liveState.accepts("select", clientId),
		ask: async (request, signal) => {
			const outcome = await from.liveState.request(request, {
				client: clientId,
				...(signal === undefined ? {} : { signal }),
			});
			return outcome.status === "answered" ? outcome.response : undefined;
		},
		notify: (message, level) => from.liveState.notice(level, message),
	});
}
