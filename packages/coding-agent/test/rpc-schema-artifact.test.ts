import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	RPC_COMMAND_SCHEMAS,
	RPC_RESPONSE_SCHEMAS,
	RPC_SCHEMA_REGISTRY,
	RPC_WIRE_LIMITS,
} from "../src/core/rpc/schema/index.ts";
import {
	DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CONTENT_BLOCKS,
	DEFAULT_IROH_RPC_MAX_ENCODED_LINE_BYTES,
	RPC_CONVERSATION_INPUT_MESSAGE_MAX_UTF8_BYTES,
	RPC_SESSION_STATE_MAX_SERIALIZED_BYTES,
	RPC_STABLE_ERROR_CODES,
	RPC_TRANSCRIPT_PAGE_MAX_ITEMS,
} from "../src/core/rpc/wire-limits.ts";

const artifactPath = join(import.meta.dirname, "..", "contract", "rpc-schema.json");

interface Artifact {
	$schema: string;
	"x-volt-limits": typeof RPC_WIRE_LIMITS;
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

describe("committed RPC schema artifact", () => {
	test("declares every registry definition and only those", () => {
		const artifact = loadArtifact();
		const declared = new Set(Object.keys(artifact.$defs));
		for (const name of RPC_SCHEMA_REGISTRY.keys()) {
			expect(declared, `registry entry ${name} missing from artifact`).toContain(name);
		}
		expect(declared.size).toBe(RPC_SCHEMA_REGISTRY.size);
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

	test("wire unions cover every command and response", () => {
		const artifact = loadArtifact();
		const commandUnion = artifact.$defs.RpcCommand as { anyOf: Array<{ $ref: string }> };
		expect(commandUnion.anyOf.map((member) => member.$ref)).toEqual(
			Object.keys(RPC_COMMAND_SCHEMAS).map((type) => `#/$defs/RpcCommand.${type}`),
		);
		const responseUnion = artifact.$defs.RpcResponse as { anyOf: Array<{ $ref: string }> };
		expect(responseUnion.anyOf.map((member) => member.$ref)).toEqual([
			...Object.keys(RPC_RESPONSE_SCHEMAS).map((command) => `#/$defs/RpcResponse.${command}`),
			"#/$defs/RpcErrorResponse",
		]);
	});

	test("x-volt-limits carries the live host constants", () => {
		const artifact = loadArtifact();
		const limits = artifact["x-volt-limits"];
		expect(limits).toEqual(JSON.parse(JSON.stringify(RPC_WIRE_LIMITS)));
		expect(limits.conversationInput.messageMaxUtf8Bytes).toBe(RPC_CONVERSATION_INPUT_MESSAGE_MAX_UTF8_BYTES);
		expect(limits.sessionState.maxSerializedBytes).toBe(RPC_SESSION_STATE_MAX_SERIALIZED_BYTES);
		expect(limits.conversationProjection.assistantMaxContentBlocks).toBe(
			DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CONTENT_BLOCKS,
		);
		expect(limits.transcript.pageMaxItems).toBe(RPC_TRANSCRIPT_PAGE_MAX_ITEMS);
		expect(limits.jsonl.maxEncodedLineBytes).toBe(DEFAULT_IROH_RPC_MAX_ENCODED_LINE_BYTES);
		expect(limits.stableErrorCodes).toEqual([...RPC_STABLE_ERROR_CODES]);
	});

	test("the recursive truncation definition is hoisted with pointer refs and no $id", () => {
		const artifact = loadArtifact();
		const truncation = JSON.stringify(artifact.$defs.RpcProjectionTruncation);
		expect(truncation).toContain('"$ref":"#/$defs/RpcProjectionTruncation"');
		expect(truncation).not.toContain('"$id"');
		expect(truncation).not.toContain('"$defs"');
	});
});
