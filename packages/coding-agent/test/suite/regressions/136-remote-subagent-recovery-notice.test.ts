import { type HostFrame, type ProjectedEntry, REMOTE_CAPABILITIES } from "@hansjm10/volt-protocol";
import { expect, test } from "vitest";
import { serveIrohRemoteConnection } from "../../../src/core/remote/iroh/connection.ts";
import { projectSessionTranscript } from "../../../src/core/rpc/transcript.ts";
import { createIrohStreamPair } from "../../utilities/iroh-stream-pair.ts";
import { connectRemotePhone } from "../../utilities/remote-phone.ts";
import { createHostHarness } from "../host-harness.ts";

test("remote transcripts surface subagent recovery notices as system text", async () => {
	const harness = await createHostHarness({ whenUnattached: "keep" });
	const pair = createIrohStreamPair();
	try {
		const conversation = await harness.openStartup();
		const session = conversation.session;
		const workspace = conversation.cwd;
		const noticeText = `Recovered result at ${workspace}/report.md`;
		const recoveryEntryId = await session.sessionWriter.appendCustomMessageEntry(
			"subagent_recovery",
			noticeText,
			true,
		);
		const reviewEntryId = await session.sessionWriter.appendCustomMessageEntry("review", "Review result", true);
		const hiddenRecoveryEntryId = await session.sessionWriter.appendCustomMessageEntry(
			"subagent_recovery",
			"Hidden recovery",
			false,
		);
		const extensionEntryId = await session.sessionWriter.appendCustomMessageEntry(
			"extension.note",
			"Displayed extension note",
			true,
		);

		const localTranscript = projectSessionTranscript(session.sessionManager);
		expect(localTranscript.items).toEqual([
			expect.objectContaining({ id: recoveryEntryId, role: "system", text: noticeText }),
			expect.objectContaining({ id: reviewEntryId, role: "assistant", text: "Review result" }),
		]);

		const connection = serveIrohRemoteConnection({
			host: harness.host,
			conversation,
			stream: pair.host,
			grant: { schemaVersion: 1, revision: 1, capabilities: [...REMOTE_CAPABILITIES] },
			redaction: { workspacePath: workspace },
			redirect: {},
		});
		const phone = connectRemotePhone(pair.phone);
		await phone.hello();
		await phone.subscribe(conversation.id);
		const snapshot = phone.frames.find(
			(frame): frame is Extract<HostFrame, { type: "snapshot" }> => frame.type === "snapshot",
		);
		const entries: ProjectedEntry[] = snapshot?.state.entries ?? [];
		const visible = entries.filter((entry) => entry.type === "custom_message");
		expect(visible.map((entry) => ({ id: entry.id, view: entry.view }))).toEqual([
			{
				id: recoveryEntryId,
				view: expect.objectContaining({ role: "system", text: "Recovered result at /workspace/report.md" }),
			},
			{ id: reviewEntryId, view: expect.objectContaining({ role: "assistant", text: "Review result" }) },
		]);
		const entryIds = entries.map((entry) => entry.id);
		expect(entryIds).not.toContain(hiddenRecoveryEntryId);
		expect(entryIds).not.toContain(extensionEntryId);

		expect(await phone.query("content", { entryId: recoveryEntryId })).toMatchObject({
			type: "result",
			data: {
				entryId: recoveryEntryId,
				part: 0,
				parts: 1,
				content: { type: "text", text: "Recovered result at /workspace/report.md", nextOffset: null },
			},
		});
		expect(await phone.query("content", { entryId: hiddenRecoveryEntryId })).toMatchObject({
			type: "query_error",
			reason: { code: "invalid_input" },
		});
		expect(JSON.stringify(phone.frames)).not.toContain(workspace);

		await connection.close();
	} finally {
		await harness.cleanup();
	}
});
