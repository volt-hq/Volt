import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { CONTRACT_LIMITS, CONTRACT_SCHEMA_REGISTRY } from "../src/contract.ts";
import { CONTROL_EVENT_SCHEMAS, CONTROL_REQUEST_SCHEMAS, CONTROL_RESPONSE_SCHEMAS } from "../src/daemon-control.ts";
import { CORE_LOG_ENTRY_TYPES } from "../src/entries.ts";
import { CLIENT_FRAME_SCHEMAS, HOST_FRAME_SCHEMAS } from "../src/frames.ts";
import { BUILTIN_INTENT_NAMES, INTENT_SCHEMAS } from "../src/intents.ts";
import { LIVE_ITEM_SCHEMAS, LIVE_VALUE_SCHEMAS } from "../src/live.ts";
import { PROJECTED_ENTRY_TYPES } from "../src/projected.ts";
import { QUERY_NAMES } from "../src/queries.ts";
import { UI_NODE_TERMINAL_MAX_LINES } from "../src/ui-node.ts";
import {
	DEFAULT_CONVERSATION_PROJECTION_MAX_QUEUED_BYTES,
	DEFAULT_IROH_RPC_MAX_ENCODED_LINE_BYTES,
	IROH_REMOTE_TRANSCRIPT_TEXT_MAX_SCALARS,
	RPC_CONVERSATION_INPUT_MESSAGE_MAX_UTF8_BYTES,
	RPC_SESSION_QUEUE_MAX_ITEMS,
} from "../src/wire-limits.ts";

const artifactPath = join(import.meta.dirname, "..", "contract", "protocol-schema.json");

interface Artifact {
	$schema: string;
	"x-volt-limits": typeof CONTRACT_LIMITS;
	$defs: Record<string, unknown>;
}

function loadArtifact(): Artifact {
	return JSON.parse(readFileSync(artifactPath, "utf8")) as Artifact;
}

function collectRefs(node: unknown, refs: Set<string>): void {
	if (Array.isArray(node)) {
		for (const item of node) collectRefs(item, refs);
		return;
	}
	if (typeof node !== "object" || node === null) return;
	for (const [key, value] of Object.entries(node)) {
		if (key === "$ref" && typeof value === "string") {
			refs.add(value);
		} else {
			collectRefs(value, refs);
		}
	}
}

describe("committed protocol contract artifact", () => {
	test("declares every registry definition and only those", () => {
		const artifact = loadArtifact();
		const declared = new Set(Object.keys(artifact.$defs));
		for (const name of CONTRACT_SCHEMA_REGISTRY.keys()) {
			expect(declared, `registry entry ${name} missing from artifact`).toContain(name);
		}
		expect(declared.size).toBe(CONTRACT_SCHEMA_REGISTRY.size);
	});

	test("every $ref resolves to a declared definition", () => {
		const artifact = loadArtifact();
		const refs = new Set<string>();
		collectRefs(artifact.$defs, refs);
		expect(refs.size).toBeGreaterThan(100);
		for (const ref of refs) {
			expect(ref.startsWith("#/$defs/")).toBe(true);
			expect(artifact.$defs, `unresolved $ref ${ref}`).toHaveProperty(ref.slice("#/$defs/".length));
		}
	});

	test("declares the closed protocol only: no open event vocabulary or RPC command unions", () => {
		const artifact = loadArtifact();
		expect(Object.keys(artifact)).toEqual(["$schema", "title", "x-volt-generated", "x-volt-limits", "$defs"]);
		for (const name of Object.keys(artifact.$defs)) {
			expect(name).not.toMatch(/^Rpc(Command|Response|ServerEvent|ClientMessage)(\.|$)/);
		}
	});

	test("control unions cover every daemon request, response, and event", () => {
		const artifact = loadArtifact();
		for (const [union, schemas] of [
			["Control.Request", CONTROL_REQUEST_SCHEMAS],
			["Control.Response", CONTROL_RESPONSE_SCHEMAS],
			["Control.Event", CONTROL_EVENT_SCHEMAS],
		] as const) {
			const definition = artifact.$defs[union] as { anyOf: Array<{ $ref: string }> };
			expect(definition.anyOf.map((member) => member.$ref)).toEqual(
				Object.keys(schemas).map((type) => `#/$defs/${union}.${type}`),
			);
		}
	});

	test("x-volt-limits carries the live host constants", () => {
		const artifact = loadArtifact();
		const limits = artifact["x-volt-limits"];
		expect(limits).toEqual(JSON.parse(JSON.stringify(CONTRACT_LIMITS)));
		expect(limits.conversationInput.messageMaxUtf8Bytes).toBe(RPC_CONVERSATION_INPUT_MESSAGE_MAX_UTF8_BYTES);
		expect(limits.conversationInput.queueMaxItems).toBe(RPC_SESSION_QUEUE_MAX_ITEMS);
		expect(limits.remoteProfile.liveQueueBytes).toBe(DEFAULT_CONVERSATION_PROJECTION_MAX_QUEUED_BYTES);
		expect(limits.remoteProfile.textMaxScalars).toBe(IROH_REMOTE_TRANSCRIPT_TEXT_MAX_SCALARS);
		expect(limits.jsonl.maxEncodedLineBytes).toBe(DEFAULT_IROH_RPC_MAX_ENCODED_LINE_BYTES);
		expect(limits.uiNode.terminalMaxLines).toBe(UI_NODE_TERMINAL_MAX_LINES);
	});

	test("the log entry union covers every core entry type, each with a closed envelope", () => {
		const artifact = loadArtifact();
		const entryUnion = artifact.$defs.LogEntry as { anyOf: Array<{ $ref: string }> };
		expect(entryUnion.anyOf.map((member) => member.$ref)).toEqual(
			Object.keys(CORE_LOG_ENTRY_TYPES).map((type) => `#/$defs/LogEntry.${type}`),
		);
		for (const type of Object.keys(CORE_LOG_ENTRY_TYPES)) {
			const entry = artifact.$defs[`LogEntry.${type}`] as {
				required: string[];
				properties: Record<string, unknown>;
				additionalProperties: boolean;
			};
			expect(entry.additionalProperties).toBe(false);
			expect(entry.required).toEqual(["ordinal", "id", "parentId", "type", "timestamp", "visibility", "payload"]);
			expect(entry.properties.payload).toEqual({ $ref: `#/$defs/LogEntryPayload.${type}` });
		}
	});

	test("the protocol frame unions are closed and cover every frame, intent, and query", () => {
		const artifact = loadArtifact();
		const refs = (name: string) =>
			(artifact.$defs[name] as { anyOf: Array<{ $ref: string }> }).anyOf.map((member) => member.$ref);
		expect(refs("ClientFrame")).toEqual([
			...Object.keys(CLIENT_FRAME_SCHEMAS).map((type) => `#/$defs/Frame.${type}`),
			"#/$defs/Frame.intent",
			"#/$defs/Frame.query",
		]);
		expect(refs("HostFrame")).toEqual(Object.keys(HOST_FRAME_SCHEMAS).map((type) => `#/$defs/Frame.${type}`));
		expect(refs("Frame.intent")).toEqual([
			...BUILTIN_INTENT_NAMES.map((name) => `#/$defs/Frame.intent.${name}`),
			"#/$defs/Frame.intent.dynamic",
		]);
		expect(refs("Frame.query")).toEqual(QUERY_NAMES.map((name) => `#/$defs/Frame.query.${name}`));
		expect(refs("ProjectedEntry")).toEqual(
			Object.keys(PROJECTED_ENTRY_TYPES).map((type) => `#/$defs/ProjectedEntry.${type}`),
		);
		expect(refs("LiveValue")).toEqual(Object.keys(LIVE_VALUE_SCHEMAS).map((kind) => `#/$defs/LiveValue.${kind}`));
		expect(refs("LiveItem")).toEqual(Object.keys(LIVE_ITEM_SCHEMAS).map((type) => `#/$defs/LiveItem.${type}`));

		const closedObjects = (name: string): boolean => {
			const definition = artifact.$defs[name] as {
				$ref?: string;
				type?: string;
				anyOf?: unknown[];
				additionalProperties?: boolean;
			};
			if (definition.$ref !== undefined) return closedObjects(definition.$ref.slice("#/$defs/".length));
			if (definition.type !== "object" && definition.anyOf !== undefined) {
				return definition.anyOf.every((member) => {
					const ref = (member as { $ref?: string }).$ref;
					return ref === undefined
						? (member as { additionalProperties?: boolean }).additionalProperties === false
						: closedObjects(ref.slice("#/$defs/".length));
				});
			}
			return definition.additionalProperties === false;
		};
		for (const name of Object.keys(artifact.$defs)) {
			if (/^(Frame|IntentInput|QueryParams|LiveValue|LiveItem|ProjectedEntry)\./.test(name)) {
				expect(closedObjects(name), `${name} is not closed`).toBe(true);
			}
		}
		for (const name of BUILTIN_INTENT_NAMES) {
			expect(artifact.$defs).toHaveProperty([`IntentInput.${name}`]);
			const output = (INTENT_SCHEMAS[name] as { output?: unknown }).output;
			expect(`IntentOutput.${name}` in artifact.$defs).toBe(output !== undefined);
		}
		for (const name of QUERY_NAMES) {
			expect(artifact.$defs).toHaveProperty([`QueryParams.${name}`]);
			expect(artifact.$defs).toHaveProperty([`QueryResult.${name}`]);
		}
	});

	test.each(["UiNode", "UiTreeItem"])(
		"the recursive %s definition is hoisted with pointer refs and no $id",
		(name) => {
			const artifact = loadArtifact();
			const definition = JSON.stringify(artifact.$defs[name]);
			expect(definition).toContain(`"$ref":"#/$defs/${name}"`);
			expect(definition).not.toContain('"$id"');
			expect(definition).not.toContain('"$defs"');
		},
	);
});
