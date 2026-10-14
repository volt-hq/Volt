/**
 * What clients are told about a conversation's extensions and the review engines they register, built and
 * filtered in one place: the live `extensions` and `review.engines` queries and the `extension_inventory`
 * query (what a conversation would load, predicted before one exists) all use these views, so a predicted
 * answer and a live one cannot drift apart.
 *
 * Each item has a local view, for a client at the host, and a remote view derived from it: a remote client is
 * told only of the engines a paired device may start, with the parameters it may set (a local-only parameter
 * is not hidden by being refused, it is not mentioned), and never of an extension's fingerprint.
 */

import type { ExtensionSummary, RpcReviewEngine } from "@hansjm10/volt-protocol";
import type { ReviewEngineDeclaration } from "../review-engine.ts";

/** What a conversation in a workspace would load, as the host holds it: the local view of every item. */
export interface ExtensionInventory {
	/** Whether the project was trusted, so its own extensions and settings were included. */
	readonly projectTrusted: boolean;
	/** Every extension it would declare, enabled or not, in load order. */
	readonly extensions: readonly ExtensionSummary[];
	/** The review engines its active extensions register, in load order. */
	readonly reviewEngines: readonly RpcReviewEngine[];
}

/** An engine as a client at the host is told of it: everything it declares but the function that runs it. */
export function reviewEngineView(engine: ReviewEngineDeclaration): RpcReviewEngine {
	const [, extension = "", name = ""] = /^ext:([^/]+)\/(.+)$/.exec(engine.id) ?? [];
	return {
		id: engine.id,
		name,
		extension,
		label: engine.label,
		description: engine.description,
		...(engine.cost === undefined ? {} : { cost: engine.cost }),
		targets: [...engine.targets],
		remoteSafe: engine.remoteSafe,
		...(engine.parameters === undefined
			? {}
			: {
					parameters: {
						type: "object" as const,
						properties: { ...engine.parameters.properties },
						...(engine.parameters.required === undefined || engine.parameters.required.length === 0
							? {}
							: { required: [...engine.parameters.required] }),
					},
				}),
		...(engine.localOnly === undefined ? {} : { localOnly: [...engine.localOnly] }),
	};
}

/**
 * An engine as a remote client is told of it: none when a paired device may not start it; otherwise without
 * the parameters only a client at the host may set, in the parameters or beside them.
 */
export function remoteReviewEngineView(view: RpcReviewEngine): RpcReviewEngine | undefined {
	if (!view.remoteSafe) return undefined;
	const { localOnly, parameters, ...rest } = view;
	if (parameters === undefined) return rest;
	const hidden = new Set(localOnly ?? []);
	const required = (parameters.required ?? []).filter((name) => !hidden.has(name));
	return {
		...rest,
		parameters: {
			type: "object",
			properties: Object.fromEntries(Object.entries(parameters.properties).filter(([name]) => !hidden.has(name))),
			...(required.length === 0 ? {} : { required }),
		},
	};
}

/** An extension as a client not at the host is told of it: without the fingerprint of its code. */
export function remoteExtensionSummary(summary: ExtensionSummary): ExtensionSummary {
	const { fingerprint: _fingerprint, ...rest } = summary;
	return rest;
}

/** An inventory as a remote client is told of it: each item's remote view. */
export function remoteExtensionInventoryView(inventory: ExtensionInventory): ExtensionInventory {
	return {
		projectTrusted: inventory.projectTrusted,
		extensions: inventory.extensions.map(remoteExtensionSummary),
		reviewEngines: inventory.reviewEngines.flatMap((engine) => remoteReviewEngineView(engine) ?? []),
	};
}
