import type { HostRequest, HostRequestKind, LiveItem, LiveValue } from "@hansjm10/volt-protocol";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	FORM_PATTERN_VALUE_MAX_CHARS,
	isSafeFormPattern,
	type LiveClient,
	LiveState,
	type LiveUpdate,
} from "../src/core/host/live-state.ts";
import { createLiveRecorder } from "./utilities/live-recorder.ts";

const DIALOGS: HostRequestKind[] = ["select", "confirm", "input", "editor"];
const confirm: HostRequest = { kind: "confirm", title: "Proceed?", message: "Continue?" };

afterEach(() => {
	vi.useRealTimers();
});

describe("LiveState keyed values", () => {
	it("replays the current values on attach, delivers changes in order, and resets on detach", () => {
		const live = new LiveState();
		live.set("ext_status/build", { kind: "ext_status", text: "building" });
		live.set("ext_title", { kind: "ext_title", title: "volt" });
		const client = createLiveRecorder();
		const detach = live.attach("tui", client);
		expect(client.updates).toEqual([
			{
				reset: true,
				basedOn: 0,
				items: [
					{ type: "set", key: "ext_status/build", value: { kind: "ext_status", text: "building" } },
					{ type: "set", key: "ext_title", value: { kind: "ext_title", title: "volt" } },
				],
			},
		]);

		live.set("ext_status/build", { kind: "ext_status", text: "done" });
		live.clear("ext_title");
		live.clear("ext_title");
		live.notice("warning", "careful");
		live.setEditorText("draft");
		expect(client.updates.slice(1)).toEqual([
			{
				reset: false,
				basedOn: 0,
				items: [{ type: "set", key: "ext_status/build", value: { kind: "ext_status", text: "done" } }],
			},
			{ reset: false, basedOn: 0, items: [{ type: "clear", key: "ext_title" }] },
			{ reset: false, basedOn: 0, items: [{ type: "notice", level: "warning", message: "careful" }] },
			{ reset: false, basedOn: 0, items: [{ type: "directive", directive: "set_editor_text", text: "draft" }] },
		]);
		expect(live.entries()).toEqual([["ext_status/build", { kind: "ext_status", text: "done" }]]);

		detach();
		expect(client.updates.at(-1)).toEqual({ reset: true, basedOn: 0, items: [] });
		live.notice("info", "after");
		expect(client.updates).toHaveLength(6);
	});

	it("rejects malformed keys and values and keeps host requests to their own lifecycle", () => {
		const live = new LiveState();
		expect(() => live.set("ext_status/", { kind: "ext_status", text: "x" })).toThrow(TypeError);
		expect(() => live.set("ext_status/a\u0007b", { kind: "ext_status", text: "x" })).toThrow(TypeError);
		expect(() => live.set(`ext_status/${"k".repeat(257)}`, { kind: "ext_status", text: "x" })).toThrow(TypeError);
		expect(() => live.set("ext_widget/k", { kind: "ext_status", text: "x" })).toThrow(TypeError);
		expect(() => live.set("ext_status/k", { kind: "ext_status", text: 3 } as unknown as LiveValue)).toThrow(
			TypeError,
		);
		expect(() =>
			live.set("host_request/x", { kind: "host_request", requestId: "x", request: confirm } as LiveValue),
		).toThrow(TypeError);
		expect(() => live.clear("host_request/x")).toThrow(TypeError);
		expect(live.entries()).toEqual([]);
	});

	it("keeps a failing client from reaching the host or the other clients", async () => {
		const live = new LiveState();
		const failing: LiveClient = {
			acceptsHostRequest: () => true,
			apply: () => {
				throw new Error("render failed");
			},
		};
		const throwing: LiveClient = {
			acceptsHostRequest: () => {
				throw new Error("check failed");
			},
			apply: () => {},
		};
		const other = createLiveRecorder(["confirm"]);
		live.attach("failing", failing);
		live.attach("throwing", throwing);
		live.attach("other", other);
		expect(() => live.notice("info", "hello")).not.toThrow();
		expect(other.notices()).toEqual([["info", "hello"]]);

		// A client whose check throws accepts nothing; the request and its requester carry on.
		const asked = live.request(confirm, { id: "dialog" });
		expect(live.answer("dialog", { confirmed: true }, "throwing")).toBe("not_allowed");
		expect(live.answer("dialog", { confirmed: true }, "failing")).toBe("accepted");
		await expect(asked).resolves.toMatchObject({ status: "answered", clientId: "failing" });
		expect(other.pending()).toEqual([]);
	});
});

describe("LiveState host requests", () => {
	it("reaches only the clients that accept the kind, and the first valid answer wins", async () => {
		const live = new LiveState();
		const tui = createLiveRecorder([...DIALOGS, "approval"]);
		const phone = createLiveRecorder(DIALOGS);
		const observer = createLiveRecorder();
		live.attach("tui", tui);
		live.attach("phone", phone);
		live.attach("observer", observer);

		const asked = live.request(confirm, { id: "dialog-1" });
		expect(tui.pending()).toEqual([{ requestId: "dialog-1", request: confirm }]);
		expect(phone.pending()).toEqual([{ requestId: "dialog-1", request: confirm }]);
		expect(observer.items()).toEqual([]);

		expect(live.answer("dialog-1", { confirmed: true }, "observer")).toBe("not_allowed");
		expect(live.answer("dialog-1", { confirmed: true }, "stranger")).toBe("not_allowed");
		expect(live.answer("dialog-1", { value: "yes" }, "phone")).toBe("invalid");
		expect(live.answer("dialog-1", { confirmed: true }, "phone")).toBe("accepted");
		expect(live.answer("dialog-1", { confirmed: false }, "tui")).toBe("unknown");
		await expect(asked).resolves.toEqual({ status: "answered", response: { confirmed: true }, clientId: "phone" });
		expect(tui.pending()).toEqual([]);
		expect(phone.pending()).toEqual([]);
		expect(observer.items()).toEqual([]);
		expect(live.pendingRequests()).toEqual([]);
	});

	it("binds an approval to the clients that accept approvals", async () => {
		const live = new LiveState();
		const dialogsOnly = createLiveRecorder(DIALOGS);
		const manager = createLiveRecorder(["approval"]);
		live.attach("phone", dialogsOnly);
		live.attach("manager", manager);

		const decision = live.request(
			{
				kind: "approval",
				action: "lsp.install_server",
				title: "Install?",
				commandPreview: "npm install -g typescript",
				timeoutMs: 60_000,
			},
			{ id: "lsp-install-1" },
		);
		expect(dialogsOnly.items()).toEqual([]);
		expect(manager.pending()).toEqual([
			{
				requestId: "lsp-install-1",
				request: {
					kind: "approval",
					action: "lsp.install_server",
					title: "Install?",
					commandPreview: "npm install -g typescript",
					timeoutMs: 60_000,
				},
			},
		]);
		expect(live.answer("lsp-install-1", { decision: "approved" }, "phone")).toBe("not_allowed");
		expect(live.answer("lsp-install-1", { confirmed: true }, "manager")).toBe("invalid");
		expect(live.answer("lsp-install-1", { decision: "approved", message: "ok" }, "manager")).toBe("accepted");
		await expect(decision).resolves.toEqual({
			status: "answered",
			response: { decision: "approved", message: "ok" },
			clientId: "manager",
		});
		expect(dialogsOnly.items()).toEqual([]);
		expect(manager.items().at(-1)).toEqual({ type: "clear", key: "host_request/lsp-install-1" });
		expect(live.entries()).toEqual([]);
	});

	it("is unavailable without an accepting client and ends on abort, timeout, and close", async () => {
		vi.useFakeTimers();
		const live = new LiveState();
		await expect(live.request(confirm)).resolves.toEqual({ status: "cancelled", reason: "unavailable" });
		await expect(live.request({ kind: "approval", action: "x", title: "t" }, { id: "a" })).resolves.toEqual({
			status: "cancelled",
			reason: "unavailable",
		});

		const client = createLiveRecorder();
		live.attach("tui", { ...client, acceptsHostRequest: () => true });

		const controller = new AbortController();
		const aborted = live.request(confirm, { signal: controller.signal });
		controller.abort();
		await expect(aborted).resolves.toEqual({ status: "cancelled", reason: "aborted" });

		const timed = live.request({ kind: "select", title: "Pick", options: ["a"], timeoutMs: 1000 });
		await vi.advanceTimersByTimeAsync(1000);
		await expect(timed).resolves.toEqual({ status: "cancelled", reason: "timeout" });

		// An answer to a pending request must never answer another: its id cannot be reused while it is pending.
		const pending = live.request({ kind: "input", title: "Name" }, { id: "same" });
		await expect(live.request(confirm, { id: "same" })).rejects.toThrow(/already pending/);
		expect(live.pendingRequest("same")?.request).toEqual({ kind: "input", title: "Name" });

		const closing = live.request(confirm);
		live.close();
		await expect(closing).resolves.toEqual({ status: "cancelled", reason: "closed" });
		await expect(pending).resolves.toEqual({ status: "cancelled", reason: "closed" });
		expect(client.updates.at(-1)).toEqual({ reset: true, basedOn: 0, items: [] });
		await expect(live.request(confirm)).resolves.toEqual({ status: "cancelled", reason: "closed" });
		live.notice("info", "closed");
		expect(client.updates.at(-1)).toEqual({ reset: true, basedOn: 0, items: [] });
	});

	it("outlives the clients that saw it and reaches a client that attaches later", async () => {
		const live = new LiveState();
		const first = createLiveRecorder(DIALOGS);
		const detachFirst = live.attach("first", first);
		const asked = live.request(confirm, { id: "dialog" });
		detachFirst();
		expect(live.pendingRequests()).toHaveLength(1);

		const second = createLiveRecorder(DIALOGS);
		live.attach("second", second);
		expect(second.updates[0]).toEqual({
			reset: true,
			basedOn: 0,
			items: [
				{
					type: "set",
					key: "host_request/dialog",
					value: { kind: "host_request", requestId: "dialog", request: confirm },
				},
			],
		});
		expect(live.answer("dialog", { confirmed: true }, "first")).toBe("not_allowed");
		expect(live.answer("dialog", { cancelled: true }, "second")).toBe("accepted");
		await expect(asked).resolves.toMatchObject({ status: "answered", response: { cancelled: true } });
	});

	it("checks answers against the request: select options, form fields, and MCP authorization", async () => {
		const live = new LiveState();
		live.attach("client", createLiveRecorder(["select", "form", "mcp_auth"]));
		const select = live.request({ kind: "select", title: "Pick", options: ["keep", "delete"] }, { id: "s" });
		expect(live.answer("s", { value: "drop table" }, "client")).toBe("invalid");
		expect(live.answer("s", { value: "keep" }, "client")).toBe("accepted");
		await expect(select).resolves.toMatchObject({ response: { value: "keep" } });

		const form = live.request(
			{
				kind: "form",
				title: "Configure",
				fields: [
					{ kind: "string", id: "name", label: "Name", required: true, maxLength: 4, pattern: "[a-z]+" },
					{ kind: "boolean", id: "enabled", label: "Enabled" },
					{ kind: "enum", id: "mode", label: "Mode", options: [{ value: "fast" }, { value: "safe" }] },
					{ kind: "integer", id: "count", label: "Count", min: 1, max: 3 },
				],
			},
			{ id: "f" },
		);
		for (const values of [
			{},
			{ name: "abcde" },
			{ name: "AB" },
			{ name: "ab", enabled: "yes" },
			{ name: "ab", mode: "slow" },
			{ name: "ab", count: 4 },
			{ name: "ab", count: 1.5 },
			{ name: "ab", extra: true },
		]) {
			expect(live.answer("f", { values } as never, "client")).toBe("invalid");
		}
		expect(live.answer("f", { values: { name: "ab", enabled: true, mode: "safe", count: 2 } }, "client")).toBe(
			"accepted",
		);
		await expect(form).resolves.toMatchObject({ status: "answered" });

		const auth = live.request({ kind: "mcp_auth", server: "github", flow: "device", userCode: "ABCD" }, { id: "m" });
		expect(live.answer("m", { value: "ABCD" }, "client")).toBe("invalid");
		expect(live.answer("m", { cancelled: true }, "client")).toBe("accepted");
		await expect(auth).resolves.toMatchObject({ status: "answered", response: { cancelled: true } });
	});

	it("rejects malformed requests and request ids", async () => {
		const live = new LiveState();
		live.attach("client", createLiveRecorder(DIALOGS));
		await expect(live.request({ kind: "select", title: "Pick", options: [] })).rejects.toThrow(TypeError);
		await expect(live.request(confirm, { id: " padded" })).rejects.toThrow(TypeError);
		await expect(live.request(confirm, { id: "" })).rejects.toThrow(TypeError);
		await expect(live.request({ kind: "confirm", title: 1, message: "m" } as unknown as HostRequest)).rejects.toThrow(
			TypeError,
		);
	});

	it("delivers a change a client makes while a batch is delivered after that batch, to every client", async () => {
		const live = new LiveState();
		const order: string[] = [];
		const record = (name: string, update: LiveUpdate): void => {
			for (const item of update.items) order.push(`${name}:${item.type}`);
		};
		// The first client answers as soon as it is asked.
		live.attach("eager", {
			acceptsHostRequest: () => true,
			apply: (update) => {
				record("eager", update);
				for (const item of update.items) {
					if (item.type === "set" && item.value.kind === "host_request") {
						live.answer(item.value.requestId, { confirmed: true }, "eager");
					}
				}
			},
		});
		live.attach("late", { acceptsHostRequest: () => true, apply: (update) => record("late", update) });
		await live.request(confirm);
		expect(order).toEqual(["eager:set", "late:set", "eager:clear", "late:clear"]);
	});
});

/** One step of a random schedule over a live state with three clients. */
type Step =
	| { op: "ask"; kind: "confirm" | "approval" }
	| { op: "answer"; client: number; request: number }
	| { op: "detach"; client: number }
	| { op: "attach"; client: number }
	| { op: "status"; key: number; text?: string };

const CLIENT_KINDS: HostRequestKind[][] = [[...DIALOGS, "approval"], DIALOGS, []];

describe("LiveState properties", () => {
	it("each client's view is the live state it may see, and each request has at most one accepted answer", async () => {
		const step: fc.Arbitrary<Step> = fc.oneof(
			fc.record({ op: fc.constant("ask" as const), kind: fc.constantFrom("confirm" as const, "approval" as const) }),
			fc.record({ op: fc.constant("answer" as const), client: fc.nat(2), request: fc.nat(5) }),
			fc.record({ op: fc.constant("detach" as const), client: fc.nat(2) }),
			fc.record({ op: fc.constant("attach" as const), client: fc.nat(2) }),
			fc.record({
				op: fc.constant("status" as const),
				key: fc.nat(2),
				text: fc.option(fc.string({ maxLength: 4 }), { nil: undefined }),
			}),
		);
		await fc.assert(
			fc.asyncProperty(fc.array(step, { maxLength: 40 }), async (steps) => {
				const live = new LiveState();
				const views = CLIENT_KINDS.map(() => new Map<string, LiveValue>());
				const detaches: Array<(() => void) | undefined> = [];
				const accepted = new Map<string, number>();
				const asked: Array<{ id: string; outcome: Promise<unknown> }> = [];
				const attach = (index: number): void => {
					const view = views[index];
					const client: LiveClient = {
						acceptsHostRequest: (kind) => CLIENT_KINDS[index].includes(kind),
						apply: (update) => {
							if (update.reset) view.clear();
							for (const item of update.items) applyItem(view, item);
						},
					};
					detaches[index] = live.attach(`client-${index}`, client);
				};
				for (let index = 0; index < CLIENT_KINDS.length; index++) attach(index);
				for (const current of steps) {
					switch (current.op) {
						case "ask": {
							const id = `request-${asked.length}`;
							const outcome =
								current.kind === "confirm"
									? live.request(confirm, { id, unattended: true })
									: live.request({ kind: "approval", action: "a", title: "t" }, { id, unattended: true });
							asked.push({ id, outcome });
							break;
						}
						case "answer": {
							const request = asked[current.request];
							if (!request) break;
							const kind = live.pendingRequest(request.id)?.request.kind;
							const response = kind === "approval" ? { decision: "approved" as const } : { confirmed: true };
							const result = live.answer(request.id, response, `client-${current.client}`);
							if (result === "accepted") accepted.set(request.id, (accepted.get(request.id) ?? 0) + 1);
							const allowed =
								detaches[current.client] !== undefined &&
								kind !== undefined &&
								CLIENT_KINDS[current.client].includes(kind);
							expect(result === "accepted").toBe(allowed);
							break;
						}
						case "detach":
							detaches[current.client]?.();
							detaches[current.client] = undefined;
							expect(views[current.client].size).toBe(0);
							break;
						case "attach":
							if (detaches[current.client] === undefined) attach(current.client);
							break;
						case "status":
							if (current.text === undefined) live.clear(`ext_status/${current.key}`);
							else live.set(`ext_status/${current.key}`, { kind: "ext_status", text: current.text });
							break;
					}
					// Every attached client holds exactly what it may see of the live state.
					for (let index = 0; index < CLIENT_KINDS.length; index++) {
						if (detaches[index] === undefined) continue;
						const visible = live
							.entries()
							.filter(
								([, value]) =>
									value.kind !== "host_request" || CLIENT_KINDS[index].includes(value.request.kind),
							);
						expect([...views[index]]).toEqual(visible);
					}
				}
				for (const count of accepted.values()) expect(count).toBe(1);
				live.close();
				await Promise.all(asked.map((request) => request.outcome));
			}),
		);
	});
});

describe("form field patterns", () => {
	it("accepts patterns with few choice points and refuses ones that could backtrack without bound", () => {
		for (const pattern of ["[a-z]+", "\\d{3}-\\d{4}", "(?:jpg|png|gif)", "[a-z]+@[a-z]+\\.[a-z]{2,}", "x?y"]) {
			expect(isSafeFormPattern(pattern), pattern).toBe(true);
		}
		for (const pattern of [
			"(a+)+",
			"(a|ab)*",
			"(a)\\1",
			"(?=a)a",
			"(?:a|a)".repeat(25),
			`${"a?".repeat(25)}${"a".repeat(25)}`,
			"(?:\\w|\\d)".repeat(10),
			"a|b|c|d|e|f",
			"a*b*c*d*",
			"x".repeat(513),
		]) {
			expect(isSafeFormPattern(pattern), pattern).toBe(false);
		}
	});

	it("refuses patterns whose repeats can trade characters, which backtrack polynomially", () => {
		for (const pattern of [
			"\\w+\\.\\w+",
			"\\d+(?:\\.\\d+)?",
			"[^@\\s]+@[^@\\s]+\\.\\w{2,}",
			"[A-Z][a-z]* [A-Z][a-z]*",
			"(?<user>[a-z]+):(?<id>\\d+)",
		]) {
			expect(isSafeFormPattern(pattern), pattern).toBe(true);
		}
		for (const pattern of [
			"a{0,256}a+a{0,256}\\w{2}",
			"\\w*\\w*\\w*",
			"a+.a+",
			"(?:a|ab)*b*",
			"\\w+\\s?\\w+",
			".*x.*",
			"[a-z]+(?:-[a-z]+)?[a-z]*",
			"(?:\\d+|x)\\d+",
			"\\u{1F600}+\\uD83D\\uDE00+",
		]) {
			expect(isSafeFormPattern(pattern), pattern).toBe(false);
		}
	});

	it("tests every pattern it accepts against an adversarial value quickly", () => {
		const atom = fc.constantFrom("a", "[ab]", "\\w", ".", "(?:a|a)", "(?:a|ab)", "(?:ab)");
		const quantifier = fc.constantFrom("", "", "?", "*", "+", "{0,256}", "{2}");
		const pattern = fc
			.array(fc.tuple(atom, quantifier), { minLength: 1, maxLength: 30 })
			.map((parts) => parts.map(([part, count]) => `${part}${count}`).join(""));
		const values = [
			`${"a".repeat(FORM_PATTERN_VALUE_MAX_CHARS - 1)}!`,
			"ab".repeat(FORM_PATTERN_VALUE_MAX_CHARS / 2),
		];
		fc.assert(
			fc.property(pattern, (source) => {
				if (!isSafeFormPattern(source)) return;
				const regex = new RegExp(`^(?:${source})$`, "u");
				for (const value of values) {
					const started = performance.now();
					regex.test(value);
					// Polynomial even on a slow host; a pattern that backtracks without bound takes seconds.
					expect(performance.now() - started, source).toBeLessThan(1_000);
				}
			}),
			{ numRuns: 300 },
		);
	});
});

function applyItem(view: Map<string, LiveValue>, item: LiveItem): void {
	if (item.type === "set") view.set(item.key, item.value);
	else if (item.type === "clear") view.delete(item.key);
}
