import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager, type SessionReference } from "../../../src/core/session-manager.ts";
import { createHostHarness, type HostHarness, moved } from "../host-harness.ts";

describe("regression #852: session_before_switch handlers get their own targetSessionRef", () => {
	const harnesses: HostHarness[] = [];
	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	async function storedSession(harness: HostHarness, text: string): Promise<SessionReference> {
		const manager = await SessionManager.create(harness.tempDir, join(harness.tempDir, "sessions"));
		await manager.logWriter.appendMessage({ role: "user", content: text, timestamp: Date.now() });
		const ref = manager.getSessionRef();
		await manager.closePersistence();
		if (!ref) throw new Error("Expected a stored session");
		return ref;
	}

	it("opens the requested session when a handler rewrites the reference, and later handlers see the original", async () => {
		let decoyRef: SessionReference | undefined;
		const seen: (SessionReference | undefined)[] = [];
		const harness = await createHostHarness({
			extension: (volt) => {
				volt.on("session_before_switch", (event) => {
					// What a JavaScript handler can do despite the readonly fields.
					if (event.targetSessionRef && decoyRef) Object.assign(event.targetSessionRef, decoyRef);
					return undefined;
				});
				volt.on("session_before_switch", (event) => {
					seen.push(event.targetSessionRef === undefined ? undefined : { ...event.targetSessionRef });
				});
			},
		});
		harnesses.push(harness);
		const source = await harness.openStartup();
		const client = harness.client("tui", { anchor: true });
		await harness.host.attach(client, source);
		harness.events.length = 0;
		const targetRef = await storedSession(harness, "target prompt");
		decoyRef = await storedSession(harness, "decoy prompt");
		// An unfrozen reference, as one parsed from a client or an extension is.
		const requested: SessionReference = { ...targetRef };

		const result = moved(await harness.host.openFor(client, { kind: "session", ref: requested }));

		expect(result.sessionId).toBe(targetRef.sessionId);
		expect(result.conversation.session.messages).toMatchObject([{ role: "user", content: "target prompt" }]);
		expect(harness.host.get(decoyRef.sessionId)).toBeUndefined();
		expect(requested).toEqual(targetRef);
		// The recording extension's handler runs before the rewrite, the observer after it.
		expect(harness.events[0]).toEqual({
			type: "session_before_switch",
			reason: "resume",
			targetSessionRef: targetRef,
			sessionId: source.id,
		});
		expect(seen).toEqual([targetRef]);
	});
});
