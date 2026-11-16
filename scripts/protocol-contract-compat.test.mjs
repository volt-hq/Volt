import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { appRoots, contractIncompatibilities, formatIncompatibility } from "./protocol-contract-compat.mjs";

const ref = (name) => ({ $ref: `#/$defs/${name}` });
const tag = (value) => ({ type: "string", const: value });
const closed = (properties, required = Object.keys(properties)) => ({
	type: "object",
	properties,
	required,
	additionalProperties: false,
});

/** A small contract shaped like the real one: host and client frame unions, a query result, and a recursive UiNode. */
function contract() {
	return {
		$defs: {
			HostFrame: { anyOf: [ref("Frame.result"), ref("Frame.fatal"), ref("Frame.ended")] },
			"Frame.result": closed({ type: tag("result"), queryId: { type: "string", minLength: 1 } }),
			"Frame.fatal": closed({ type: tag("fatal"), code: ref("FatalCode") }),
			"Frame.ended": {
				anyOf: [
					closed({ type: tag("ended"), reason: tag("moved"), target: { type: "string" } }),
					closed({ type: tag("ended"), reason: { type: "string", enum: ["closed", "lost"] } }),
				],
			},
			FatalCode: { type: "string", enum: ["revoked", "host_shutdown"] },
			"QueryResult.panel": closed({
				mode: { type: "string", enum: ["a", "b"] },
				node: ref("UiNode"),
				at: { type: "string", format: "date-time" },
				progress: { type: "number", exclusiveMinimum: 0, maximum: 1 },
			}),
			UiNode: {
				anyOf: [
					closed({ type: tag("text"), text: { type: "string", maxLength: 100 } }),
					closed({ type: tag("tree"), children: { type: "array", items: ref("UiNode") } }),
				],
			},
			ClientFrame: { anyOf: [ref("Frame.hello"), ref("Frame.intent.rename")] },
			"Frame.hello": closed({
				type: tag("hello"),
				hostRequests: { type: "array", items: ref("HostRequestKind"), uniqueItems: true },
			}),
			HostRequestKind: { type: "string", enum: ["confirm", "select"] },
			"Frame.intent.rename": closed({ type: tag("rename"), input: ref("IntentInput.rename") }),
			"IntentInput.rename": closed({ name: { type: "string", maxLength: 64 } }, ["name"]),
			"Control.ClientKind": { type: "string", enum: ["tui"] },
		},
	};
}

function dropRequired(schema, name) {
	schema.required = schema.required.filter((required) => required !== name);
}

/** The incompatibilities of `change` applied to a copy of the contract, formatted. */
function after(change, tolerance = "strict") {
	const baseline = contract();
	const current = structuredClone(baseline);
	change(current.$defs);
	return contractIncompatibilities({ baseline, current, tolerance }).map(formatIncompatibility);
}

test("an unchanged contract has no incompatibilities, recursive definitions included", () => {
	assert.deepEqual(after(() => {}), []);
	assert.deepEqual(after(() => {}, "additive"), []);
});

test("the app receives host frames, query results, intent outputs, the handshake response, and push notifications", () => {
	const defs = {
		HostFrame: {},
		ClientFrame: {},
		"QueryResult.models": {},
		"IntentOutput.fork": {},
		"RemoteHandshake.Hello": {},
		"RemoteHandshake.Response": {},
		IrohRemotePushNotification: {},
		"Control.Hello": {},
	};
	assert.deepEqual(appRoots(defs), {
		receives: [
			"HostFrame",
			"RemoteHandshake.Response",
			"IrohRemotePushNotification",
			"QueryResult.models",
			"IntentOutput.fork",
		],
		sends: ["ClientFrame", "RemoteHandshake.Hello"],
	});
});

test("what a strict build receives may only narrow", () => {
	assert.deepEqual(
		after((defs) => {
			defs["Frame.result"].properties.cached = { type: "boolean" };
		}),
		["Frame.result: new field `cached` (host to app)"],
	);
	assert.deepEqual(
		after((defs) => {
			defs.FatalCode.enum.push("overflow");
		}),
		['FatalCode: new value "overflow" (host to app)'],
	);
	assert.deepEqual(
		after((defs) => {
			defs.FatalCode = { type: "string", "x-volt-known-values": defs.FatalCode.enum };
		}),
		["FatalCode: no longer limited to its 2 values (host to app)"],
	);
	assert.deepEqual(
		after((defs) => {
			dropRequired(defs["QueryResult.panel"], "mode");
		}),
		["QueryResult.panel: `mode` may be missing (host to app)"],
	);
	assert.deepEqual(
		after((defs) => {
			defs["Frame.result"].properties.queryId = { type: "string" };
		}),
		["Frame.result.queryId: minLength lowered from 1 to none (host to app)"],
	);
	assert.deepEqual(
		after((defs) => {
			defs["QueryResult.panel"].properties.progress = { type: "number", minimum: 0, maximum: 2 };
		}),
		[
			"QueryResult.panel.progress: maximum raised from 1 to 2 (host to app)",
			"QueryResult.panel.progress: minimum 0 now included (host to app)",
		],
	);
	assert.deepEqual(
		after((defs) => {
			defs.HostFrame.anyOf.push(ref("Frame.notice"));
			defs["Frame.notice"] = closed({ type: tag("notice") });
		}),
		["HostFrame: new variant Frame.notice (host to app)"],
	);
	// Deep inside a recursive union.
	assert.deepEqual(
		after((defs) => {
			defs.UiNode.anyOf[0].properties.text.maxLength = 200;
		}),
		["UiNode.text: maxLength raised from 100 to 200 (host to app)"],
	);
	// Narrowing is safe: fewer values, tighter bounds, a dropped optional field.
	assert.deepEqual(
		after((defs) => {
			defs.FatalCode.enum.pop();
			defs.UiNode.anyOf[0].properties.text.maxLength = 50;
			defs["Frame.ended"].anyOf[1].properties.reason.enum = ["closed"];
			defs["QueryResult.panel"].properties.progress = { type: "number", minimum: 0.5, exclusiveMaximum: 1 };
		}),
		[],
	);
});

test("an additive build ignores new fields and new variants of open unions, nothing else", () => {
	assert.deepEqual(
		after((defs) => {
			defs["Frame.result"].properties.cached = { type: "boolean" };
			defs.HostFrame.anyOf.push(ref("Frame.notice"));
			defs["Frame.notice"] = closed({ type: tag("notice") });
			defs.UiNode.anyOf.push(closed({ type: tag("chart") }));
		}, "additive"),
		[],
	);
	assert.deepEqual(
		after((defs) => {
			defs.FatalCode.enum.push("overflow");
			defs["Frame.ended"].anyOf.push(closed({ type: tag("ended"), reason: tag("expired") }));
			dropRequired(defs["QueryResult.panel"], "mode");
		}, "additive"),
		[
			'FatalCode: new value "overflow" (host to app)',
			// Reported against the closest existing variant.
			'Frame.ended.reason: new value "expired" (host to app)',
			"QueryResult.panel: `mode` may be missing (host to app)",
		],
	);
});

test("what the build sends may only widen", () => {
	assert.deepEqual(
		after((defs) => {
			defs["IntentInput.rename"].properties.color = { type: "string" };
			defs["IntentInput.rename"].properties.name.maxLength = 128;
			defs.HostRequestKind.enum.push("form");
		}),
		[],
	);
	assert.deepEqual(
		after((defs) => {
			defs["IntentInput.rename"].properties.color = { type: "string" };
			defs["IntentInput.rename"].required.push("color");
		}),
		["IntentInput.rename: `color` now required (app to host)"],
	);
	assert.deepEqual(
		after((defs) => {
			defs["IntentInput.rename"].properties.name.maxLength = 32;
		}),
		["IntentInput.rename.name: maxLength lowered from 64 to 32 (app to host)"],
	);
	assert.deepEqual(
		after((defs) => {
			defs.HostRequestKind.enum = ["confirm"];
		}),
		['HostRequestKind: value "select" no longer accepted (app to host)'],
	);
	assert.deepEqual(
		after((defs) => {
			defs.ClientFrame.anyOf.pop();
		}),
		["ClientFrame: variant Frame.intent.rename no longer accepted (app to host)"],
	);
});

test("an opened enum the build sends from stays compatible when its values fit the new bounds (#1091)", () => {
	assert.deepEqual(
		after((defs) => {
			defs["Frame.hello"].properties.hostRequests = {
				type: "array",
				items: { type: "string", minLength: 1, maxLength: 64, "x-volt-known-values": ["confirm", "select"] },
				uniqueItems: true,
				maxItems: 64,
			};
		}),
		[],
	);
	// A bound that excludes a value the build sends is not.
	assert.deepEqual(
		after((defs) => {
			defs["Frame.hello"].properties.hostRequests = {
				type: "array",
				items: { type: "string", maxLength: 6 },
				uniqueItems: true,
			};
		}),
		['Frame.hello.hostRequests[]: value "confirm" no longer accepted (app to host)'],
	);
});

test("a field only some clients receive is still reported: the contract cannot see runtime projection (#1073)", () => {
	assert.deepEqual(
		after((defs) => {
			defs["QueryResult.panel"].properties.reviewVerifierModel = { anyOf: [{ type: "string" }, { type: "null" }] };
		}),
		["QueryResult.panel: new field `reviewVerifierModel` (host to app)"],
	);
});

test("definitions the build neither receives nor sends are ignored", () => {
	assert.deepEqual(
		after((defs) => {
			defs["Control.ClientKind"].enum = ["daemon"];
			defs.Unused = { type: "string" };
		}),
		[],
	);
});

test("removed roots, unresolved references, and changed unrecognized keywords are reported", () => {
	assert.deepEqual(
		after((defs) => {
			delete defs["QueryResult.panel"];
		}),
		["QueryResult.panel: removed (host to app)"],
	);
	assert.deepEqual(
		after((defs) => {
			delete defs.FatalCode;
		}),
		["Frame.fatal.code: unresolved reference FatalCode (host to app)"],
	);
	assert.deepEqual(
		after((defs) => {
			delete defs["QueryResult.panel"].properties.at.format;
		}),
		["QueryResult.panel.at: `format` changed (host to app)"],
	);
});

test("the committed contract compared with itself has no incompatibilities", () => {
	const committed = JSON.parse(
		readFileSync(new URL("../packages/protocol/contract/protocol-schema.json", import.meta.url), "utf8"),
	);
	for (const tolerance of ["strict", "additive"]) {
		assert.deepEqual(contractIncompatibilities({ baseline: committed, current: committed, tolerance }), []);
	}
});

test("rejects an unknown tolerance", () => {
	assert.throws(
		() => contractIncompatibilities({ baseline: contract(), current: contract(), tolerance: "lenient" }),
		/Unknown tolerance/,
	);
});
