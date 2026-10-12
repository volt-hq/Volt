import type { AgentMessage } from "@hansjm10/volt-agent-core";
import { type DeepReadonly, fauxAssistantMessage, type ImageContent } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

const image: ImageContent = { type: "image", mimeType: "image/png", data: "b3JpZ2luYWw=" };
const replacement: ImageContent = { type: "image", mimeType: "image/jpeg", data: "cmVwbGFjZWQ=" };

function userImages(messages: readonly DeepReadonly<AgentMessage>[]): DeepReadonly<ImageContent>[] {
	const user = messages.find((message) => message.role === "user");
	if (user?.role !== "user" || typeof user.content === "string") return [];
	return user.content.filter((part) => part.type === "image");
}

function committedUserImages(harness: Harness): DeepReadonly<ImageContent>[] {
	return userImages(
		harness.sessionManager.getEntries().flatMap((entry) => (entry.type === "message" ? [entry.message] : [])),
	);
}

describe("regression #781: input image isolation", () => {
	let harness: Harness | undefined;

	afterEach(async () => {
		harness?.session.dispose();
		if (harness) await harness.session.waitForClosed();
		harness?.cleanup();
		harness = undefined;
	});

	it("commits the prompt images a continuing handler mutated in place unchanged", async () => {
		const seenByLaterHandler: ImageContent[][] = [];
		const seenByAgentStart: ImageContent[][] = [];
		harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.on("input", (event) => {
						const first = event.images?.[0];
						if (first) first.data = "bXV0YXRlZA==";
						event.images?.push({ type: "image", mimeType: "image/jpeg", data: "ZXh0cmE=" });
						return { action: "continue" };
					});
				},
				(volt) => {
					volt.on("input", (event) => {
						seenByLaterHandler.push(structuredClone(event.images ?? []));
					});
					volt.on("before_agent_start", (event) => {
						seenByAgentStart.push(structuredClone(event.images ?? []));
					});
				},
			],
		});
		let providerImages: DeepReadonly<ImageContent>[] = [];
		harness.setResponses([
			(context) => {
				providerImages = userImages(context.messages);
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt("describe", { images: [image] });

		expect(seenByLaterHandler).toEqual([[image]]);
		expect(seenByAgentStart).toEqual([[image]]);
		expect(providerImages).toEqual([image]);
		expect(userImages(harness.session.messages)).toEqual([image]);
		expect(committedUserImages(harness)).toEqual([image]);
	});

	it("commits the images a transform result returns", async () => {
		const seenByLaterHandler: ImageContent[][] = [];
		harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.on("input", (event) => ({ action: "transform", text: event.text, images: [replacement] }));
				},
				(volt) => {
					volt.on("input", (event) => {
						seenByLaterHandler.push(structuredClone(event.images ?? []));
						event.images?.splice(0);
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("ok")]);

		await harness.session.prompt("describe", { images: [image] });

		expect(seenByLaterHandler).toEqual([[replacement]]);
		expect(userImages(harness.session.messages)).toEqual([replacement]);
		expect(committedUserImages(harness)).toEqual([replacement]);
	});
});
