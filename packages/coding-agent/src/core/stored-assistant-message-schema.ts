/**
 * volt-ai's AssistantMessageSchema, copied for the session-entry codec. The
 * session-store worker loads the codec in its own thread, where
 * `@hansjm10/volt-ai` resolves to the package build (absent in source test
 * runs) and loading the package index would cost the worker ~0.4 s and ~15 MB.
 * Modules this worker loads therefore take only type imports from volt-ai.
 * test/session-entry-codec.test.ts asserts this copy equals volt-ai's schema.
 */

import type { JsonObject } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { openStringEnum, stringEnum } from "./rpc/schema/helpers.ts";

const jsonObjectSchema = Type.Unsafe<JsonObject>(Type.Record(Type.String(), Type.Unknown()));
const serviceTierSchema = stringEnum(["auto", "default", "flex", "scale", "priority"]);

export const StoredAssistantMessageSchema = Type.Object(
	{
		role: Type.Literal("assistant"),
		content: Type.Array(
			Type.Union([
				Type.Object(
					{ type: Type.Literal("text"), text: Type.String(), textSignature: Type.Optional(Type.String()) },
					{ additionalProperties: false },
				),
				Type.Object(
					{
						type: Type.Literal("thinking"),
						thinking: Type.String(),
						thinkingSignature: Type.Optional(Type.String()),
						redacted: Type.Optional(Type.Boolean()),
					},
					{ additionalProperties: false },
				),
				Type.Object(
					{
						type: Type.Literal("toolCall"),
						id: Type.String(),
						name: Type.String(),
						arguments: jsonObjectSchema,
						thoughtSignature: Type.Optional(Type.String()),
					},
					{ additionalProperties: false },
				),
			]),
		),
		api: openStringEnum([
			"openai-completions",
			"mistral-conversations",
			"openai-responses",
			"azure-openai-responses",
			"openai-codex-responses",
			"anthropic-messages",
			"bedrock-converse-stream",
			"google-generative-ai",
			"google-vertex",
		]),
		provider: Type.String(),
		model: Type.String(),
		responseModel: Type.Optional(Type.String()),
		responseId: Type.Optional(Type.String()),
		diagnostics: Type.Optional(
			Type.Array(
				Type.Object(
					{
						type: Type.String(),
						timestamp: Type.Number(),
						error: Type.Optional(
							Type.Object(
								{
									name: Type.Optional(Type.String()),
									message: Type.String(),
									stack: Type.Optional(Type.String()),
									code: Type.Optional(Type.Union([Type.String(), Type.Number()])),
								},
								{ additionalProperties: false },
							),
						),
						details: Type.Optional(jsonObjectSchema),
					},
					{ additionalProperties: false },
				),
			),
		),
		usage: Type.Object(
			{
				availability: Type.Optional(stringEnum(["complete", "partial", "unavailable"])),
				input: Type.Number(),
				output: Type.Number(),
				cacheRead: Type.Number(),
				cacheWrite: Type.Number(),
				cacheWrite1h: Type.Optional(Type.Number()),
				totalTokens: Type.Number(),
				cost: Type.Object(
					{
						input: Type.Number(),
						output: Type.Number(),
						cacheRead: Type.Number(),
						cacheWrite: Type.Number(),
						total: Type.Number(),
						priceVersion: Type.Optional(Type.String()),
					},
					{ additionalProperties: false },
				),
				serviceTier: Type.Optional(
					Type.Object(
						{ requested: Type.Optional(serviceTierSchema), effective: Type.Optional(serviceTierSchema) },
						{ additionalProperties: false },
					),
				),
			},
			{ additionalProperties: false },
		),
		stopReason: stringEnum(["stop", "length", "toolUse", "error", "aborted"]),
		errorMessage: Type.Optional(Type.String()),
		timestamp: Type.Number(),
	},
	{ additionalProperties: false },
);
