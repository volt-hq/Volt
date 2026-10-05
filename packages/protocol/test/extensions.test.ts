import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
	ExtensionManifestSchema,
	ExtensionSettingsSchema,
	ExtensionSettingsValuesSchema,
	ExtensionSummarySchema,
	RESERVED_EXTENSION_IDS,
} from "../src/extensions.ts";
import { ClientFrameSchema, HostFrameSchema } from "../src/frames.ts";
import { HOST_REQUEST_KINDS, HostRequestSchema, LiveItemSchema, LiveKeySchema, LiveValueSchema } from "../src/live.ts";
import { MessagePresentationSchema, ToolPresentationSchema } from "../src/presentation.ts";
import { EDITOR_COMPLETIONS_MAX_ITEMS, QUERY_SCHEMAS } from "../src/queries.ts";

const settings = {
	type: "object",
	properties: {
		organization: { type: "string", title: "Organization", minLength: 1, maxLength: 64, pattern: "^[\\w-]+$" },
		authMode: { type: "string", enum: ["device", "pat"], default: "device", description: "How to sign in" },
		verbose: { type: "boolean", default: false },
		maxLoops: { type: "integer", minimum: 1, maximum: 10, default: 3 },
	},
	required: ["organization"],
	additionalProperties: false,
};

const manifest = {
	id: "azure-devops",
	displayName: "Azure DevOps",
	description: "Work items and pull requests.",
	entry: "dist/index.js",
	settings,
	permissions: ["network", "secrets"],
};

describe("extension manifest", () => {
	it("declares id, display name, description, entry, settings, and permissions", () => {
		expect(Check(ExtensionManifestSchema, manifest)).toBe(true);
		expect(Check(ExtensionManifestSchema, { id: "tps", displayName: "Tokens per second" })).toBe(true);
		expect(Check(ExtensionManifestSchema, { ...manifest, version: "1.0.0" })).toBe(false);
		expect(Check(ExtensionManifestSchema, { ...manifest, extensions: ["./index.ts"] })).toBe(false);
	});

	it("takes lowercase ids that are not reserved", () => {
		for (const id of ["a", "review-loop", "rtk", "x".repeat(64), "0day"]) {
			expect(Check(ExtensionManifestSchema, { ...manifest, id }), id).toBe(true);
		}
		for (const id of [...RESERVED_EXTENSION_IDS, "", "-a", "Review", "a_b", "a.b", "x".repeat(65), "ext:a/b"]) {
			expect(Check(ExtensionManifestSchema, { ...manifest, id }), id).toBe(false);
		}
	});

	it("bounds text and keeps the entry inside the package", () => {
		expect(Check(ExtensionManifestSchema, { ...manifest, displayName: "" })).toBe(false);
		expect(Check(ExtensionManifestSchema, { ...manifest, displayName: "x".repeat(81) })).toBe(false);
		expect(Check(ExtensionManifestSchema, { ...manifest, displayName: "two\nlines" })).toBe(false);
		expect(Check(ExtensionManifestSchema, { ...manifest, description: "\u001b[1mbold" })).toBe(false);
		expect(Check(ExtensionManifestSchema, { ...manifest, description: "x".repeat(241) })).toBe(false);
		for (const entry of ["index.ts", "./src/index.ts", "dist/..index.js"]) {
			expect(Check(ExtensionManifestSchema, { ...manifest, entry }), entry).toBe(true);
		}
		for (const entry of [
			"",
			"/abs/index.js",
			"../outside.js",
			"src/../../x.js",
			"src/..",
			"C:/x.js",
			"src\\index.js",
		]) {
			expect(Check(ExtensionManifestSchema, { ...manifest, entry }), entry).toBe(false);
		}
	});

	it("asks for known permissions, each once", () => {
		expect(Check(ExtensionManifestSchema, { ...manifest, permissions: [] })).toBe(true);
		expect(Check(ExtensionManifestSchema, { ...manifest, permissions: ["exec", "fs-write", "providers"] })).toBe(
			true,
		);
		expect(Check(ExtensionManifestSchema, { ...manifest, permissions: ["exec", "exec"] })).toBe(false);
		expect(Check(ExtensionManifestSchema, { ...manifest, permissions: ["root"] })).toBe(false);
	});
});

describe("extension settings", () => {
	it("are a flat object of string, enum, boolean, and integer settings", () => {
		expect(Check(ExtensionSettingsSchema, settings)).toBe(true);
		expect(Check(ExtensionSettingsSchema, { type: "object", properties: {} })).toBe(true);
	});

	it("reject nesting, arrays, numbers, unions, and unsafe names", () => {
		const property = (schema: unknown) =>
			Check(ExtensionSettingsSchema, { type: "object", properties: { value: schema } });
		expect(property({ type: "object", properties: {} })).toBe(false);
		expect(property({ type: "array", items: { type: "string" } })).toBe(false);
		expect(property({ type: "number" })).toBe(false);
		expect(property({ anyOf: [{ type: "string" }, { type: "integer" }] })).toBe(false);
		expect(property({ type: "string", enum: [] })).toBe(false);
		expect(property({ type: "string", enum: ["a", "a"] })).toBe(false);
		expect(property({ type: "string", enum: ["a"], pattern: "a" })).toBe(false);
		expect(property({ type: "integer", default: 1.5 })).toBe(false);
		expect(property({ type: "string", format: "uri" })).toBe(false);
		for (const name of ["__proto__", "constructor", "prototype", "1st", "with-dash", ""]) {
			expect(
				Check(ExtensionSettingsSchema, { type: "object", properties: { [name]: { type: "boolean" } } }),
				name,
			).toBe(false);
		}
		expect(Check(ExtensionSettingsSchema, { ...settings, additionalProperties: true })).toBe(false);
	});

	it("store string, boolean, and integer values by setting name", () => {
		expect(Check(ExtensionSettingsValuesSchema, { organization: "acme", verbose: true, maxLoops: 3 })).toBe(true);
		expect(Check(ExtensionSettingsValuesSchema, { ratio: 0.5 })).toBe(false);
		expect(Check(ExtensionSettingsValuesSchema, { list: ["a"] })).toBe(false);
		expect(Check(ExtensionSettingsValuesSchema, JSON.parse('{"__proto__": "x"}'))).toBe(false);
		expect(Check(ExtensionSettingsValuesSchema, { constructor: "x" })).toBe(false);
	});
});

describe("extension catalog and management", () => {
	const summary = {
		id: "review-loop",
		displayName: "Review loop",
		version: "1.2.0",
		scope: "user",
		enabled: true,
		state: "active",
		permissions: ["exec", "fs-write"],
		permissionsAcknowledged: true,
		hasSettings: true,
	};
	const query = (name: string, params?: unknown) =>
		Check(ClientFrameSchema, {
			type: "query",
			queryId: "q1",
			query: name,
			...(params === undefined ? {} : { params }),
		});
	const intent = (type: string, input: unknown) => Check(ClientFrameSchema, { type, intentId: "i1", input });

	it("lists extensions with their state, permissions, and settings", () => {
		expect(Check(ExtensionSummarySchema, summary)).toBe(true);
		expect(Check(ExtensionSummarySchema, { ...summary, state: "failed", error: "Cannot find module" })).toBe(true);
		expect(Check(ExtensionSummarySchema, { ...summary, version: "local", scope: "temporary" })).toBe(true);
		expect(Check(ExtensionSummarySchema, { ...summary, state: "loading" })).toBe(false);
		expect(Check(ExtensionSummarySchema, { ...summary, path: "/home/u/.volt/extensions/x" })).toBe(false);
		expect(Check(QUERY_SCHEMAS.extensions.result, { extensions: [summary] })).toBe(true);
		expect(query("extensions")).toBe(true);
	});

	it("reads one extension's settings form and stored values", () => {
		expect(query("extension_settings", { id: "review-loop" })).toBe(true);
		expect(query("extension_settings")).toBe(false);
		expect(query("extension_settings", { id: "volt" })).toBe(false);
		const view = {
			form: [
				{ kind: "integer", id: "maxLoops", label: "Max loops", min: 1, max: 10, value: 3 },
				{ kind: "string", id: "baseBranch", label: "Base branch" },
			],
			values: { global: { maxLoops: 5 }, project: { baseBranch: "main" } },
			projectTrusted: true,
		};
		expect(Check(QUERY_SCHEMAS.extension_settings.result, view)).toBe(true);
		expect(Check(QUERY_SCHEMAS.extension_settings.result, { ...view, values: { project: {} } })).toBe(false);
	});

	it("enables, disables, and configures extensions by id and settings scope", () => {
		expect(intent("set_extension_enabled", { id: "rtk", enabled: false, scope: "global" })).toBe(true);
		expect(intent("set_extension_enabled", { id: "rtk", enabled: true, scope: "project" })).toBe(true);
		expect(intent("set_extension_enabled", { id: "rtk", enabled: true })).toBe(false);
		expect(intent("set_extension_enabled", { id: "rtk", enabled: true, scope: "user" })).toBe(false);
		expect(intent("set_extension_enabled", { id: "builtin", enabled: false, scope: "global" })).toBe(false);
		expect(intent("set_extension_settings", { id: "rtk", scope: "global", values: { rewriteTimeoutMs: 500 } })).toBe(
			true,
		);
		expect(intent("set_extension_settings", { id: "rtk", scope: "global", values: { nested: { a: 1 } } })).toBe(
			false,
		);
	});

	it("completes editor text from completion providers", () => {
		expect(query("editor_completions", { text: "fix #12", cursor: 7 })).toBe(true);
		expect(query("editor_completions", { text: "fix #12" })).toBe(false);
		expect(query("editor_completions", { text: "x", cursor: -1 })).toBe(false);
		const items = Array.from({ length: EDITOR_COMPLETIONS_MAX_ITEMS + 1 }, (_, index) => ({ value: `#${index}` }));
		const result = QUERY_SCHEMAS.editor_completions.result;
		expect(
			Check(result, { prefix: "#12", items: [{ value: "#123", label: "#123", description: "Fix crash" }] }),
		).toBe(true);
		expect(Check(result, { prefix: "#", items: items.slice(1) })).toBe(true);
		expect(Check(result, { prefix: "#", items })).toBe(false);
	});
});

describe("extension UI on the live lane", () => {
	const live = (items: unknown[]) =>
		Check(HostFrameSchema, { type: "live", subscriptionId: "s1", basedOn: 3, seq: 2, items });
	const panel = {
		kind: "ext_panel",
		extension: "prompt-url-widget",
		title: "Pull request",
		placement: "sidebar",
		node: { type: "card", key: "pr", title: "#42 Fix crash", sections: [{ key: "body", children: [] }] },
	};

	it("keeps panels and statuses keyed by extension", () => {
		expect(Check(LiveValueSchema, panel)).toBe(true);
		expect(Check(LiveValueSchema, { ...panel, placement: "footer" })).toBe(false);
		expect(Check(LiveValueSchema, { ...panel, extension: undefined })).toBe(false);
		expect(Check(LiveValueSchema, { ...panel, node: { type: "text", text: "\u001b[31mred" } })).toBe(false);
		expect(Check(LiveKeySchema, "ext_panel/prompt-url-widget/pr")).toBe(true);
		expect(live([{ type: "set", key: "ext_panel/prompt-url-widget/pr", value: panel }])).toBe(true);
		expect(Check(LiveValueSchema, { kind: "ext_status", extension: "tps", text: "42 tok/s" })).toBe(true);
		expect(
			Check(LiveValueSchema, { kind: "ext_status", extension: "tps", text: [{ text: "42", token: "accent" }] }),
		).toBe(true);
		expect(Check(LiveValueSchema, { kind: "ext_status", text: "42 tok/s" })).toBe(false);
		expect(Check(LiveValueSchema, { kind: "ext_status", extension: "Bad Id", text: "x" })).toBe(false);
		expect(Check(LiveValueSchema, { kind: "ext_status", extension: "tps", text: "\u001b[31mred" })).toBe(false);
		expect(Check(LiveValueSchema, { kind: "ext_title", extension: "tps", title: "volt" })).toBe(true);
		expect(Check(LiveValueSchema, { kind: "ext_title", title: "volt" })).toBe(false);
		expect(Check(LiveValueSchema, { kind: "ext_title", extension: "tps", title: "a\nb" })).toBe(false);
		expect(Check(LiveValueSchema, { kind: "ext_widget", lines: [], placement: "aboveEditor" })).toBe(false);
	});

	it("patches the node of a panel or work item", () => {
		const append = { op: "append_lines", path: ["pr", "body", "log"], lines: ["checks passed"] };
		expect(live([{ type: "patch", key: "ext_panel/prompt-url-widget/pr", ops: [append] }])).toBe(true);
		expect(live([{ type: "patch", key: "work/w1", ops: [{ op: "remove", path: [] }] }])).toBe(true);
		expect(live([{ type: "patch", key: "ext_status/tps/rate", ops: [{ op: "remove", path: [] }] }])).toBe(false);
		expect(live([{ type: "patch", key: "ext_panel/pr", ops: [{ op: "remove", path: [] }] }])).toBe(false);
		expect(live([{ type: "patch", key: "phase", ops: [{ op: "remove", path: [] }] }])).toBe(false);
		expect(live([{ type: "patch", key: "work/w1", ops: [] }])).toBe(false);
	});

	it("carries tool presentations and their patches", () => {
		const presentation = {
			title: [{ text: "$ ", token: "muted" }, { text: "npm test" }],
			activity: "running",
			summary: [{ type: "terminal", key: "tail", lines: ["PASS a.test.ts"] }],
			body: [{ type: "terminal", key: "output", lines: ["$ npm test", "PASS a.test.ts"], omittedLines: 10 }],
			actions: [{ id: "open", label: "Open", intent: { type: "open_work", input: { workId: "w1" } } }],
			showsDuration: true,
		};
		const tool = { type: "tool", op: "update", toolCallId: "t1", toolName: "bash" };
		expect(Check(ToolPresentationSchema, presentation)).toBe(true);
		expect(Check(ToolPresentationSchema, { title: "read a.ts", hidden: true })).toBe(true);
		expect(Check(ToolPresentationSchema, { body: [] })).toBe(false);
		expect(Check(ToolPresentationSchema, { title: "x", renderCall: "fn" })).toBe(false);
		expect(Check(LiveItemSchema, { ...tool, op: "start", presentation })).toBe(true);
		expect(
			Check(LiveItemSchema, {
				...tool,
				patch: {
					summary: [{ op: "replace", path: ["tail"], node: { type: "terminal", key: "tail", lines: ["FAIL"] } }],
					body: [{ op: "append_lines", path: ["output"], lines: ["FAIL b.test.ts"] }],
				},
			}),
		).toBe(true);
		expect(Check(LiveItemSchema, { ...tool, patch: {} })).toBe(false);
		expect(Check(LiveItemSchema, { ...tool, patch: { title: "x" } })).toBe(false);
	});

	it("presents custom messages", () => {
		expect(Check(MessagePresentationSchema, { body: [{ type: "markdown", markdown: "**Plan** ready" }] })).toBe(true);
		expect(
			Check(MessagePresentationSchema, {
				title: "Handoff",
				summary: [{ type: "text", text: "3 files" }],
				body: [{ type: "list", items: [] }],
			}),
		).toBe(true);
		expect(Check(MessagePresentationSchema, { title: "Handoff" })).toBe(false);
	});
});

describe("host requests", () => {
	const request = (value: unknown) =>
		Check(LiveValueSchema, { kind: "host_request", requestId: "r1", request: value });

	it("ask dialogs with UI data and buttons", () => {
		const dialog = {
			kind: "dialog",
			title: "Publish review?",
			body: [{ type: "markdown", markdown: "3 findings will be posted." }],
			actions: [
				{ id: "publish", label: "Publish", token: "accent" },
				{ id: "discard", label: "Discard", destructive: true },
			],
			timeoutMs: 60_000,
		};
		expect(request(dialog)).toBe(true);
		expect(request({ ...dialog, actions: [] })).toBe(false);
		expect(request({ ...dialog, actions: [{ id: "x", label: "X", intent: { type: "abort" } }] })).toBe(false);
		expect(request({ ...dialog, title: "\u001b[1mbold" })).toBe(false);
	});

	it("ask a client for its editor text", () => {
		expect(request({ kind: "editor_text" })).toBe(true);
		expect(request({ kind: "editor_text", timeoutMs: 2_000 })).toBe(true);
		expect(request({ kind: "editor_text", title: "x" })).toBe(false);
		expect(Check(HostRequestSchema, { kind: "editor_text" })).toBe(true);
	});

	it("are kinds a client may accept", () => {
		expect(HOST_REQUEST_KINDS).toContain("dialog");
		expect(HOST_REQUEST_KINDS).toContain("editor_text");
		const hello = {
			type: "hello",
			protocol: 1,
			client: { name: "volt-app", version: "1.0.0" },
			accepts: { hostRequests: ["dialog", "editor_text"] },
		};
		expect(Check(ClientFrameSchema, hello)).toBe(true);
	});
});
