#!/usr/bin/env node
// Reports provider default models that are missing from the model catalog.
//
// Usage (from the repository root, after building packages/tui, packages/ai, and packages/agent):
//   node .volt/skills/release/check-default-models.mjs
//
// Reads the catalog from packages/ai/src, so it checks a freshly regenerated models.generated.ts.
// Exits non-zero when any default is missing.

import { getModel } from "../../../packages/ai/src/models.ts";
import { defaultModelPerProvider } from "../../../packages/coding-agent/src/core/model-resolver.ts";

const defaults = Object.entries(defaultModelPerProvider);
const missing = defaults.filter(([provider, id]) => !getModel(provider, id));
for (const [provider, id] of missing) console.log(`missing default: ${provider} -> ${id}`);
console.log(`${defaults.length} provider defaults checked, ${missing.length} missing`);
process.exitCode = missing.length ? 1 : 0;
