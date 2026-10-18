/**
 * Presentations of projected entries (RFC §4.3, amended): a tool item's and
 * a presented custom message's `view.presentation` is a pure function of the
 * log, the projection, and the presenter set. It is computed when the entry
 * is projected and never stored in the log; the projection cache keeps the
 * projected entry while the presenter set's generation and the entry's
 * presenter ({@link entryPresenter}) stay the same.
 *
 * A projection bounds presentations (`presentationBytes`). On the remote
 * projection the presenter sees the entry with its paths redacted, image
 * nodes are replaced by their description (images are fetched with the
 * `content` query), and extension message presenters do not run: the custom
 * messages a paired device sees are the host's own.
 */

import type { MessagePresentation, ToolPresentation, UiNode } from "@hansjm10/volt-protocol";
import type { CommittedSessionEntry } from "../../session-manager.ts";
import {
	fitPresentation,
	type MessagePresentInput,
	type PresenterSet,
	presentCustomMessage,
	presentToolCall,
	type ResolvedMessagePresenter,
	type ResolvedToolPresenter,
	type ToolPresentInput,
} from "../../ui/presentation.ts";
import type { Projection } from "../profiles.ts";

/** What presenting a projected entry reads: the presenters and the working directory. */
export interface PresentationSource {
	readonly presenters: PresenterSet;
	readonly cwd: string;
}

/** The presenter calls of tool `toolName` present with, if any. */
function toolPresenter(source: PresentationSource, toolName: string): ResolvedToolPresenter | undefined {
	return source.presenters.tool(toolName);
}

/** The presenter custom messages of `customType` present with on `projection`, if it runs one. */
function messagePresenter(
	source: PresentationSource,
	customType: string,
	projection: Projection,
): ResolvedMessagePresenter | undefined {
	const found = source.presenters.message(customType);
	return found !== undefined && (projection.fidelity === "full" || found.policy.owner === "host") ? found : undefined;
}

/**
 * The presenter function the view of `entry` presents with on `projection`,
 * if any: a projection of the entry is valid while it stays the same.
 */
export function entryPresenter(
	entry: CommittedSessionEntry,
	source: PresentationSource,
	projection: Projection,
): unknown {
	if (entry.type === "custom_message") return messagePresenter(source, entry.customType, projection)?.present;
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	switch (message.role) {
		case "toolResult":
			return toolPresenter(source, message.toolName)?.present;
		case "bashExecution":
			return toolPresenter(source, "bash")?.present;
		case "custom":
			return messagePresenter(source, message.customType, projection)?.present;
		default:
			return undefined;
	}
}

/** `nodes` with each image node replaced by its description: what a paired device is sent instead of image data. */
export function withoutImages(nodes: UiNode[] | undefined): UiNode[] | undefined {
	if (nodes === undefined) return undefined;
	return nodes.map((node): UiNode => {
		switch (node.type) {
			case "image":
				return {
					type: "text",
					...(node.key === undefined ? {} : { key: node.key }),
					text: `[Image: ${node.alt ?? node.mimeType}]`,
					token: "muted",
				};
			case "list":
				return { ...node, items: withoutImages(node.items) ?? [] };
			case "card":
				return node.sections === undefined
					? node
					: {
							...node,
							sections: node.sections.map((section) => ({
								...section,
								children: withoutImages(section.children) ?? [],
							})),
						};
			default:
				return node;
		}
	});
}

/** A presentation as `projection` sends it: without image data on the remote projection. */
function forProjection<T extends ToolPresentation | MessagePresentation>(
	presentation: T,
	projection: Projection,
	unfit: T,
): T {
	if (projection.fidelity === "full") return presentation;
	const summary = withoutImages(presentation.summary);
	const body = withoutImages(presentation.body);
	const shaped = {
		...presentation,
		...(summary === undefined ? {} : { summary }),
		...(body === undefined ? {} : { body }),
	} as T;
	// Image descriptions can outgrow tiny image data: a presentation that no longer fits is `unfit`.
	return fitPresentation(shaped, projection.presentationBytes) ?? unfit;
}

/**
 * The presentation of a tool call that ended with a committed result. The
 * generic presentation shows `genericArgs`: the arguments the transcript
 * view itself carries, never more than the projection sends.
 */
export function projectToolPresentation(
	toolName: string,
	input: Omit<ToolPresentInput, "cwd">,
	genericArgs: Record<string, unknown>,
	source: PresentationSource,
	projection: Projection,
): ToolPresentation {
	const presentation = presentToolCall(
		toolPresenter(source, toolName),
		toolName,
		{ ...input, cwd: projection.source(source.cwd) },
		projection.presentationBytes,
		genericArgs,
	);
	return forProjection(presentation, projection, { title: presentation.title });
}

/** The presentation of a custom message, when its type has a presenter the projection runs. */
export function projectMessagePresentation(
	message: MessagePresentInput,
	source: PresentationSource,
	projection: Projection,
): MessagePresentation | undefined {
	const presenter = messagePresenter(source, message.customType, projection);
	if (presenter === undefined) return undefined;
	const presentation = presentCustomMessage(presenter, message, projection.presentationBytes);
	return presentation === undefined
		? undefined
		: forProjection(presentation, projection, {
				...(presentation.title === undefined ? {} : { title: presentation.title }),
				body: [],
			});
}
