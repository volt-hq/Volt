# Code Mode

Code mode adds the `run_code` tool. Its input is a script in JavaScript or erasable TypeScript, run in a sandbox. The script calls Volt's tools as `await tools.<name>(args)`, loops, branches, filters, and aggregates. Only what the script prints or returns reaches the model, so intermediate results stay out of the conversation.

```js
const issues = await tools.mcp.github.search_issues({ query: "is:open label:bug" });
const stale = issues.structured.items.filter((issue) => issue.updated_at < "2026-06-01");
for (const issue of stale) console.log(`#${issue.number} ${issue.title}`);
return `${stale.length} of ${issues.structured.items.length} open bugs are stale`;
```

## When to Use It

Prefer code mode for batches of independent tool calls, pagination, and filtering or aggregating large results—even a single large issue or pull-request listing. After discovering MCP tools and their arguments, scripts can call their bindings and return only relevant fields, counts, and summaries. Independent calls can run concurrently with `Promise.allSettled`; inspect rejected results and await dependent calls in order.

Use direct calls for small one-off results or steps that need the model's judgment between calls. Code mode does not make ordinary coding better, and on small tasks it can cost more than direct calls. Its description and guidance add prompt overhead to every request while active.

Code mode is off by default. Direct tool calls keep working alongside it, and the model decides which to use for each step; enabling it guides that choice rather than forcing every call through a script.

## Enabling Code Mode

Set `codeMode.enabled` in `~/.volt/agent/settings.json`, a settings profile, or a trusted project's `.volt/settings.json`:

```json
{
  "codeMode": { "enabled": true }
}
```

The setting adds `run_code` to a conversation's default active tools when the conversation's tools are created, so it applies to conversations started afterwards. Otherwise `run_code` is an ordinary tool name:

- `--tools read,bash,run_code` activates it for one run. `--tools` replaces the default set, so list every tool you want.
- `--exclude-tools run_code` and `--no-tools` remove it, whatever the setting says.
- SDK callers pass `run_code` in `tools` (see [SDK](sdk.md)).
- Conversations a paired phone opens do not get `run_code` under the default remote tool grant. A custom [`remote.allowTools`](settings.md#remote-access-daemon) list must include it. Phones can neither see nor change `codeMode.enabled`. A conversation a terminal opened keeps its tools, `run_code` included, for phone prompts.
- Subagents inherit `run_code` with the parent's active tools unless their own tool policy leaves it out.
- In Plan mode, `run_code` stays active only when Build mode would activate it and its scripts would be able to call at least one read-only tool. Scripts can then call only what the research profile allows: workspace and network reads, read-only `lsp` and `inspect` actions, and MCP tools configured as [trusted reads](mcp.md#trusted-reads-in-restricted-profiles).

## Writing Scripts

A script is the body of an async function: top-level `await` and `return` work. Erasable TypeScript annotations are stripped before the script runs; syntax that needs code generation, such as `enum` or `namespace`, fails as a syntax error. The sandbox has no file system, network, process, timers, or modules: tools are its only way out.

### Calling Tools

Each tool active in the conversation that scripts may call has a binding under `tools`, taking the same arguments as the tool itself:

| Binding | Resolves with |
|---|---|
| `tools.bash(args)` | `{ output, exitCode, truncated, fullOutputPath? }` for any exit code; a command that timed out, was aborted, or could not start rejects |
| `tools.read(args)` | The file's text, or an image reference for an image |
| `tools.image_gen(args)` | An image reference, with the file the image was saved to |
| `tools.mcp.<server>.<tool>(args)` | `{ text, structured?, images }` |
| Any other tool, such as `edit`, `write`, `grep`, `web_fetch`, `lsp`, or an extension tool | The result's text |

Scripts can call `read`, `grep`, `find`, `ls`, `web_search`, `web_fetch`, `inspect`, `lsp`, `edit`, `write`, `bash`, `image_gen`, extension tools, and MCP tools, but only those the conversation has active. They cannot call `request_user_input`, `jobs`, `subagent`, the planning tools, `run_code` itself, or the `mcp` gateway, whose MCP tools get bindings of their own. Nested calls cannot start background jobs, and a nested `bash` command that goes silent is killed instead of moving to the background.

Write shell commands with `String.raw` and `$VAR` rather than `${VAR}`, so JavaScript does not interpolate or unescape them:

```js
const result = await tools.bash({ command: String.raw`grep -rn "TODO\b" src | wc -l` });
```

### MCP Tools

MCP tools are bound at `tools.mcp.<server>.<tool>` while the `mcp` gateway or a promoted direct MCP tool is active, once the server's tool metadata is fresh. Use brackets for names that are not JavaScript identifiers: `tools.mcp["my-server"]["get-file"](args)`. The model finds MCP tools and their arguments with the `mcp` tool's `search` and `describe` actions. While `run_code` is active and can call the tool, `describe` and a schema-bearing search's `selectedTool` also say how a script calls it and when to prefer a script:

```json
"codeMode": {
  "call": "tools.mcp.github.search_issues(args)",
  "returns": "Promise<{ text: string; structured?: unknown; images: ImageRef[] }>",
  "guidance": "Prefer run_code with this binding for independent batches, pagination, or filtering large results, even a single listing. Return relevant fields or summaries, not whole results."
}
```

Search includes this with `includeSchema: true` only when the complete schemas and guidance fit its discovery budget; otherwise it directs the model to `describe`. No script hint appears for tools code mode cannot call, including untrusted MCP tools in Plan mode.

Calls from scripts run at most 4 at a time per server, across the process. A server's `maxConcurrentCalls` configuration changes that; `1` serializes calls to a server that does not handle concurrent requests well.

### Errors

A failed call rejects with a `ToolCallError` with `tool`, `kind` (`invalid_arguments`, `blocked`, `failed`, or `cancelled`), an optional `reason`, and `message`. Scripts can catch it; `Promise.allSettled` keeps the results of independent calls when one fails:

```js
const results = await Promise.allSettled(paths.map((path) => tools.read({ path })));
const missing = results.filter((result) => result.status === "rejected").length;
```

### Output

`text(value)`, `console.log/info/debug/warn/error(...)`, `image(ref)`, and the return value appear in the result in the order the script produced them. Only images passed to `image(ref)` reach the model, at most 10 per script; the result lists images the script received but did not show. Output is limited to 50 KB and 2,000 lines; when it is longer, the result keeps its start and end, and the full output is saved to a file the model can read.

### Keeping Values Across Scripts

Each script runs in a fresh sandbox, but scripts in a conversation can keep small JSON values with two synchronous globals:

- `store(key, value)` keeps `value` under `key`; `store(key, undefined)` deletes the key.
- `load(key)` returns a copy of the value, or `undefined`.

```js
const done = new Set(load("processed") ?? []);
for (const id of ids.filter((id) => !done.has(id))) {
	await tools.edit({ path: `issues/${id}.md`, edits: [{ oldText: "status: open", newText: "status: triaged" }] });
	done.add(id);
	store("processed", [...done]);
}
```

A key is a string of 1 to 256 characters. A value is at most 256 KiB as JSON, and all values together at most 1 MiB. Values follow the conversation's branches: a branch or fork sees the values written on its own path, and the values survive reopening the conversation. Writes made before a script fails are kept, so a script that records its progress can resume. A result whose script wrote values ends with `Stored keys: ...`. Each conversation has its own values, a subagent's included.

## Limits

| Limit | Value |
|---|---|
| Computation per script (time spent waiting on tools does not count) | 30 s |
| Tool calls per script | 200 |
| Memory per script | 64 MiB |
| Tool calls a script runs at once | 10 |
| MCP calls at once per server, across scripts | 4, or the server's `maxConcurrentCalls` |
| Wall-clock limit | None by default; a call may set `timeoutMs`, up to 30 minutes |
| Images a script shows | 10 |
| Stored values | 256 KiB each, 1 MiB in all |
| Output the model reads | 50 KB and 2,000 lines |

A script that exhausts its computation or tool-call budget, times out, or is aborted ends with a failed result that keeps its output so far. Running out of memory raises an error the script can catch.

## Safety

- **Sandbox.** Scripts run in QuickJS compiled to WebAssembly, on worker threads, with a fresh VM for every script. The tool bindings are their only capability.
- **No escalation.** A script can call only the tools the model could call directly in the same conversation at that moment, under the same tool policy, Plan mode included.
- **Every call is checked.** Each nested call passes the same argument validation, tool-call policy, and extension `tool_call` and `tool_result` hooks as a direct call. Hooks see it with the origin `{ kind: "code_mode", parentToolCallId, seq }` and the call ID `<parentToolCallId>:cm:<seq>` (see [Extensions](extensions.md)).
- **Side effects stay.** Calls that completed before a script failed are not undone. A failed result says how many nested calls completed and lists the ones that may have changed state, so the model can check before running the script again.

## What Is Recorded

- **The card.** Clients show a `run_code` call as a card with the script, its newest tool calls, and its newest output, updated live while the script runs. Paired phones show the same card.
- **The session.** The session stores the `run_code` call with its script and result. The result's `details` record each nested call (tool, argument preview, file path for `read`, `write`, and `edit`, status, and duration) but not nested results. [Compaction](compaction.md) and branch summaries count the files that nested `read`, `write`, and `edit` calls touched.
- **Stored values.** Each script that wrote values appends one `custom` session entry of type `volt-run-code-store` (see [Session Format](session-format.md)).
- **MCP audit.** Nested MCP calls write [MCP audit](mcp.md#audit) entries like the model's own calls, with `parentToolCallId` naming the `run_code` call.

Code mode adds no telemetry. For the design and its rationale, see the [code mode design](https://github.com/volt-hq/Volt/blob/main/packages/coding-agent/docs/code-mode-design.md).
