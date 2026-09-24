# Bounded MCP discovery output

Investigation and implementation design for [issue #469](https://github.com/volt-hq/Volt/issues/469), based on `189b5e8c7` on 2026-09-24. The findings below describe the original behavior; the worktree now implements compact discovery and a common final-output formatter for gateway and direct-tool results.

The implementation uses a schema-free model-facing `list_tools` result with an enforced output budget and cache retrieval for overflow. Full schemas remain available through `describe`. The budget applies to the final text sent to the model, including truncation notices and cache references.

The issue reports a 1,136,239-byte result and a context increase from 151,685 to 351,873 tokens. Those incident figures come from the issue; this investigation did not retrieve the original session or run xcodebuildmcp.

The original path explains the failure:

1. [`McpServerSupervisor.listAllTools`](../../packages/coding-agent/src/core/mcp/server-supervisor.ts) collects every upstream page before returning metadata (line 415). Upstream pagination therefore does not bound the model response.
2. [`toToolSummary` and `McpManager.listTools`](../../packages/coding-agent/src/core/mcp/manager.ts) retain input/output schemas and annotations for every tool (lines 162 and 671). Descriptions are shortened to 800 characters, but neither the list length nor its serialized bytes are bounded. The gateway's `limit` and `cursor` parameters are not used by the `list_tools` branch (line 469).
3. [`createMcpToolDefinition`](../../packages/coding-agent/src/core/mcp/gateway-tool.ts) pretty-prints the complete result into `content` (line 135). The 18-line collapsed rendering is a display limit only.
4. `call`, `read_resource`, and `get_prompt` use [`McpOutputStore.shapeOutput`](../../packages/coding-agent/src/core/mcp/output-store.ts); discovery results do not. `describe` returns the full input schema and description without shaping, and currently omits the output schema (manager line 742).

`McpManager.listTools()` also has direct CLI and RPC callers, including RPC tool-detail lookup. Put the model projection in the gateway path rather than replacing the shared management result. This is a separation of presentation from metadata, not an old-client compatibility path. Implementation should verify the companion app's transcript rendering against the new gateway result; any required app change belongs in a linked volt-app issue.

A local probe constructed 200 synthetic tool summaries with ten described properties in each input/output schema. It used Node v24.20.0 and the worktree's actual `McpOutputStore`. No MCP server, model, credentials, or paid tokens were used. The projection measurements compare serialization shapes; they are not an end-to-end gateway benchmark or token counts.

| Representation | UTF-8 bytes |
| --- | ---: |
| Current full metadata, pretty JSON | 1,078,264 |
| Same metadata, compact JSON | 835,240 |
| Names, short descriptions, risk, and trusted-read flag; pretty JSON | 31,064 |
| Same summaries, compact JSON | 22,640 |

Schema-free summaries reduced this fixture by about 97%. Compacting the original metadata alone saved about 23%, leaving an oversized result. A separate 10,000-summary fixture still measured 1,139,040 bytes in compact JSON: summaries alone are not a size guarantee.

The probe also verified implementation constraints:

- The existing cache restored the full 1,078,264-byte payload exactly across 22 pages.
- Its 51,192-byte preview became 54,935 bytes after JSON wrapping with truncation/cache metadata. A quote-only 51,200-byte cache page became 102,567 bytes after JSON wrapping. The inner-content limit does not enforce the final model-text limit.
- Passing the oversized compact JSON to the current line-based head truncator returned an empty preview because the first line exceeded the byte limit. Compact serialization requires a formatter that can produce a useful bounded preview.
- Cache writes may decline an entry that exceeds capacity. The current default per-entry limit is 16 MiB of serialized cache data. A proposed response must distinguish unavailable cached output from successfully cached output.

The focused fix implements the following:

1. Project gateway `list_tools` entries to `name`, a short description (use the existing search convention of 180 characters), `risk`, and `trustedRead`. Keep server identity, metadata hash, and stale state once at the response level. Omit bulk schemas and annotations from discovery. Preserve the configured tool filtering and restricted-read checks.
2. Make `describe` expose both input and optional output schemas for one selected tool. Apply bounded output and cache retrieval there as well so schema access remains complete without recreating the overflow through another discovery action. Do not silently simplify validation constraints such as required fields, references, enums, or unions.
3. Enforce the configured byte and line budgets at the final model-output boundary for these discovery results. Defaults are 51,200 bytes and 2,000 lines. Reserve space for the complete truncation/cache notice, use UTF-8-safe boundaries, and count the final serialization. Reuse the existing session/workspace-scoped cache for the complete projected listing or selected-tool description. Keep a truncated preview explicitly distinguishable from complete JSON.
4. Ensure every continuation also fits the final budget. Cache cursors must advance by bytes actually delivered, including when a requested chunk must shrink to accommodate JSON escaping or a line limit. Avoid caching already-cached pages into new cache entries. When the cache cannot retain the result, return a bounded explanation and guidance to narrow discovery; never fall back to the full result.
5. Update gateway guidance and MCP documentation, and add the issue-linked changeset with the implementation. Raising compaction thresholds does not address the source of the growth.

The existing output store is reusable storage and retrieval infrastructure; calling `shapeOutput` and then serializing its result unchanged is insufficient. The formatter must account for its own envelope. This proposal needs no new dependency or change to the upstream MCP protocol.

Validate the implementation with a fake MCP catalog through the actual gateway execution path. Add the issue regression at `packages/coding-agent/test/suite/regressions/469-mcp-list-tools-output-bound.test.ts`, using the suite harness and faux provider. Assert the final model-visible content size, absence of bulk schemas, successful selected-tool schema retrieval, and cache continuation. Include a catalog around 1 MiB, many small tools, one huge schema, long descriptions/identifiers, escaping, Unicode, empty/stale catalogs, restricted reads, cache-capacity rejection, and cursor progress with small limits. Assert complete reconstruction for retained cache entries and no second oversized result on continuation. Existing MCP tests cover oversized call output and cache ownership/capacity, but not the oversized `list_tools` gateway path.

Run the new regression, affected MCP tests, and `npm run check` after implementation. For a PR, also run the required non-e2e checks from `CONTRIBUTING.md`. The initial investigation ran only the temporary serialization/cache probe. The implementation adds the issue regression, covering the provider context through the suite harness and faux provider as well as actual gateway/cache execution.

Validation on 2026-09-24:

- The issue regression, `test/mcp.test.ts`, and `test/sdk-disable-mcp.test.ts` passed: 48 tests passed, with one POSIX permission test skipped on Windows. The regression contributes 22 tests.
- Root TypeScript checking passed. RPC contract and shrinkwrap verification passed; release-security verification passed all 53 tests.
- `npm run check` stopped at eight Bash launcher failures in unchanged `scripts/source-launchers.test.mjs`. Its preceding formatting, pinned-dependency, changeset, source-import, and source-export checks passed. The full check did not complete.
- Separate agent-package TypeScript and browser-smoke checks could not resolve the AI package's unbuilt workspace outputs in this clean worktree. No build, dependency change, or launcher fix was made.
- Read-only source inspection of volt-app's MCP RPC models, transcript projector, and tool-event presentation found no required adaptation: management metadata remains complete, and the projector uses the retained risk, status, truncation, and cache fields. The Swift app was not built or tested.

Future optimization should proceed in this order, as separate follow-up work:

| Priority | Change | Expected benefit and constraint |
| --- | --- | --- |
| Implemented | Use one final-output budget across every MCP gateway action, direct calls, errors, and cache pages. | Compact JSON includes the envelope in the byte bound. Failed-call status and existing cache references survive truncation. |
| 2 | Add structured listing pages using the existing `limit`/`cursor` inputs, with a small default item count and the hard byte cap. Bind cursors to a catalog snapshot or reject changed metadata explicitly. | Browse complete tool records without reading slices of serialized JSON. Item counts supplement the byte bound; they cannot replace it. |
| 3 | Measure discovery bytes, estimated tokens, latency, truncation frequency, and continuation counts; evaluate a smaller soft discovery budget within the hard cap. | Tune for successful tool selection and total discovery cost, including repeat calls. A byte bound is not a model-specific token guarantee. |
| 4 | Cache a small search/list projection by metadata/config identity and freshness, then benchmark indexed lookup and top-k selection. | `McpMetadataCache.get()` currently clones the full metadata, including schemas; search scans tools and sorts all matches. Avoid that work for discovery while preserving trust and invalidation behavior. |
| 5 | If profiling justifies it, read cache byte ranges without parsing and buffering the entire cached JSON record per page. Add metadata collection page/byte ceilings and repeated-cursor detection. | Reduce repeated disk/CPU allocations and bound collection work before formatting. The current metadata cache's persistence cap does not bound upstream collection. These are separate from the context-output fix. |

Keep provider-specific tool loading, semantic search dependencies, and compaction redesign outside this fix. The existing provider-neutral search/describe/call workflow can address #469 with enforced bounds and smaller discovery output.
