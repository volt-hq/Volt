/**
 * One readable message for a schema validation failure: the first missing
 * field, else the first unrecognized field, else the deepest mismatch, worded
 * from the failing sub-schema's `x-volt-expected` annotation when it has one.
 */

import type { TObject, TSchema } from "typebox";
import type { TLocalizedValidationError } from "typebox/error";

function instancePathSegments(instancePath: string): string[] {
	if (instancePath === "") return [];
	return instancePath
		.slice(1)
		.split("/")
		.map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function formatFieldPath(segments: string[]): string {
	let path = "";
	for (const segment of segments) {
		if (/^\d+$/.test(segment)) {
			path += `[${segment}]`;
		} else {
			path += path === "" ? segment : `.${segment}`;
		}
	}
	return path;
}

/** Walks a command schema along an error's instance path to the failing sub-schema. */
function resolveSubSchema(root: TObject, segments: string[]): TSchema | undefined {
	let current: TSchema | undefined = root;
	for (const segment of segments) {
		if (current === undefined) return undefined;
		const node = current as Record<string, unknown>;
		const properties = node.properties as Record<string, TSchema> | undefined;
		if (properties && Object.hasOwn(properties, segment)) {
			current = properties[segment];
			continue;
		}
		if (node.items !== undefined && /^\d+$/.test(segment)) {
			current = node.items as TSchema;
			continue;
		}
		const patternProperties = node.patternProperties as Record<string, TSchema> | undefined;
		if (patternProperties) {
			current = Object.values(patternProperties)[0];
			continue;
		}
		return undefined;
	}
	return current;
}

function quotedOrList(values: readonly unknown[]): string {
	const quoted = values.map((value) => (typeof value === "string" ? `"${value}"` : JSON.stringify(value)));
	if (quoted.length <= 1) return quoted.join("");
	if (quoted.length === 2) return `${quoted[0]} or ${quoted[1]}`;
	return `${quoted.slice(0, -1).join(", ")}, or ${quoted.at(-1)}`;
}

function describeBranch(schema: TSchema): string {
	const node = schema as Record<string, unknown>;
	if (node.const !== undefined) return typeof node.const === "string" ? `"${node.const}"` : JSON.stringify(node.const);
	return describeType(node.type);
}

function describeType(type: unknown): string {
	switch (type) {
		case "string":
			return "a string";
		case "boolean":
			return "a boolean";
		case "number":
			return "a number";
		case "integer":
			return "an integer";
		case "object":
			return "an object";
		case "array":
			return "an array";
		case "null":
			return "null";
		default:
			return "valid";
	}
}

/** The clause after `must ` for a failing sub-schema, e.g. `be "steer" or "followUp"`. */
function expectedPhrase(schema: TSchema | undefined): string {
	if (schema === undefined) return "be valid";
	const node = schema as Record<string, unknown>;
	const annotated = node["x-volt-expected"];
	if (typeof annotated === "string") return annotated;
	if (Array.isArray(node.enum)) return `be ${quotedOrList(node.enum)}`;
	if (node.const !== undefined) return `be ${describeBranch(schema)}`;
	if (Array.isArray(node.anyOf)) {
		const branches = (node.anyOf as TSchema[]).map(describeBranch);
		return `be ${branches.length <= 1 ? branches.join("") : `${branches.slice(0, -1).join(", ")}${branches.length === 2 ? "" : ","} or ${branches.at(-1)}`}`;
	}
	return `be ${describeType(node.type)}`;
}

/**
 * Turns compiled-validator errors into one legacy-shaped message. Precedence:
 * missing required field, then unrecognized field, then the most specific
 * (deepest, non-anyOf) mismatch.
 */
export function formatSchemaError(schema: TObject, errors: TLocalizedValidationError[]): string {
	const params = (error: TLocalizedValidationError) => error.params as Record<string, unknown> | undefined;

	const required = errors.find((error) => error.keyword === "required");
	if (required) {
		const missing = params(required)?.requiredProperties;
		const first = Array.isArray(missing) ? String(missing[0]) : "?";
		return `"${formatFieldPath([...instancePathSegments(required.instancePath), first])}" is required`;
	}

	const additional = errors.find((error) => error.keyword === "additionalProperties");
	if (additional) {
		const names = params(additional)?.additionalProperties;
		const first = Array.isArray(names) ? String(names[0]) : "?";
		return `"${formatFieldPath([...instancePathSegments(additional.instancePath), first])}" is not a recognized field`;
	}

	let pick: TLocalizedValidationError | undefined;
	let pickDepth = -1;
	for (const error of errors) {
		if (error.keyword === "anyOf") continue;
		const depth = instancePathSegments(error.instancePath).length;
		if (depth > pickDepth) {
			pick = error;
			pickDepth = depth;
		}
	}
	if (pick === undefined) return "does not match the command schema";
	const segments = instancePathSegments(pick.instancePath);
	return `"${formatFieldPath(segments)}" must ${expectedPhrase(resolveSubSchema(schema, segments))}`;
}
