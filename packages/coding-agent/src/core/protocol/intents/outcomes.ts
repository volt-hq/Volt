import { type BuiltinIntentName, INTENT_SCHEMAS } from "@hansjm10/volt-protocol";
import type { createBuiltinIntents } from "./builtin.ts";
import type { IntentDefinition } from "./types.ts";

/** One definition per built-in intent, each keeping its outcome type. */
export type BuiltinIntentDefinitions = ReturnType<typeof createBuiltinIntents>;

/** The domain outcome a built-in intent's run returns. */
export type IntentOutcome<N extends BuiltinIntentName> = BuiltinIntentDefinitions[N] extends IntentDefinition<
	N,
	infer O
>
	? O
	: never;

export function isBuiltinIntentName(name: string): name is BuiltinIntentName {
	return Object.hasOwn(INTENT_SCHEMAS, name);
}
