/**
 * Presentations of projected entries (RFC §4.3, amended): a tool item's and
 * a presented custom message's `view.presentation` is a pure function of the
 * log, the profile, and the presenter set. It is computed when the entry is
 * projected and never stored; a cache keeps it per profile and entry id while
 * the presenter set's generation and the entry's presenter stay the same.
 *
 * A profile bounds presentations (`limits.presentationBytes`). On the remote
 * profile the presenter sees the entry with its paths redacted, image nodes
 * are replaced by their description (images are fetched with the `content`
 * query), and extension message presenters do not run: the custom messages
 * a paired device sees are the host's own.
 */

import type { MessagePresentation, ToolPresentation, UiNode } from "@hansjm10/volt-protocol";
import {
	fitPresentation,
	type MessagePresentInput,
	type PresenterSet,
	presentCustomMessage,
	presentToolCall,
	type ResolvedMessagePresenter,
	type ResolvedToolPresenter,
	serializedBytes,
	type ToolPresentInput,
} from "../../ui/presentation.ts";
import type { Profile } from "../profiles.ts";

/** Most presentations one profile keeps cached in one conversation. */
const PRESENTATION_CACHE_MAX_ENTRIES = 4_096;
/** Most serialized bytes of presentations one profile keeps cached in one conversation. */
const PRESENTATION_CACHE_MAX_BYTES = 8 * 1024 * 1024;

interface Cached {
	readonly generation: number;
	readonly presenter: unknown;
	readonly value: ToolPresentation | MessagePresentation | undefined;
	readonly bytes: number;
}

interface ProfileCache {
	readonly entries: Map<string, Cached>;
	bytes: number;
}

/** The presentations computed for projected entries, by profile and entry id, the least recently computed evicted first. */
export class PresentationCache {
	private readonly byProfile = new WeakMap<Profile, ProfileCache>();

	/**
	 * The presentation of entry `id` for `profile`: the cached one while the
	 * generation and presenter are the same, else `compute()`'s.
	 */
	resolve<T extends ToolPresentation | MessagePresentation | undefined>(
		profile: Profile,
		id: string,
		generation: number,
		presenter: unknown,
		compute: () => T,
	): T {
		let cache = this.byProfile.get(profile);
		const cached = cache?.entries.get(id);
		if (cached && cached.generation === generation && cached.presenter === presenter) return cached.value as T;
		const value = compute();
		if (!cache) {
			cache = { entries: new Map(), bytes: 0 };
			this.byProfile.set(profile, cache);
		}
		const bytes = value === undefined ? 0 : serializedBytes(value);
		if (cached) cache.bytes -= cached.bytes;
		cache.entries.delete(id);
		cache.entries.set(id, { generation, presenter, value, bytes });
		cache.bytes += bytes;
		for (const [oldest, entry] of cache.entries) {
			if (cache.entries.size <= PRESENTATION_CACHE_MAX_ENTRIES && cache.bytes <= PRESENTATION_CACHE_MAX_BYTES) break;
			cache.entries.delete(oldest);
			cache.bytes -= entry.bytes;
		}
		return value;
	}
}

/** What presenting a projected entry reads: the presenters, the working directory, and the cache. */
export interface PresentationSource {
	readonly presenters: PresenterSet;
	readonly cwd: string;
	readonly cache?: PresentationCache;
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

/** A presentation as `profile` sends it: without image data on the remote profile. */
function forProfile<T extends ToolPresentation | MessagePresentation>(presentation: T, profile: Profile, unfit: T): T {
	if (profile.fidelity === "full") return presentation;
	const summary = withoutImages(presentation.summary);
	const body = withoutImages(presentation.body);
	const shaped = {
		...presentation,
		...(summary === undefined ? {} : { summary }),
		...(body === undefined ? {} : { body }),
	} as T;
	// Image descriptions can outgrow tiny image data: a presentation that no longer fits is `unfit`.
	return fitPresentation(shaped, profile.limits.presentationBytes) ?? unfit;
}

/**
 * The presentation of a tool call that ended with a committed result. The
 * generic presentation shows `genericArgs`: the arguments the transcript
 * view itself carries, never more than the profile sends.
 */
export function projectToolPresentation(
	id: string,
	toolName: string,
	input: Omit<ToolPresentInput, "cwd">,
	genericArgs: Record<string, unknown>,
	source: PresentationSource,
	profile: Profile,
): ToolPresentation {
	const presenter: ResolvedToolPresenter | undefined = source.presenters.tool(toolName);
	const compute = (): ToolPresentation => {
		const presentation = presentToolCall(
			presenter,
			toolName,
			{ ...input, cwd: profile.source(source.cwd) },
			profile.limits.presentationBytes,
			genericArgs,
		);
		return forProfile(presentation, profile, { title: presentation.title });
	};
	return source.cache
		? source.cache.resolve(profile, id, source.presenters.generation, presenter?.present, compute)
		: compute();
}

/** The presentation of a custom message, when its type has a presenter the profile runs. */
export function projectMessagePresentation(
	id: string,
	message: MessagePresentInput,
	source: PresentationSource,
	profile: Profile,
): MessagePresentation | undefined {
	const found: ResolvedMessagePresenter | undefined = source.presenters.message(message.customType);
	const presenter =
		found !== undefined && (profile.fidelity === "full" || found.policy.owner === "host") ? found : undefined;
	if (presenter === undefined) return undefined;
	const compute = (): MessagePresentation | undefined => {
		const presentation = presentCustomMessage(presenter, message, profile.limits.presentationBytes);
		return presentation === undefined
			? undefined
			: forProfile(presentation, profile, {
					...(presentation.title === undefined ? {} : { title: presentation.title }),
					body: [],
				});
	};
	return source.cache
		? source.cache.resolve(profile, id, source.presenters.generation, presenter.present, compute)
		: compute();
}
