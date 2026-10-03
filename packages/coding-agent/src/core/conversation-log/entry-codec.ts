/**
 * Conversion between the two forms of a session log entry: the log form
 * (`@hansjm10/volt-protocol` envelope with a `payload` and a fixed
 * `visibility`) and the stored session form (envelope fields flattened beside
 * the payload fields, visibility implied by the type).
 */

import type { ConversationLogEntry, ConversationLogEntryDraft } from "@hansjm10/volt-agent-core";
import { LOG_ENTRY_ENVELOPE_KEYS, type LogEntryType, type LogEntryVisibility } from "@hansjm10/volt-protocol/entries";
import { parsePersistedSessionEntry } from "../session-entry-codec.ts";
import { SESSION_ENTRY_TYPES } from "../session-entry-types.ts";
import type { CommittedSessionEntry, SessionEntry } from "../session-manager.ts";

interface EntryShape {
	readonly visibility: LogEntryVisibility;
	/** Fields stored beside the envelope that are not payload (the message entry's `clientMessageId`). */
	readonly extensions: ReadonlySet<string>;
}

const ENVELOPE_KEYS: ReadonlySet<string> = new Set(LOG_ENTRY_ENVELOPE_KEYS);
const STORED_ENVELOPE_KEYS: ReadonlySet<string> = new Set(["type", "id", "parentId", "timestamp", "ordinal"]);
const ENTRY_SHAPES: ReadonlyMap<string, EntryShape> = new Map(
	Object.values(SESSION_ENTRY_TYPES).map((definition: LogEntryType) => [
		definition.type,
		{
			visibility: definition.visibility,
			extensions: new Set(Object.keys(definition.schema.properties).filter((key) => !ENVELOPE_KEYS.has(key))),
		},
	]),
);

function entryShape(type: string): EntryShape {
	const shape = ENTRY_SHAPES.get(type);
	if (!shape) throw new Error(`Entry type ${JSON.stringify(type)} is not stored in session logs`);
	return shape;
}

/**
 * The session form of a log entry or draft at `ordinal`: its envelope and
 * extension fields flattened beside its payload fields, validated as a
 * persisted session entry.
 */
export function toSessionEntry(
	entry: ConversationLogEntryDraft | ConversationLogEntry,
	ordinal: number,
): CommittedSessionEntry {
	const shape = entryShape(entry.type);
	const { id, parentId, type, timestamp, visibility, payload, ...rest } = entry;
	const extensions: Record<string, unknown> = { ...rest };
	delete extensions.ordinal;
	if (visibility !== shape.visibility) {
		throw new Error(`Entry type ${JSON.stringify(type)} has ${shape.visibility} visibility`);
	}
	for (const key of Object.keys(extensions)) {
		if (!shape.extensions.has(key)) throw new Error(`Entry field ${JSON.stringify(key)} is not part of ${type}`);
	}
	const fields: unknown = payload;
	if (fields === null || typeof fields !== "object" || Array.isArray(fields)) {
		throw new Error(`Entry ${JSON.stringify(id)} payload must be an object`);
	}
	for (const key of Object.keys(fields)) {
		if (ENVELOPE_KEYS.has(key) || shape.extensions.has(key)) {
			throw new Error(`Entry ${JSON.stringify(id)} payload field ${JSON.stringify(key)} is an envelope field`);
		}
	}
	return parsePersistedSessionEntry({ ...fields, ...extensions, type, id, parentId, timestamp, ordinal });
}

function logFields(entry: SessionEntry): {
	readonly visibility: LogEntryVisibility;
	readonly payload: Record<string, unknown>;
	readonly extensions: Record<string, unknown>;
} {
	const shape = entryShape(entry.type);
	const payload: Record<string, unknown> = {};
	const extensions: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(entry)) {
		if (STORED_ENVELOPE_KEYS.has(key)) continue;
		if (shape.extensions.has(key)) extensions[key] = value;
		else payload[key] = value;
	}
	return { visibility: shape.visibility, payload, extensions };
}

/** The log form of a session entry a writer submits; the log assigns its ordinal. */
export function toLogEntryDraft(entry: SessionEntry): ConversationLogEntryDraft {
	const { visibility, payload, extensions } = logFields(entry);
	return {
		id: entry.id,
		parentId: entry.parentId,
		type: entry.type,
		timestamp: entry.timestamp,
		visibility,
		payload,
		...extensions,
	};
}

/** The log form of a committed session entry. */
export function toLogEntry(entry: CommittedSessionEntry): ConversationLogEntry {
	const { visibility, payload, extensions } = logFields(entry);
	return {
		ordinal: entry.ordinal,
		id: entry.id,
		parentId: entry.parentId,
		type: entry.type,
		timestamp: entry.timestamp,
		visibility,
		payload,
		...extensions,
	};
}
