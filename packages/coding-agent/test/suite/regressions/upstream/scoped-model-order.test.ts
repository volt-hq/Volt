// Upstream Pi regression: https://github.com/earendil-works/pi/issues/3217

import { setKeybindings, type TUI } from "@hansjm10/volt-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../../../../src/core/keybindings.ts";
import { toIrohRemoteAgentOptionsCatalogModel } from "../../../../src/core/remote/iroh/agent-options.ts";
import { initTheme } from "../../../../src/core/theme/runtime.ts";
import { ModelSelectorComponent } from "../../../../src/modes/interactive/components/model-selector.ts";
import { ScopedModelsSelectorComponent } from "../../../../src/modes/interactive/components/scoped-models-selector.ts";
import { stripAnsi } from "../../../../src/utils/ansi.ts";
import { createHarness, type Harness } from "../../harness.ts";

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

describe("issue #3217 scoped model ordering", () => {
	const harnesses: Harness[] = [];

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		// Ensure test isolation: keybindings are a global singleton
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("propagates reordered scoped models back to the session state", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
				{ id: "faux-3", name: "Three", reasoning: true },
			],
		});
		harnesses.push(harness);

		const orderedIds = harness.models.map((model) => `${model.provider}/${model.id}`);
		const changes: Array<string[] | null> = [];
		const selector = new ScopedModelsSelectorComponent(
			{
				allModels: [...harness.models],
				enabledModelIds: orderedIds,
			},
			{
				onChange: (enabledModelIds) => {
					changes.push(enabledModelIds);
				},
				onPersist: () => {},
				onCancel: () => {},
			},
		);

		selector.handleInput("\x1b[1;3B");

		expect(changes).toEqual([[orderedIds[1], orderedIds[0], orderedIds[2]]]);
	});

	it("preserves scoped model order in the /model scoped tab", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
				{ id: "faux-3", name: "Three", reasoning: true },
			],
		});
		harnesses.push(harness);

		const modelOne = harness.getModel("faux-1")!;
		const modelTwo = harness.getModel("faux-2")!;
		const modelThree = harness.getModel("faux-3")!;
		const scoped = (model: typeof modelOne) => ({ provider: model.provider, modelId: model.id });
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			{
				models: harness.models.map(toIrohRemoteAgentOptionsCatalogModel),
				scoped: [scoped(modelTwo), scoped(modelOne), scoped(modelThree)],
				current: scoped(modelOne),
			},
			() => {},
			() => {},
		);

		const renderedLines = stripAnsi(selector.render(120).lines.join("\n"))
			.split("\n")
			.filter((line) => line.includes(`[${modelOne.provider}]`));
		const orderedIds = renderedLines.slice(0, 3).map((line) => {
			const [modelId] = line.trim().replace(/^→\s*/, "").split(" [");
			return modelId?.trim() ?? "";
		});

		expect(orderedIds).toEqual([modelTwo.id, modelOne.id, modelThree.id]);
	});
});
