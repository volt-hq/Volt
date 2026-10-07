/**
 * Custom entries an extension writes with `volt.appendEntry`: any type of its own commits to the log, but the host's
 * review records (`volt.review.*`) are the host's. Later host reviews, publishing, and the findings handoff read those
 * records back by type, so an extension must not be able to write one.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../src/core/extensions/index.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.cleanupAsync();
});

describe("extension custom entries", () => {
	it("refuses the host's review record types and keeps every other type writable", async () => {
		const refusals: string[] = [];
		const extension: ExtensionFactory = (volt) => {
			volt.registerCommand("write", {
				handler: async () => {
					for (const type of [
						"volt.review.run",
						"volt.review.acknowledgment",
						"volt.review.finding-transition",
						"volt.review.publication",
						"volt.review.anything-later",
					]) {
						await volt.appendEntry(type, { forged: true }).catch((error: unknown) => {
							refusals.push(error instanceof Error ? error.message : String(error));
						});
					}
					await volt.appendEntry("my-extension.state", { count: 1 });
					// Not the host's prefix, so it is the extension's own type.
					await volt.appendEntry("volt-review", { fine: true });
				},
			});
		};
		const harness = await createHarness({ extensionFactories: [extension] });
		harnesses.push(harness);

		await harness.session.prompt("/write");

		expect(refusals).toEqual([
			"Custom entries of type volt.review.run are the host's",
			"Custom entries of type volt.review.acknowledgment are the host's",
			"Custom entries of type volt.review.finding-transition are the host's",
			"Custom entries of type volt.review.publication are the host's",
			"Custom entries of type volt.review.anything-later are the host's",
		]);
		const types = harness.sessionManager
			.getEntries()
			.flatMap((entry) => (entry.type === "custom" ? [entry.customType] : []));
		expect(types).toContain("my-extension.state");
		expect(types).toContain("volt-review");
		expect(types.filter((type) => type.startsWith("volt.review."))).toEqual([]);
	});
});
