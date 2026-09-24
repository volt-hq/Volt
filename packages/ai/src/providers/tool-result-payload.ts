import type { ProviderPayloadMetadata, ToolResultMessage } from "../types.ts";

/** Per-payload provenance. Never stored in messages or serialized provider data. */
export class ToolResultPayloadTracker {
	private readonly sourceIndices = new WeakMap<ToolResultMessage, number>();
	private readonly includedIndices = new Set<number>();

	/** Called during replay transformation, before IDs or message positions lose their source identity. */
	recordSource(message: ToolResultMessage, index: number): void {
		this.sourceIndices.set(message, index);
	}

	/** Called only when the provider serializer emits this result. Synthetic results have no source. */
	include(message: ToolResultMessage): void {
		const index = this.sourceIndices.get(message);
		if (index !== undefined) this.includedIndices.add(index);
	}

	get metadata(): ProviderPayloadMetadata {
		return Object.freeze({ toolResultMessageIndices: Object.freeze([...this.includedIndices]) });
	}
}
