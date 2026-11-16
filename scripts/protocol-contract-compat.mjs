/**
 * Lists the protocol contract changes a Volt iOS build cannot handle.
 *
 * A build checks the frames it receives against the contract it bundled, and
 * the host checks what the build sends against the current contract. So
 * every value the current contract allows in what the build receives must
 * pass the build's contract, and every value the build's contract allows in
 * what it sends must pass the current one. The comparison is conservative: a
 * change it cannot prove safe is reported.
 *
 * `tolerance` is how a build reads host frames: `strict` rejects anything
 * outside its contract; `additive` follows the receiver rules in
 * packages/protocol/README.md, ignoring object fields and variants of the
 * open unions it does not know.
 */

export const TOLERANCES = ["strict", "additive"];

/** Unions whose unknown variants an `additive` build skips (packages/protocol/README.md). */
const OPEN_UNIONS = new Set(["HostFrame", "ProjectedEntry", "LiveItem", "LiveValue", "UiNode"]);

/** Keywords that describe a value without constraining it. */
const ANNOTATIONS = new Set([
	"description",
	"title",
	"default",
	"examples",
	"$comment",
	"x-volt-expected",
	"x-volt-opaque",
	"x-volt-known-values",
	"x-volt-command",
]);

const LOWER_BOUNDS = ["minLength", "minItems", "minProperties"];
const UPPER_BOUNDS = [
	"maxLength",
	"maxItems",
	"maxProperties",
	"x-volt-max-items",
	"x-volt-max-utf8-bytes",
	"x-volt-max-serialized-bytes",
];

/** Constraint keywords compared below; any other constraint must stay unchanged. */
const COMPARED = new Set([
	"$ref",
	"type",
	"const",
	"enum",
	"anyOf",
	"not",
	"properties",
	"required",
	"additionalProperties",
	"patternProperties",
	"items",
	"uniqueItems",
	"pattern",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	...LOWER_BOUNDS,
	...UPPER_BOUNDS,
]);

/**
 * The definitions a build receives and sends. Query results and intent
 * outputs ride in opaque frame fields, so they are roots of their own.
 * @param {Record<string, unknown>} defs
 */
export function appRoots(defs) {
	const names = Object.keys(defs);
	return {
		receives: [
			"HostFrame",
			"RemoteHandshake.Response",
			"IrohRemotePushNotification",
			...names.filter((name) => name.startsWith("QueryResult.") || name.startsWith("IntentOutput.")),
		].filter((name) => name in defs),
		sends: ["ClientFrame", "RemoteHandshake.Hello"].filter((name) => name in defs),
	};
}

/**
 * @typedef {{ direction: "receives" | "sends", path: string, detail: string }} Incompatibility
 *   `path` names the definition, then the fields and `[]` array items inside it.
 */

/**
 * @param {object} input
 * @param {{ $defs: Record<string, unknown> }} input.baseline the contract the build bundled
 * @param {{ $defs: Record<string, unknown> }} input.current
 * @param {"strict" | "additive"} input.tolerance
 * @returns {Incompatibility[]} sorted by path, each listed once
 */
export function contractIncompatibilities({ baseline, current, tolerance }) {
	if (!TOLERANCES.includes(tolerance)) throw new Error(`Unknown tolerance: ${tolerance}`);
	const findings = [];
	const roots = appRoots(baseline.$defs);
	for (const direction of /** @type {const} */ (["receives", "sends"])) {
		const receives = direction === "receives";
		const ctx = {
			direction,
			subDefs: receives ? current.$defs : baseline.$defs,
			supDefs: receives ? baseline.$defs : current.$defs,
			tolerant: receives && tolerance === "additive",
			findings,
			visited: new Set(),
		};
		for (const name of roots[direction]) {
			if (!(name in current.$defs)) report(ctx, name, "removed");
			else subset(ctx, ref(name), ref(name), name);
		}
	}
	const unique = new Map(findings.map((finding) => [formatIncompatibility(finding), finding]));
	return [...unique.values()].sort((a, b) => a.path.localeCompare(b.path) || a.detail.localeCompare(b.detail));
}

/** @param {Incompatibility} finding */
export function formatIncompatibility(finding) {
	const flow = finding.direction === "receives" ? "host to app" : "app to host";
	return `${finding.path}: ${finding.detail} (${flow})`;
}

// ============================================================================
// Comparison
// ============================================================================
//
// subset(ctx, sub, sup) checks that every value `sub` allows, `sup` allows too.
// For what the build receives, sub is the current schema and sup the build's;
// for what it sends, sub is the build's schema and sup the current one.

function subset(ctx, sub, sup, path, openUnion = false) {
	// Match a reference against an inline union's members first, by name where it can.
	if (sub.$ref !== undefined && sup.$ref === undefined && sup.anyOf !== undefined) {
		subsetOfAny(ctx, sub, sup, path, openUnion);
		return;
	}
	if (sub.$ref !== undefined || sup.$ref !== undefined) {
		const subName = refName(sub);
		const supName = refName(sup);
		const key = `${subName ?? JSON.stringify(sub)}\u0000${supName ?? JSON.stringify(sup)}`;
		if (ctx.visited.has(key)) return;
		ctx.visited.add(key);
		const subSchema = subName === undefined ? sub : ctx.subDefs[subName];
		const supSchema = supName === undefined ? sup : ctx.supDefs[supName];
		if (subSchema === undefined || supSchema === undefined) {
			report(ctx, path, "unresolved", subSchema === undefined ? subName : supName);
			return;
		}
		// A definition compared with itself reports under its own name.
		const named = subName !== undefined && subName === supName;
		subset(ctx, subSchema, supSchema, named ? subName : path, named && ctx.tolerant && OPEN_UNIONS.has(subName));
		return;
	}
	if (isNever(sub) || !constrains(sup)) return;
	if (sub.anyOf !== undefined) {
		for (const member of sub.anyOf) subsetOfAny(ctx, member, sup, path, openUnion);
		return;
	}
	if (sup.anyOf !== undefined) {
		subsetOfAny(ctx, sub, sup, path, openUnion);
		return;
	}
	compareLocal(ctx, sub, sup, path);
}

/** `sub` (not a union) must fit one member of `sup`. */
function subsetOfAny(ctx, sub, sup, path, openUnion) {
	if (sup.anyOf === undefined) {
		subset(ctx, sub, sup, path);
		return;
	}
	const name = refName(sub);
	const sameName = name === undefined ? undefined : sup.anyOf.find((member) => refName(member) === name);
	if (sameName !== undefined) {
		subset(ctx, sub, sameName, path);
		return;
	}
	const candidates = sup.anyOf.filter((member) => compatible(ctx, sub, member));
	if (candidates.some((member) => passes(ctx, sub, member, path))) return;
	if (openUnion) return;
	if (candidates.length > 0) subset(ctx, sub, candidates[0], path);
	else report(ctx, path, "variant", describeVariant(ctx.subDefs, sub));
}

/** Whether `sub` fits `sup` without reporting anything. */
function passes(ctx, sub, sup, path) {
	const probe = { ...ctx, findings: [], visited: new Set(ctx.visited) };
	subset(probe, sub, sup, path);
	return probe.findings.length === 0;
}

/**
 * Whether two union members can describe the same values: their types
 * overlap and their discriminators agree. A member that is itself a union
 * matches when one of its members does.
 */
function compatible(ctx, sub, sup, depth = 0) {
	const a = resolve(ctx.subDefs, sub);
	const b = resolve(ctx.supDefs, sup);
	if (a === undefined || b === undefined || depth > 8) return false;
	if (a.anyOf !== undefined) return a.anyOf.some((member) => compatible(ctx, member, sup, depth + 1));
	if (b.anyOf !== undefined) return b.anyOf.some((member) => compatible(ctx, sub, member, depth + 1));
	const aTypes = typesOf(a);
	const bTypes = typesOf(b);
	if (aTypes !== undefined && bTypes !== undefined && !aTypes.some((type) => typeAllowed(type, bTypes))) return false;
	const aConsts = constProperties(a);
	const bConsts = constProperties(b);
	return Object.keys(aConsts).every((key) => !(key in bConsts) || deepEqual(aConsts[key], bConsts[key]));
}

/** Everything but unions and references: types, values, bounds, items, and fields. */
function compareLocal(ctx, sub, sup, path) {
	const subValues = valuesOf(sub);
	const supTypes = typesOf(sup);
	const subTypes = typesOf(sub);
	if (supTypes !== undefined) {
		if (subTypes === undefined) {
			report(ctx, path, "unconstrained");
			return;
		}
		const extra = subTypes.filter((type) => !typeAllowed(type, supTypes));
		if (extra.length > 0) {
			report(ctx, path, "type", extra.join(", "));
			return;
		}
	}
	const supValues = valuesOf(sup);
	if (supValues !== undefined) {
		if (subValues === undefined) report(ctx, path, "open", supValues.length);
		else for (const value of subValues) if (!supValues.some((v) => deepEqual(v, value))) report(ctx, path, "value", value);
	}
	for (const key of Object.keys(sup)) {
		if (!ANNOTATIONS.has(key) && !COMPARED.has(key) && !deepEqual(sub[key], sup[key])) report(ctx, path, "keyword", key);
	}
	if (sup.not !== undefined && !deepEqual(sub.not, sup.not)) report(ctx, path, "keyword", "not");
	if (subValues !== undefined) compareValues(ctx, subValues, sup, path);
	else compareBounds(ctx, sub, sup, path);
	if (sup.items !== undefined) {
		if (sub.items !== undefined) subset(ctx, sub.items, sup.items, `${path}[]`);
		else if (subValues === undefined) report(ctx, path, "unconstrained");
	}
	if (sup.uniqueItems === true && sub.uniqueItems !== true && subValues === undefined) report(ctx, path, "unique");
	if (sup.properties !== undefined || sup.patternProperties !== undefined || sup.additionalProperties !== undefined) {
		compareObject(ctx, sub, sup, path);
	}
}

function compareObject(ctx, sub, sup, path) {
	const subRequired = new Set(sub.required ?? []);
	for (const name of sup.required ?? []) if (!subRequired.has(name)) report(ctx, path, "required", name);
	const supClosed = sup.additionalProperties === false && !ctx.tolerant;
	for (const [name, schema] of Object.entries(sub.properties ?? {})) {
		const target = sup.properties?.[name] ?? undeclaredProperty(sup, name);
		if (target !== undefined) subset(ctx, schema, target, `${path}.${name}`);
		else if (supClosed) report(ctx, path, "property", name);
	}
	// Fields beyond the declared ones: records (patternProperties) or an open object.
	for (const [pattern, schema] of Object.entries(sub.patternProperties ?? {})) {
		const target = sup.patternProperties?.[pattern] ?? objectSchema(sup.additionalProperties);
		if (target !== undefined) subset(ctx, schema, target, `${path}[${pattern}]`);
		else if (supClosed) report(ctx, path, "keys", pattern);
	}
	if (sub.patternProperties === undefined && sub.additionalProperties !== false) {
		const extra = objectSchema(sub.additionalProperties) ?? {};
		const target = objectSchema(sup.additionalProperties);
		if (target !== undefined) subset(ctx, extra, target, `${path}[*]`);
		else if (supClosed) report(ctx, path, "keys", "*");
	}
}

/** The schema `sup` gives an undeclared field `name`, if it accepts one. */
function undeclaredProperty(sup, name) {
	for (const [pattern, schema] of Object.entries(sup.patternProperties ?? {})) {
		if (new RegExp(pattern, "u").test(name)) return schema;
	}
	return objectSchema(sup.additionalProperties);
}

/** Checks the values of a `const` or `enum` schema against the bounds of `sup`. */
function compareValues(ctx, values, sup, path) {
	for (const value of values) {
		if (typeof value === "string") {
			const scalars = [...value].length;
			const failed =
				(sup.minLength !== undefined && scalars < sup.minLength) ||
				(sup.maxLength !== undefined && scalars > sup.maxLength) ||
				(sup["x-volt-max-utf8-bytes"] !== undefined && Buffer.byteLength(value) > sup["x-volt-max-utf8-bytes"]) ||
				(sup.pattern !== undefined && !new RegExp(sup.pattern, "u").test(value));
			if (failed) report(ctx, path, "value", value);
		} else if (typeof value === "number") {
			const failed =
				(sup.minimum !== undefined && value < sup.minimum) ||
				(sup.exclusiveMinimum !== undefined && value <= sup.exclusiveMinimum) ||
				(sup.maximum !== undefined && value > sup.maximum) ||
				(sup.exclusiveMaximum !== undefined && value >= sup.exclusiveMaximum);
			if (failed) report(ctx, path, "value", value);
		}
	}
}

function compareBounds(ctx, sub, sup, path) {
	for (const key of LOWER_BOUNDS) {
		if (sup[key] !== undefined && (sub[key] ?? 0) < sup[key]) report(ctx, path, "lower", { key, sub: sub[key], sup: sup[key] });
	}
	for (const key of UPPER_BOUNDS) {
		const bound = key === "maxItems" ? maxItems(ctx, sub) : sub[key];
		if (sup[key] !== undefined && (bound ?? Number.POSITIVE_INFINITY) > sup[key]) {
			report(ctx, path, "upper", { key, sub: bound, sup: sup[key] });
		}
	}
	if (sup.pattern !== undefined && sub.pattern !== sup.pattern) report(ctx, path, "pattern");
	const low = numberBound(sub, "minimum", "exclusiveMinimum", -1);
	const supLow = numberBound(sup, "minimum", "exclusiveMinimum", -1);
	if (low.value < supLow.value) report(ctx, path, "lower", { key: "minimum", sub: finite(low.value), sup: supLow.value });
	else if (low.value === supLow.value && supLow.exclusive && !low.exclusive) {
		report(ctx, path, "inclusive", { key: "minimum", value: low.value });
	}
	const high = numberBound(sub, "maximum", "exclusiveMaximum", 1);
	const supHigh = numberBound(sup, "maximum", "exclusiveMaximum", 1);
	if (high.value > supHigh.value) report(ctx, path, "upper", { key: "maximum", sub: finite(high.value), sup: supHigh.value });
	else if (high.value === supHigh.value && supHigh.exclusive && !high.exclusive) {
		report(ctx, path, "inclusive", { key: "maximum", value: high.value });
	}
}

/**
 * The tighter of a schema's inclusive and exclusive bound on one side; `side`
 * is -1 for the lower bound and 1 for the upper.
 */
function numberBound(schema, inclusiveKey, exclusiveKey, side) {
	const none = side < 0 ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
	const inclusive = schema[inclusiveKey] ?? none;
	const exclusive = schema[exclusiveKey] ?? none;
	const tighter = side < 0 ? exclusive >= inclusive : exclusive <= inclusive;
	return schema[exclusiveKey] !== undefined && tighter
		? { value: exclusive, exclusive: true }
		: { value: inclusive, exclusive: false };
}

/** The most items an array schema allows: its `maxItems`, or fewer when its unique items have finite values. */
function maxItems(ctx, schema) {
	const items = schema.items === undefined ? undefined : resolve(ctx.subDefs, schema.items);
	const values = schema.uniqueItems === true && items !== undefined ? valuesOf(items) : undefined;
	const implied = values?.length ?? Number.POSITIVE_INFINITY;
	return Math.min(schema.maxItems ?? Number.POSITIVE_INFINITY, implied);
}

// ============================================================================
// Reports
// ============================================================================

/** What a change means, in the words of each direction: current against the build's contract. */
const DETAILS = {
	receives: {
		removed: () => "removed",
		unresolved: (name) => `unresolved reference ${name}`,
		variant: (variant) => `new variant ${variant}`,
		unconstrained: () => "no longer constrained",
		type: (types) => `new type ${types}`,
		open: (count) => `no longer limited to its ${count} values`,
		value: (value) => `new value ${JSON.stringify(value)}`,
		keyword: (key) => `\`${key}\` changed`,
		unique: () => "items may repeat",
		required: (name) => `\`${name}\` may be missing`,
		property: (name) => `new field \`${name}\``,
		keys: (pattern) => `new fields matching ${pattern}`,
		pattern: () => "pattern changed",
		lower: ({ key, sub, sup }) => `${key} lowered from ${sup} to ${sub ?? "none"}`,
		upper: ({ key, sub, sup }) => `${key} raised from ${sup} to ${sub ?? "none"}`,
		inclusive: ({ key, value }) => `${key} ${value} now included`,
	},
	sends: {
		removed: () => "removed",
		unresolved: (name) => `unresolved reference ${name}`,
		variant: (variant) => `variant ${variant} no longer accepted`,
		unconstrained: () => "now constrained",
		type: (types) => `type ${types} no longer accepted`,
		open: (count) => `now limited to ${count} values`,
		value: (value) => `value ${JSON.stringify(value)} no longer accepted`,
		keyword: (key) => `\`${key}\` changed`,
		unique: () => "items must now be unique",
		required: (name) => `\`${name}\` now required`,
		property: (name) => `field \`${name}\` no longer accepted`,
		keys: (pattern) => `fields matching ${pattern} no longer accepted`,
		pattern: () => "pattern changed",
		lower: ({ key, sub, sup }) => `${key} raised from ${sub ?? "none"} to ${sup}`,
		upper: ({ key, sub, sup }) => `${key} lowered from ${sub ?? "none"} to ${sup}`,
		inclusive: ({ key, value }) => `${key} ${value} now excluded`,
	},
};

function report(ctx, path, kind, data) {
	ctx.findings.push({ direction: ctx.direction, path, detail: DETAILS[ctx.direction][kind](data) });
}

function describeVariant(defs, schema) {
	const name = refName(schema);
	if (name !== undefined) return name;
	const consts = Object.entries(constProperties(resolve(defs, schema) ?? {}));
	if (consts.length > 0) return consts.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(", ");
	return JSON.stringify(schema).slice(0, 80);
}

// ============================================================================
// Schema helpers
// ============================================================================

function ref(name) {
	return { $ref: `#/$defs/${name}` };
}

function refName(schema) {
	return typeof schema.$ref === "string" && schema.$ref.startsWith("#/$defs/")
		? schema.$ref.slice("#/$defs/".length)
		: undefined;
}

/** A schema with its references followed. */
function resolve(defs, schema) {
	let current = schema;
	const seen = new Set();
	while (current?.$ref !== undefined) {
		const name = refName(current);
		if (name === undefined || seen.has(name)) return undefined;
		seen.add(name);
		current = defs[name];
	}
	return current;
}

/** `{ not: {} }` allows nothing. */
function isNever(schema) {
	return typeof schema.not === "object" && schema.not !== null && Object.keys(schema.not).length === 0;
}

/** Whether a schema constrains its value at all. */
function constrains(schema) {
	return Object.keys(schema).some((key) => !ANNOTATIONS.has(key));
}

function objectSchema(value) {
	return typeof value === "object" && value !== null ? value : undefined;
}

function valuesOf(schema) {
	if ("const" in schema) return [schema.const];
	return Array.isArray(schema.enum) ? schema.enum : undefined;
}

function typesOf(schema) {
	if (schema.type !== undefined) return [schema.type].flat();
	const values = valuesOf(schema);
	if (values !== undefined) return [...new Set(values.map(jsonType))];
	if (schema.properties !== undefined || schema.patternProperties !== undefined) return ["object"];
	return undefined;
}

function jsonType(value) {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
	return typeof value;
}

function typeAllowed(type, allowed) {
	return allowed.includes(type) || (type === "integer" && allowed.includes("number"));
}

function constProperties(schema) {
	const consts = {};
	for (const [key, value] of Object.entries(schema.properties ?? {})) {
		if (typeof value === "object" && value !== null && "const" in value) consts[key] = value.const;
	}
	return consts;
}

function finite(value) {
	return Number.isFinite(value) ? value : undefined;
}

function deepEqual(a, b) {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const aKeys = Object.keys(a);
	const bKeys = Object.keys(b);
	return aKeys.length === bKeys.length && aKeys.every((key) => deepEqual(a[key], b[key]));
}
