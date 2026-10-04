/**
 * The host's intents (RFC §6.1). Every wire that invokes an intent goes
 * through {@link intentRegistry}: protocol frames, the legacy RPC commands and
 * UI actions, the Iroh remote commands, and TUI slash commands.
 */

import { createBuiltinIntents } from "./builtin.ts";
import { IntentRegistry } from "./registry.ts";

export { createBuiltinIntents } from "./builtin.ts";
export type { DynamicIntent } from "./dynamic.ts";
export { findDynamicIntent, listDynamicIntents } from "./dynamic.ts";
export type { BuiltinIntentDefinitions, IntentOutcome } from "./outcomes.ts";
export { isBuiltinIntentName } from "./outcomes.ts";
export type { DynamicIntentOutcome, IntentInvocation, IntentInvokeOptions, ResolvedIntent } from "./registry.ts";
export { IntentRegistry } from "./registry.ts";
export { intentStateOf } from "./state.ts";
export * from "./types.ts";

/** The registry of built-in intents every host invokes through. */
export const intentRegistry = new IntentRegistry(createBuiltinIntents);
