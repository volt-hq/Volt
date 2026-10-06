/**
 * `set_model` carries how the client chose the model: a step through the
 * cycle scope (`source: "cycle"`, as the TUI's model-cycle keys send it)
 * reaches extensions as `model_select` with that source; a pick defaults to
 * `"set"`.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createLoopbackClient } from "../../src/client/protocol-client.ts";
import type { ExtensionAPI, ModelSelectEvent } from "../../src/core/extensions/index.ts";
import { createHostHarness } from "../suite/host-harness.ts";

describe("set_model's source", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	it("reaches extensions as model_select's source: cycle when the client stepped the cycle, else set", async () => {
		const selects: Array<Pick<ModelSelectEvent, "source"> & { model: string }> = [];
		const harness = await createHostHarness({
			models: [
				{ id: "faux-1", reasoning: false },
				{ id: "faux-2", reasoning: false },
			],
			extension: (volt: ExtensionAPI) => {
				volt.on("model_select", (event) => {
					selects.push({ model: event.model.id, source: event.source });
				});
			},
		});
		cleanups.push(() => harness.cleanup());
		const conversation = await harness.openStartup();
		const client = await createLoopbackClient(harness.host, conversation);
		cleanups.push(() => client.stop());
		const provider = harness.faux.getModel().provider;
		const startModel = conversation.session.model?.id;
		const other = startModel === "faux-1" ? "faux-2" : "faux-1";

		await client.intent("set_model", { provider, modelId: other, source: "cycle" });
		await client.intent("set_model", { provider, modelId: startModel ?? "faux-1" });

		expect(selects).toEqual([
			{ model: other, source: "cycle" },
			{ model: startModel, source: "set" },
		]);
	});
});
