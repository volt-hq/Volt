/**
 * The catalogs the TUI's status reads beside its store: the selectable models
 * (their metadata and how they authenticate), the host settings, and where
 * the conversation's log lives. Each is queried through the TUI's client when
 * a snapshot resets the store and again when the host says it changed;
 * `refresh` queries one again after the TUI changed it outside an intent.
 */

import type { QueryResult } from "@hansjm10/volt-protocol";
import type { TuiStore } from "./tui-store.ts";

type CatalogName = "models" | "settings" | "conversation_info";

export class TuiCatalogs {
	models: QueryResult<"models"> | undefined;
	settings: QueryResult<"settings"> | undefined;
	conversationInfo: QueryResult<"conversation_info"> | undefined;
	private readonly store: TuiStore;
	private readonly onChange: () => void;
	/** The read in flight of each catalog: a newer one supersedes it. */
	private readonly reads = new Map<CatalogName, number>();
	private nextRead = 0;
	private readonly unsubscribe: () => void;

	constructor(store: TuiStore, onChange: () => void) {
		this.store = store;
		this.onChange = onChange;
		this.unsubscribe = store.subscribe((change) => {
			switch (change.type) {
				case "reset":
					this.refresh("models", "settings", "conversation_info");
					return;
				case "moving":
					this.conversationInfo = undefined;
					return;
				case "changed":
					if (change.catalog === "models" || change.catalog === "settings") this.refresh(change.catalog);
					return;
				default:
					return;
			}
		});
	}

	/** Query `names` again. */
	refresh(...names: CatalogName[]): void {
		for (const name of names) void this.read(name);
	}

	dispose(): void {
		this.unsubscribe();
		this.reads.clear();
	}

	private async read(name: CatalogName): Promise<void> {
		const id = ++this.nextRead;
		this.reads.set(name, id);
		try {
			const client = this.store.client;
			if (name === "models") {
				const models = await client.query("models");
				if (this.reads.get(name) === id) this.models = models;
			} else if (name === "settings") {
				const settings = await client.query("settings");
				if (this.reads.get(name) === id) this.settings = settings;
			} else {
				const info = await client.query("conversation_info");
				if (this.reads.get(name) === id) this.conversationInfo = info;
			}
		} catch {
			// A catalog that cannot be read now keeps what was read last; its next change reads it again.
			return;
		}
		if (this.reads.get(name) === id) this.onChange();
	}
}
