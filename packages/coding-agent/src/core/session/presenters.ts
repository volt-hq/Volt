/**
 * The presenter set of a session (RFC §4.3, §8.3): the presenters of the
 * tools it registers and of the custom message types the host and its
 * extensions present. A tool's own `present()` presents its calls; any other
 * call (of a registered tool without a presenter, of a built-in excluded
 * here, of a disabled extension's tool) presents with the built-in presenter
 * of that name if there is one, else generically. The host's own message
 * types present with the host's presenters; extensions cannot register
 * presenters for them. Extension presenters bind only the extension's own
 * actions. `generation` moves when the registered tools change, and the
 * projection cache keys on it.
 */

import { PresentationCache } from "../protocol/projection/presentation.ts";
import { BUILTIN_TOOL_PRESENTERS } from "../tools/presenters.ts";
import { BUILTIN_MESSAGE_PRESENTERS, HOST_CUSTOM_MESSAGE_TYPES } from "../ui/message-presenters.ts";
import type { UiActionPolicy } from "../ui/normalize.ts";
import {
	HOST_UI_POLICY,
	type MessagePresenter,
	type PresenterSet,
	type ResolvedMessagePresenter,
	type ResolvedToolPresenter,
	type ToolPresenter,
} from "../ui/presentation.ts";

/** A registered tool as presenting sees it. */
export interface PresentedTool {
	readonly present?: ToolPresenter;
	/** The manifest id of the extension that registered it, if one did. */
	readonly extensionId?: string;
}

export interface SessionPresentersHost {
	/** The registered tool `name`, whatever the mode. */
	tool(name: string): PresentedTool | undefined;
	/** The presenter of custom messages of `customType`, and the extension that registered it. */
	message(customType: string): { readonly present: MessagePresenter; readonly extensionId: string } | undefined;
	/** Whether work `workId` is of a kind of the extension `extensionId`. */
	ownsWork(extensionId: string, workId: string): boolean;
}

export class SessionPresenters implements PresenterSet {
	private readonly host: SessionPresentersHost;
	private currentGeneration = 0;
	/** The presentations of projected entries, by profile and entry id. */
	readonly cache = new PresentationCache();

	constructor(host: SessionPresentersHost) {
		this.host = host;
	}

	get generation(): number {
		return this.currentGeneration;
	}

	/** Presenters were registered or removed: what was presented before is presented again. */
	invalidate(): void {
		this.currentGeneration++;
	}

	tool(toolName: string): ResolvedToolPresenter | undefined {
		const tool = this.host.tool(toolName);
		if (tool?.present !== undefined) {
			return {
				present: tool.present,
				policy: tool.extensionId === undefined ? HOST_UI_POLICY : this.extensionPolicy(tool.extensionId),
			};
		}
		const builtin = BUILTIN_TOOL_PRESENTERS.get(toolName);
		return builtin === undefined ? undefined : { present: builtin, policy: HOST_UI_POLICY };
	}

	message(customType: string): ResolvedMessagePresenter | undefined {
		const builtin = BUILTIN_MESSAGE_PRESENTERS.get(customType);
		if (builtin !== undefined) return { present: builtin, policy: HOST_UI_POLICY };
		// The host's own message types are never an extension's to present.
		if (HOST_CUSTOM_MESSAGE_TYPES.has(customType)) return undefined;
		const found = this.host.message(customType);
		return found === undefined
			? undefined
			: { present: found.present, policy: this.extensionPolicy(found.extensionId) };
	}

	private extensionPolicy(extensionId: string): UiActionPolicy {
		return { owner: "extension", extensionId, ownsWork: (workId) => this.host.ownsWork(extensionId, workId) };
	}
}
