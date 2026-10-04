/**
 * Generates the committed protocol contract artifact
 * (packages/protocol/contract/protocol-schema.json) from the TypeBox schema
 * registry — the same definitions that produce the static types and runtime
 * validation, so the artifact cannot drift from the host.
 *
 *   npm run contract:protocol         # write the artifact
 *   npm run check:protocol-contract   # fail if it is stale
 *
 * Registered schemas referenced inside other schemas are emitted as
 * `#/$defs/<Name>` pointers (matched by object identity); recursive
 * definitions (Type.Cyclic) have their inner $defs hoisted to the top level
 * with their name-style refs rewritten to standard JSON pointers.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTRACT_LIMITS, CONTRACT_SCHEMA_REGISTRY } from "../packages/protocol/src/contract.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const artifactRelativePath = "packages/protocol/contract/protocol-schema.json";
const artifactPath = join(repoRoot, ...artifactRelativePath.split("/"));
const checkOnly = process.argv.includes("--check");

const namesBySchema = new Map<object, string>();
const namesByContent = new Map<string, string>();
for (const [name, schema] of CONTRACT_SCHEMA_REGISTRY) {
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
	const schema = CONTRACT_SCHEMA_REGISTRY.get(name);
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

for (const name of CONTRACT_SCHEMA_REGISTRY.keys()) {
	ensureDef(name);
}

const sortedDefs: Record<string, unknown> = {};
for (const name of Object.keys(defs).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
	sortedDefs[name] = defs[name];
}

const artifact = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	title: "Volt protocol contract",
	"x-volt-generated":
		"Generated from packages/protocol/src — run `npm run contract:protocol`; do not edit by hand.",
	"x-volt-limits": CONTRACT_LIMITS,
	$defs: sortedDefs,
};

const content = `${JSON.stringify(artifact, null, "\t")}\n`;

if (checkOnly) {
	if (!existsSync(artifactPath)) {
		console.error(`${artifactRelativePath} is missing.`);
		console.error("Run: npm run contract:protocol");
		process.exit(1);
	}
	const current = readFileSync(artifactPath, "utf8");
	if (current !== content) {
		console.error(`${artifactRelativePath} is out of date.`);
		console.error("Run: npm run contract:protocol");
		process.exit(1);
	}
	console.log(`${artifactRelativePath} is up to date.`);
} else {
	mkdirSync(dirname(artifactPath), { recursive: true });
	writeFileSync(artifactPath, content);
	console.log(`Wrote ${artifactPath}`);
}
