---
"@hansjm10/volt-ai": minor
"@hansjm10/volt-coding-agent": minor
---

breaking(ai): `calculateCost` no longer writes `usage.cost` in place; it returns a new cost that records the `priceVersion` of the price table it used, and `@hansjm10/volt-ai` now exports TypeBox schemas for messages, content blocks, usage, and model metadata.

To migrate a custom provider or extension that called `calculateCost(model, usage)` for its side effect, assign the result instead: `usage = { ...usage, cost: calculateCost(model, usage) }`. The second argument only needs the token counts (`input`, `output`, `cacheRead`, `cacheWrite`, and optionally `cacheWrite1h`).

The schemas are also exported from the `@hansjm10/volt-ai/schemas` subpath, which loads only TypeBox.

The RPC contract artifact now declares the optional `usage.cost.priceVersion` on assistant messages and the optional `promptCache` model metadata the host already sent with `RpcModel` and `RpcCatalogModel`.
