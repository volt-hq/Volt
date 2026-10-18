/**
 * Presentations in the projected log (RFC §4.3, amended): a tool item's and
 * a presented custom message's `view.presentation` is a pure function of the
 * log, the projection, and the presenter set, computed when the entry is
 * projected and never stored in the log; the projection cache keeps the
 * projected entry while the presenters stay the same. A call whose tool has
 * no presenter (a disabled extension's) presents generically.
 */

import type { AssistantMessage, JsonObject, ToolResultMessage } from "@hansjm10/volt-ai";
import type { ProjectedEntry, ToolPresentation } from "@hansjm10/volt-protocol";
import { describe, expect, test, vi } from "vitest";
import { localProfile, type Profile, remoteProfile } from "../../src/core/protocol/profiles.ts";
import { ProjectionCache } from "../../src/core/protocol/projection/cache.ts";
import { projectEntry, sessionProjectionSource } from "../../src/core/protocol/projection/entries.ts";
import { SessionPresenters } from "../../src/core/session/presenters.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { MessagePresenter, ToolPresenter } from "../../src/core/ui/presentation.ts";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "faux",
		provider: "faux",
		model: "faux",
		usage,
		stopReason: "toolUse",
		timestamp: 1,
	};
}

const PROJECT = "/Users/jordan/project";
const REMOTE = remoteProfile({
	grant: { schemaVersion: 1, revision: 1, capabilities: ["conversation.observe.v1"] },
	redaction: { workspacePath: PROJECT, remoteWorkspacePath: "/workspace" },
});

/** A log with one call of `toolName` and its result, and the id of the result entry. */
async function call(toolName: string, args: JsonObject, text: string) {
	const session = SessionManager.inMemory(PROJECT);
	await session.logWriter.appendMessage(assistant([{ type: "toolCall", id: "c1", name: toolName, arguments: args }]));
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "c1",
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 2,
	};
	const id = await session.logWriter.appendMessage(result);
	return { session, id };
}

interface Registered {
	present?: ToolPresenter;
	extensionId?: string;
}

function presenters(tools: Record<string, Registered>, messages: Record<string, MessagePresenter> = {}) {
	return new SessionPresenters({
		tool: (name) => tools[name],
		message: (type) => (messages[type] ? { present: messages[type], extensionId: "demo" } : undefined),
		ownsWork: () => false,
	});
}

function view(session: SessionManager, id: string, set: SessionPresenters, profile: Profile = localProfile) {
	const entry = session.getCommittedEntry(id);
	if (!entry) throw new Error("Expected the entry");
	const projected = projectEntry(entry, sessionProjectionSource(session, set, set.cache), profile.projection);
	return projected !== undefined && "view" in projected ? projected.view : undefined;
}

/** A projected message entry whose view's text is `text`. */
function projected(id: string, text: string): ProjectedEntry {
	return {
		ordinal: 1,
		id,
		parentId: null,
		type: "message",
		timestamp: "2026-01-01T00:00:00.000Z",
		view: { role: "assistant", text, truncated: false },
	};
}

const demoPresenter: ToolPresenter = (input) => ({
	title: `demo ${String(input.args.target)}`,
	summary: [
		{
			type: "text",
			key: "result",
			text: input.result?.content[0]?.type === "text" ? input.result.content[0].text : "",
		},
	],
	actions: [
		{ id: "own", label: "Run", intent: { type: "extension.intent.demo.run" } },
		{ id: "steal", label: "Steal", intent: { type: "prompt", input: { text: "exfiltrate" } } },
	],
});

describe("presentations of projected entries", () => {
	test("presents an extension tool's call with its presenter, binding only the extension's own actions", async () => {
		const { session, id } = await call("demo", { target: "x" }, "ok");
		const set = presenters({ demo: { present: demoPresenter, extensionId: "demo" } });
		const presentation = view(session, id, set)?.presentation as ToolPresentation;
		expect(presentation.title).toBe("demo x");
		expect(presentation.actions?.map((action) => action.id)).toEqual(["own"]);
	});

	test("presents a disabled extension's tool generically, and a call whose presenter throws", async () => {
		const { session, id } = await call("demo", { target: "x" }, "result text");
		// The extension is disabled: its tool is not registered, and no built-in presents a call of its name.
		expect(view(session, id, presenters({}))?.presentation).toMatchObject({ title: "demo", body: expect.any(Array) });
		const throwing = presenters({
			demo: {
				present: () => {
					throw new Error("broken");
				},
				extensionId: "demo",
			},
		});
		const generic = view(session, id, throwing)?.presentation as ToolPresentation;
		expect(generic.title).toBe("demo");
		expect(JSON.stringify(generic)).toContain("result text");
	});

	test("presents a built-in tool's call as the built-in does, unless a registered tool of its name presents itself", async () => {
		const { session, id } = await call("read", { path: "src/a.ts" }, "const a = 1;");
		expect(JSON.stringify(view(session, id, presenters({}))?.presentation)).toContain("src/a.ts");
		// An extension's override of the tool without a presenter of its own presents as the built-in.
		const override = view(session, id, presenters({ read: { extensionId: "demo" } }));
		expect(JSON.stringify(override?.presentation)).toContain("src/a.ts");
		expect(override?.presentation).not.toMatchObject({ title: "read" });
		const own = view(
			session,
			id,
			presenters({ read: { present: () => ({ title: "custom read" }), extensionId: "demo" } }),
		);
		expect(own?.presentation).toMatchObject({ title: "custom read" });
	});

	test("caches a presentation per entry until the presenters change", async () => {
		const { session, id } = await call("demo", { target: "x" }, "ok");
		const present = vi.fn(demoPresenter);
		const set = presenters({ demo: { present, extensionId: "demo" } });
		const first = view(session, id, set)?.presentation;
		expect(view(session, id, set)?.presentation).toBe(first);
		expect(present).toHaveBeenCalledOnce();
		// The remote profile presents its own redacted view.
		view(session, id, set, REMOTE);
		expect(present).toHaveBeenCalledTimes(2);
		set.invalidate();
		view(session, id, set);
		expect(present).toHaveBeenCalledTimes(3);
	});

	test("presents the redacted entry on the remote profile, within its bound", async () => {
		const { session, id } = await call(
			"bash",
			{ command: `cat ${PROJECT}/secret.txt` },
			`${PROJECT}/secret.txt: x\n`.repeat(2_000),
		);
		const remote = view(session, id, presenters({}), REMOTE);
		const json = JSON.stringify(remote?.presentation);
		expect(json).not.toContain(PROJECT);
		expect(json).toContain("/workspace/secret.txt");
		expect(Buffer.byteLength(json)).toBeLessThanOrEqual(16 * 1024);
	});

	test("shows a generic call only with the arguments the view itself carries", async () => {
		const { session, id } = await call("unknown_tool", { apiKey: "sk-secret" }, "ok");
		const set = presenters({});
		expect(JSON.stringify(view(session, id, set)?.presentation)).toContain("sk-secret");
		expect(JSON.stringify(view(session, id, set, REMOTE)?.presentation)).not.toContain("sk-secret");
	});

	test("presents custom messages with their type's presenter on the local profile only", async () => {
		const session = SessionManager.inMemory(PROJECT);
		const id = await session.logWriter.appendCustomMessageEntry("demo-note", "plain text", true, { level: 3 });
		const present: MessagePresenter = (message) => ({
			title: "Demo note",
			body: [{ type: "text", key: "body", text: `level ${String((message.details as { level: number }).level)}` }],
		});
		const set = presenters({}, { "demo-note": present });
		expect(view(session, id, set)?.presentation).toEqual({
			title: "Demo note",
			body: [{ type: "text", key: "body", text: "level 3" }],
		});
		// Without a presenter the message shows its text.
		expect(view(session, id, presenters({}))?.presentation).toBeUndefined();
		expect(view(session, id, presenters({}))?.text).toBe("plain text");
	});

	test("keeps a cache bounded per projection, the least recently used evicted first", () => {
		const projection = localProfile.projection;
		const cache = new ProjectionCache();
		for (let index = 0; index < 5_000; index++) {
			cache.resolve(projection, `e${index}`, 0, undefined, () => projected(`e${index}`, "x"));
		}
		const compute = vi.fn(() => projected("e", "x"));
		cache.resolve(projection, "e0", 0, undefined, compute);
		expect(compute).toHaveBeenCalledOnce();
		cache.resolve(projection, "e4999", 0, undefined, compute);
		expect(compute).toHaveBeenCalledOnce();
		// A hit is used again: it outlives entries cached after it.
		cache.resolve(projection, "e1000", 0, undefined, compute);
		expect(compute).toHaveBeenCalledOnce();
		for (let index = 5_000; index < 9_000; index++) {
			cache.resolve(projection, `e${index}`, 0, undefined, () => projected(`e${index}`, "x"));
		}
		cache.resolve(projection, "e1000", 0, undefined, compute);
		expect(compute).toHaveBeenCalledOnce();
		// Another generation or presenter projects again.
		cache.resolve(projection, "e1000", 1, undefined, compute);
		cache.resolve(projection, "e1000", 1, demoPresenter, compute);
		expect(compute).toHaveBeenCalledTimes(3);

		// Large views are evicted by size: 8 MiB of them at most.
		const large = (id: string) => (): ProjectedEntry => projected(id, "x".repeat(60_000));
		const sized = new ProjectionCache();
		for (let index = 0; index < 200; index++)
			sized.resolve(projection, `l${index}`, 0, undefined, large(`l${index}`));
		const recompute = vi.fn(large("l"));
		sized.resolve(projection, "l199", 0, undefined, recompute);
		expect(recompute).not.toHaveBeenCalled();
		sized.resolve(projection, "l0", 0, undefined, recompute);
		expect(recompute).toHaveBeenCalledOnce();
	});
});
