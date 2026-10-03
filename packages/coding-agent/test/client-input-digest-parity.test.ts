import { clientInputDigest } from "@hansjm10/volt-agent-core";
import type { ImageContent } from "@hansjm10/volt-ai";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { digestClientInputPayload, normalizeClientInputPayload } from "../src/core/session-entry-codec.ts";
import type { ClientInputCommand, ClientInputPayloadInput } from "../src/core/session-manager.ts";

// The conversation kernel writes client input receipts with a WebCrypto digest
// of the protocol's shared digest material; the session store validates stored
// receipts with its own node:crypto digest of the normalized payload. Both must
// agree for every input, whatever key order its images arrive in.

const PROPERTY_SEED = 5_850_701;

const imageArbitrary: fc.Arbitrary<ImageContent> = fc
	.tuple(
		fc.constantFrom("image/png", "image/jpeg", "image/webp"),
		fc.base64String({ maxLength: 48 }),
		fc.nat({ max: 2 }),
	)
	.map(([mimeType, data, order]) =>
		order === 0
			? { type: "image", mimeType, data }
			: order === 1
				? { data, mimeType, type: "image" }
				: { mimeType, type: "image", data },
	);

const inputArbitrary: fc.Arbitrary<{ command: ClientInputCommand; input: ClientInputPayloadInput }> = fc
	.record({
		command: fc.constantFrom<ClientInputCommand>("prompt", "steer", "follow_up"),
		message: fc.string({ unit: "binary", maxLength: 40 }),
		images: fc.option(fc.array(imageArbitrary, { maxLength: 3 }), { nil: undefined }),
		streamingBehavior: fc.option(fc.constantFrom("steer" as const, "followUp" as const), { nil: undefined }),
	})
	.map(({ command, message, images, streamingBehavior }) => ({
		command,
		input: {
			message,
			...(images === undefined ? {} : { images }),
			...(command === "prompt" && streamingBehavior !== undefined ? { streamingBehavior } : {}),
		},
	}));

describe("client input digest parity", () => {
	it("matches the kernel's digest of the shared material for every input", async () => {
		await fc.assert(
			fc.asyncProperty(inputArbitrary, async ({ command, input }) => {
				const normalized = normalizeClientInputPayload(command, input);
				const stored = digestClientInputPayload(command, normalized);
				const raw = {
					message: input.message,
					images: [...(input.images ?? [])],
					...(input.streamingBehavior === undefined ? {} : { streamingBehavior: input.streamingBehavior }),
				};
				expect(await clientInputDigest(command, raw)).toBe(stored);
				expect(await clientInputDigest(command, normalized)).toBe(stored);
			}),
			{ seed: PROPERTY_SEED, numRuns: 300 },
		);
	});
});
