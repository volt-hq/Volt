# Bounded MCP discovery output

Investigation and implementation design for [issue #469](https://github.com/volt-hq/Volt/issues/469), based on `189b5e8c7` on 2026-09-24. The findings below describe the original behavior. The worktree now implements compact discovery, a common final-output formatter, and provider-neutral discovery and structured-output optimizations.

The implementation uses schema-free, complete-record `list_tools` pages with an enforced final output budget and cache retrieval for an oversized record. Full schemas remain available through `describe` or the top search match's optional cached `selectedTool`. The hard budget applies to the final text sent to the model, including truncation notices and cache references; a smaller discovery budget reduces ordinary response sizes.

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

Initial bounded-output validation on 2026-09-24, before the discovery optimizations below:

- The issue regression, `test/mcp.test.ts`, and `test/sdk-disable-mcp.test.ts` passed: 48 tests passed, with one POSIX permission test skipped on Windows. The regression contributes 22 tests.
- Root TypeScript checking passed. RPC contract and shrinkwrap verification passed; release-security verification passed all 53 tests.
- `npm run check` stopped at eight Bash launcher failures in unchanged `scripts/source-launchers.test.mjs`. Its preceding formatting, pinned-dependency, changeset, source-import, and source-export checks passed. The full check did not complete.
- Separate agent-package TypeScript and browser-smoke checks could not resolve the AI package's unbuilt workspace outputs in this clean worktree. No build, dependency change, or launcher fix was made.
- Read-only source inspection of volt-app's MCP RPC models, transcript projector, and tool-event presentation found no required adaptation: management metadata remains complete, and the projector uses the retained risk, status, truncation, and cache fields. The Swift app was not built or tested.

The follow-up implementation keeps one provider-neutral gateway and adds:

| Area | Implemented behavior | Constraint |
| --- | --- | --- |
| Search relevance | Tokenize Unicode and camelCase/acronym names, ignore ordinary query filler, and prioritize query coverage before field weights. An optional `server` scopes candidates. | Deterministic lexical ranking; no embeddings, network search, or new dependencies. |
| Search coverage | Report searched, missing, and stale servers. Read a schema-free metadata projection for discovery. | Freshness, enabled state, filters, and trust still determine eligible metadata. |
| Search CPU cost | Prepare text features once per server/catalog identity in a session-owned index, capped at 64 catalogs. Materialize summaries and call snippets only for selected matches. | Apply live filters and trusted-read settings on each query; invalidate changed or unavailable catalogs without evicting unrelated catalogs for a scoped query. |
| Fewer discovery calls | `search` with `includeSchema: true` can return the best match's complete cached input/output schemas in `selectedTool`. | Search remains discovery-only: it never connects, refreshes, or delegates to live `describe`. Include only when available and the complete result fits; otherwise return `schemaOmitted` and use `describe` separately. |
| Listing pages | `list_tools` returns complete summaries sorted by name, 20 per page by default and at most 100. `nextCursor` binds the server, metadata hash, and next position. | Reject changed-catalog cursors. An oversized individual entry is explicitly identified and retained in the cache when possible. |
| Discovery budget | `search` and `list_tools` enforce 8192 bytes by default, with a per-call `maxBytes` minimum of 512 and maximum of the configured hard cap. | The budget includes omission messages and oversized-entry retrieval metadata. If minimum metadata cannot fit, return a bounded error with guidance to increase `maxBytes`. |
| Duplicate output | Omit a text block only when its exact JSON spelling, excluding insignificant whitespace outside strings, matches the compact `structuredContent` serialization. | Preserve key order, numeric literal differences, duplicate keys, distinct prose, errors, and nontext content markers. Parsed semantic equality is insufficient because it can lose large integer precision or duplicate keys. |
| Targeted retrieval | Store complete `structuredContent` alongside the rendered text under one cache id. `read_cache` with `pointer` selects a value; arrays support `offset`/`limit` and whole-row continuation. | Every selection includes its final envelope in the hard cap. Oversized selections return `selectionRequired`, not partial records. Text replay remains available. |

Representative gateway requests:

```json
{ "action": "search", "server": "github", "query": "search issues", "includeSchema": true, "maxBytes": 8192 }
{ "action": "list_tools", "server": "github", "limit": 20, "cursor": "<nextCursor>" }
{ "action": "read_cache", "cacheId": "<cache.id>", "pointer": "/rows", "offset": 0, "limit": 20 }
```

Structured reads use JSON Pointer escaping (`~0` for `~`, `~1` for `/`), distinguish a missing path from JSON `null`, and disallow traversal through inherited properties or non-JSON array indexes. Arrays default to 20 rows and cap at 100; `nextOffset` advances only by complete rows delivered. When a selected object, scalar, or first row exceeds the byte cap, `selectionRequired: true` preserves the original cache reference and requests a narrower pointer. No arbitrary expression engine runs against tool output.

The cache retains rendered text and structured JSON in one session/workspace-owned record, including when the rendered text fits inline. The combined serialized record is subject to existing capacity and expiration limits. Refused storage reports `cacheUnavailable: true`; it must not silently create a text-only cache that implies structured retrieval succeeded. Raw `read_cache` without `pointer` reconstructs the retained text, and neither raw nor structured reads create additional cache entries. Protocol failure status remains separate from output presentation and survives truncation.

Expanded validation on 2026-09-24:

- The four issue regressions, `test/mcp.test.ts`, and `test/sdk-disable-mcp.test.ts` passed together: 93 passed, one POSIX permission test skipped on Windows. The suite harness/faux provider verifies actual model-visible discovery and structured selection without real provider calls.
- Root TypeScript checking using the repository's configured native compiler passed. RPC contract and shrinkwrap verification passed; release-security verification passed all 53 tests. `git diff --check` passed.
- `npm run check` passed formatting, pinned dependencies, changesets, source imports, and source exports, then stopped at the same eight unchanged Bash launcher failures documented above. The full check did not complete. No launcher fixes, build, dependency changes, or full test suite were run for this follow-up.

The repeatable benchmark lives in `packages/coding-agent/benchmarks/mcp-discovery.ts` with deterministic catalog fixtures and seven regression tests for its measurements. Run from the repository root:

```sh
node --experimental-strip-types --conditions volt-source packages/coding-agent/benchmarks/mcp-discovery.ts --sizes 50,500,5000 --budgets 4096,8192,16384 --repetitions 5
```

The measured run used Node v24.20.0 on Windows, 16 hand-labeled diagnostic queries, and fake paginated MCP connections. Warm results for the 5,000-tool catalog:

| Discovery path | Budget | Final response bytes across all calls | Calls |
| --- | ---: | ---: | ---: |
| Search, then describe | 4 KiB | 4,534 | 2 |
| Search with optional schema (schema did not fit) | 4 KiB | 4,616 | 2 |
| Search, then describe | 8 KiB | 5,017 | 2 |
| Search with schema included | 8 KiB | 4,998 | 1 |
| Enumerate all tools, then describe | 4 KiB | 770,423 | 193 |
| Enumerate all tools, then describe | 8 KiB | 747,852 | 95 |
| Enumerate all tools, then describe | 16 KiB | 737,948 | 52 |

Enumeration requests up to 100 tools per page to exercise byte limits, rather than the product default of 20. Cold and stale 8 KiB schema-discovery flows each used 6,868 response bytes and five calls, including the initial search notice and three explicit server connections. These are alternative discovery workflows, not a before/after claim about model task performance.

On this diagnostic corpus, macro recall@5 improved from 86.7% with the frozen original substring scorer to 100%; the increase comes from explicit identifier and Unicode cases. Median time for all 16 queries at 5,000 tools was 24.57 ms for the original scorer, 163.33 ms for the new uncached scorer, and 9.50 ms with prepared features. Building the index and running its first query took 16.41 ms. The full warm manager path, including projection cloning and configuration/freshness checks, took 100.35 ms for all 16 queries. Full metadata cloning took 15.98 ms versus 5.39 ms for the discovery projection; serialized representations were 3,667,913 and 926,956 bytes respectively. Timings are local samples, not test thresholds.

The benchmark reports cumulative response bytes and a labeled `ceil(bytes / 4)` token heuristic. It does not measure billed tokens, repeated request context, model reasoning, argument correctness, real network latency, or successful task completion. Its scripted workflows stop after obtaining the selected tool's schema. The measured budget tradeoff supports retaining the 8 KiB default for this fixture; real catalogs and model-backed trials are needed before treating it as generally optimal.

Remaining exploration should repeat these measurements with representative recorded catalogs and model-backed search/select/call tasks, including unsuccessful queries and stale catalogs. A hard cap limits one response, not the sum of every cache page read into a conversation. Cache retrieval still parses and buffers the entire persisted record per read; optimize disk ranges only if profiling justifies the storage change. Metadata collection page/byte ceilings and repeated-cursor detection remain separate transport work.

Provider-native tool search/deferred loading is a future comparison only. This implementation deliberately uses the existing provider-neutral gateway; it adds no provider capability gating, native tool-loading branch, semantic-search dependency, or compaction redesign.

A follow-up experiment should compare this gateway baseline with [OpenAI client-executed `tool_search`](https://developers.openai.com/api/docs/guides/tools-tool-search) and [Claude custom tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool). Use the same catalogs and task fixtures, holding the model and generation settings constant within each provider comparison. Run cold and warm discovery/cache cases, and record task success, tool-argument accuracy, total billed input including cached tokens, discovery turns, and end-to-end latency. Report cached input separately so fewer visible schema bytes are not mistaken for lower billing. The synthetic local benchmark can measure retrieval and serialization behavior but cannot establish model inference accuracy or provider cache billing. This phase includes no native integration or paid model calls.
