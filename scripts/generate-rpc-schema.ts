/**
 * Generates the committed RPC contract artifact
 * (packages/coding-agent/contract/rpc-schema.json) from the TypeBox schema
 * registry — the same definitions that produce the static types and runtime
 * validation, so the artifact cannot drift from the host.
 *
 *   node scripts/generate-rpc-schema.ts           # write the artifact
 *   node scripts/generate-rpc-schema.ts --check   # fail if it is stale
 *
 * Registered schemas referenced inside other schemas are emitted as
 * `#/$defs/<Name>` pointers (matched by object identity); the one recursive
 * definition (Type.Cyclic) has its inner $defs hoisted to the top level with
 * its name-style refs rewritten to standard JSON pointers.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RPC_SCHEMA_REGISTRY, RPC_WIRE_LIMITS } from "../packages/coding-agent/src/core/rpc/schema/index.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const artifactPath = join(repoRoot, "packages", "coding-agent", "contract", "rpc-schema.json");
const checkOnly = process.argv.includes("--check");

const namesBySchema = new Map<object, string>();
const namesByContent = new Map<string, string>();
for (const [name, schema] of RPC_SCHEMA_REGISTRY) {
	if (!namesBySchema.has(schema)) {
		namesBySchema.set(schema, name);
	}
	const content = JSON.stringify(schema);
	if (!namesByContent.has(content)) {
		namesByContent.set(content, name);
	}
}

/**
 * Resolves a node to its registered definition name. Identity first;
 * serialized content second, because TypeBox modifiers (Type.Optional)
 * deep-clone their argument and would otherwise inline every wrapped
 * reference. Content twins registered under two names alias to the first.
 */
function lookupName(node: object, selfName: string | undefined): string | undefined {
	const byIdentity = namesBySchema.get(node);
	if (byIdentity !== undefined) {
		return byIdentity === selfName ? undefined : byIdentity;
	}
	const byContent = namesByContent.get(JSON.stringify(node));
	return byContent === selfName ? undefined : byContent;
}

const defs: Record<string, unknown> = {};

function ensureDef(name: string): void {
	if (name in defs) return;
	defs[name] = null; // reserve so reference cycles terminate
	const schema = RPC_SCHEMA_REGISTRY.get(name);
	if (schema === undefined) {
		throw new Error(`Schema registry has no entry named ${name}`);
	}
	defs[name] = serialize(schema, name);
}

function serialize(node: unknown, selfName?: string): unknown {
	if (Array.isArray(node)) {
		return node.map((item) => serialize(item));
	}
	if (typeof node !== "object" || node === null) {
		return node;
	}
	const registered = lookupName(node, selfName);
	if (registered !== undefined) {
		ensureDef(registered);
		return { $ref: `#/$defs/${registered}` };
	}
	const record = node as Record<string, unknown>;
	if (typeof record.$ref === "string" && typeof record.$defs === "object" && record.$defs !== null) {
		// Type.Cyclic wrapper: hoist its inner definitions to the artifact root.
		const inner = record.$defs as Record<string, unknown>;
		const innerNames = new Set(Object.keys(inner));
		for (const [name, def] of Object.entries(inner)) {
			if (!(name in defs) || (name === selfName && defs[name] === null)) {
				if (!(name in defs)) defs[name] = null;
				defs[name] = serializeCyclicDef(def, innerNames);
			}
		}
		return selfName !== undefined && record.$ref === selfName
			? defs[record.$ref]
			: { $ref: `#/$defs/${record.$ref}` };
	}
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		out[key] = serialize(value);
	}
	return out;
}

/** Serializes a Cyclic inner definition: name-style refs become JSON pointers, `$id` markers are dropped. */
function serializeCyclicDef(node: unknown, innerNames: ReadonlySet<string>): unknown {
	if (Array.isArray(node)) {
		return node.map((item) => serializeCyclicDef(item, innerNames));
	}
	if (typeof node !== "object" || node === null) {
		return node;
	}
	const registered = lookupName(node, undefined);
	if (registered !== undefined) {
		ensureDef(registered);
		return { $ref: `#/$defs/${registered}` };
	}
	const record = node as Record<string, unknown>;
	if (typeof record.$ref === "string" && innerNames.has(record.$ref) && Object.keys(record).length === 1) {
		return { $ref: `#/$defs/${record.$ref}` };
	}
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		if (key === "$id" && typeof value === "string" && innerNames.has(value)) {
			continue;
		}
		out[key] = serializeCyclicDef(value, innerNames);
	}
	return out;
}

for (const name of RPC_SCHEMA_REGISTRY.keys()) {
	ensureDef(name);
}

const sortedDefs: Record<string, unknown> = {};
for (const name of Object.keys(defs).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
	sortedDefs[name] = defs[name];
}

const artifact = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	title: "Volt RPC contract",
	"x-volt-generated":
		"Generated from packages/coding-agent/src/core/rpc/schema — run `npm run contract:rpc`; do not edit by hand.",
	"x-volt-open-events":
		"The RpcServerEvent union is the declared vocabulary; plain-mode hosts pass additional session events through verbatim. Clients must ignore unknown event types.",
	"x-volt-limits": RPC_WIRE_LIMITS,
	$defs: sortedDefs,
};

const content = `${JSON.stringify(artifact, null, "\t")}\n`;

if (checkOnly) {
	if (!existsSync(artifactPath)) {
		console.error("packages/coding-agent/contract/rpc-schema.json is missing.");
		console.error("Run: npm run contract:rpc");
		process.exit(1);
	}
	const current = readFileSync(artifactPath, "utf8");
	if (current !== content) {
		console.error("packages/coding-agent/contract/rpc-schema.json is out of date.");
		console.error("Run: npm run contract:rpc");
		process.exit(1);
	}
	console.log("packages/coding-agent/contract/rpc-schema.json is up to date.");
} else {
	mkdirSync(dirname(artifactPath), { recursive: true });
	writeFileSync(artifactPath, content);
	console.log(`Wrote ${artifactPath}`);
}
