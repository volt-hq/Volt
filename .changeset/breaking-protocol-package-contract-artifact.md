---
"@hansjm10/volt-protocol": minor
"@hansjm10/volt-coding-agent": minor
---

breaking(rpc): The RPC contract artifact moved to the new `@hansjm10/volt-protocol` package, which now also publishes the conversation log entry schemas and the `UiNode` UI schema.

Read the contract from `packages/protocol/contract/protocol-schema.json` in the repository, or from `@hansjm10/volt-protocol/contract/protocol-schema.json` in the published package. `packages/coding-agent/contract/rpc-schema.json` is gone and the coding agent package no longer ships a `contract` directory; there is no compatibility copy. Existing wire definitions keep their names and shapes; the artifact adds `LogEntry.*`, `LogEntryPayload.*`, and `Ui*` definitions and an `x-volt-limits.uiNode` block. Extensions can import the schemas from `@hansjm10/volt-protocol`.
