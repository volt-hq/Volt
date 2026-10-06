# UI Nodes

`UiNode` is Volt's UI as data: a JSON tree that extensions, built-in tools, and the host produce, and every client renders with its own components. Extension status items, panels, dialogs and forms, tool-call and custom-message presentations, and work detail are all `UiNode` data or [styled text](#styled-text). The TUI, RPC clients, the paired phone app, and the HTML export render the same data, and no client runs extension or tool code.

The schemas live in `@hansjm10/volt-protocol` (`UiNodeSchema`, `UiPatchOpSchema`, `ToolPresentationSchema`, `MessagePresentationSchema`, and their types), and in the contract artifact `@hansjm10/volt-protocol/contract/protocol-schema.json`. For the APIs that produce UI data, see [UI as Data](extensions.md#ui-as-data); for how clients receive it, see [RPC mode](rpc.md#extension-ui).

## Table of Contents

- [Styled Text](#styled-text)
- [Keys and Ids](#keys-and-ids)
- [Node Types](#node-types)
- [Forms](#forms)
- [Actions](#actions)
- [Presentations](#presentations)
- [Patches](#patches)
- [Size Limits](#size-limits)
- [ANSI and Control Characters](#ansi-and-control-characters)
- [Rendering](#rendering)

## Styled Text

Styled text (`UiNodeStyledText`) is a string, or an array of spans:

```json
[{ "text": "3 failed", "token": "error", "bold": true }, { "text": " of 120", "token": "muted" }]
```

A span has `text` and optional `token`, `bold`, `italic`, `underline`, and `code`. Text holds no control characters other than tab and line feed. Output lines (terminal and diff lines) are one line each, at most 4,096 characters.

Styling is semantic only. A token names a role, and each client maps it to its own theme:

| Token | Meaning | TUI theme color |
|---|---|---|
| `text` | Ordinary text (the default) | `text` |
| `muted` | Secondary text | `muted` |
| `accent` | Highlighted names and values | `accent` |
| `success` | Success | `success` |
| `warning` | Warnings | `warning` |
| `error` | Errors | `error` |
| `info` | Information | `accent` |

`bold`, `italic`, and `underline` are emphasis; `code` marks inline code (the TUI's `mdCode` color). See [Themes](themes.md) for the TUI's colors.

## Keys and Ids

Every node, and every repeated item (table rows, key-value items, progress steps, and card sections), takes an optional `key` of 1 to 256 characters. Keys are unique among siblings. [Patches](#patches) address nodes by key, and clients keep component state (form input, tree expansion, terminal rows) across updates by key, so give nodes that change stable keys.

Action ids, form field ids, and tree item ids are 1 to 160 characters without whitespace or control characters. They are unique within their node; tree item ids are unique within the whole tree.

## Node Types

There are 14 node types. Every node has `type` and an optional `key`; fields marked `?` are optional, and "styled" means [styled text](#styled-text).

| Type | Fields | Shows |
|---|---|---|
| `text` | `text` (styled), `token?` | Wrapped text; `token` styles the spans that name none. |
| `markdown` | `markdown` | Markdown. |
| `list` | `items` (nodes), `ordered?` | Nodes as bullet or numbered items. |
| `table` | `columns` (1 or more `{ header (styled), align?: "left" \| "right" }`), `rows` (`{ key?, cells (styled[]) }`), `emptyText?` (styled) | A table; `emptyText` when it has no rows. |
| `keyValue` | `items` (`{ key?, label (styled), value (styled) }`) | Labelled values, one per line. |
| `progress` | `kind: "determinate"`, `value` (≥ 0), `max?` (> 0, default 1), `label?` (styled), `token?` | A progress bar. |
| `progress` | `kind: "steps"`, `title?` (styled), `steps` (`{ key?, label (styled), status, detail? (styled), startedAt?, endedAt? }`) | A list of steps. `status` is `pending`, `active`, `done`, `failed`, or `skipped`; `startedAt` and `endedAt` (epoch milliseconds) let clients show how long a step ran, or runs so far. |
| `form` | `title?` (styled), `fields` (1 or more), `submit` (intent), `submitLabel?`, `cancel?` (intent), `cancelLabel?` | A form; see [Forms](#forms). |
| `actions` | `actions` (1 or more) | A row of buttons; see [Actions](#actions). |
| `card` | `title` (styled), `token?`, `badges?` (`{ label, token? }`), `sections?` (`{ key?, title? (styled), children (nodes) }`), `actions?` | A titled card whose sections hold child nodes. |
| `diff` | `path?`, `lines` (`{ kind, text (line), oldLine?, newLine? }`), `lineNumbers?` | A diff. `kind` is `context`, `add`, `remove`, `hunk`, or `meta`. |
| `terminal` | `title?` (styled), `lines` (at most 2,000 plain or styled lines), `omittedLines?` | Command output: the newest lines, with older ones counted in `omittedLines`. |
| `code` | `title?` (styled), `language?` (1 to 64 of `A-Z a-z 0-9 _ + # . -`), `code` | Code, highlighted by language. |
| `image` | `mimeType` (`image/png`, `image/jpeg`, `image/gif`, or `image/webp`), `data` (base64, at most 1 MiB of characters), `alt?` | An image. |
| `tree` | `items` (`{ id, label (styled), description? (styled), children? }`), `expanded?` (item ids) | A tree; `expanded` lists the items shown open. |

`list` items and `card` section children are nodes, so trees nest. They nest at most 32 levels, counted as patch paths count them: a root node is level 1, and a list's items, a card's sections, and a section's children are one level below their parent.

A card with a table and an action:

```json
{
  "type": "card",
  "key": "ci",
  "title": "CI for main",
  "badges": [{ "label": "passing", "token": "success" }],
  "sections": [
    {
      "key": "jobs",
      "children": [
        {
          "type": "table",
          "key": "jobs",
          "columns": [{ "header": "Job" }, { "header": "Status" }],
          "rows": [{ "key": "build", "cells": ["build", [{ "text": "ok", "token": "success" }]] }]
        }
      ]
    }
  ],
  "actions": [{ "id": "rerun", "label": "Rerun", "intent": { "type": "extension.intent.ci.rerun" } }]
}
```

## Forms

A form field has a `kind`, an `id`, a `label`, an optional `description` (styled), and an optional initial `value`:

| `kind` | Fields | Value |
|---|---|---|
| `string` | `placeholder?`, `required?`, `minLength?`, `maxLength?`, `pattern?`, `multiline?` | a string; `pattern` must match the whole value |
| `boolean` | | `true` or `false` |
| `enum` | `options` (1 or more `{ value, label?, description? }`), `required?` | one option's `value` |
| `integer` | `min?`, `max?`, `required?` | an integer |

Submitting a `form` node sends its `submit` intent with the field values merged over the intent's `input`, keyed by field id; cancelling sends `cancel`, when it has one. Fields left empty are absent from the values. The same fields make up the `form` host request that `ctx.ui.form()` asks, which a client answers with `{ values }`.

Every client validates values against the fields before it sends them, and the host checks them again as the intent's input. A `pattern` must be safe to test: no backreferences, lookarounds, repeated groups that repeat or alternate, or repeats that can trade characters (such as `a*a*`), at most three repeats, and at most four quantifiers, optionals, and alternatives in all. Patterns are tested against values of at most 256 characters. A form with a pattern that is not safe is refused.

## Actions

An action is a button that sends an intent:

```json
{ "id": "rerun", "label": "Rerun", "token": "accent", "destructive": false, "disabled": false, "intent": { "type": "extension.intent.ci.rerun", "input": { "branch": "main" } } }
```

`actions` nodes, card `actions`, presentation `actions`, and forms send intents. The host checks the intent's input against the intent's schema, as it does for any client's intent.

What extension UI may send is restricted. An extension's panels, dialog bodies, presentations, and work detail may bind only:

- its own commands: `extension.command.<id>.<command>`;
- its own intents: `extension.intent.<id>.<name>`;
- `open_work` and `cancel_work` whose `input.workId` is work the extension's own kinds run.

`<id>` is the extension's manifest id. The host removes every other action, and every form whose `submit` it may not send (a `cancel` it may not send is removed from the form), before any client sees the data; a node left empty is removed. Host code (built-in tools, and the detail of the host's own work kinds) may bind any intent.

## Presentations

A tool call's presentation (`ToolPresentation`) is what its tool's `present()` returns for the call's arguments, state, and result:

| Field | Meaning |
|---|---|
| `title` | One line of styled text naming the call. |
| `activity?` | Styled text saying what the call does while it runs. |
| `summary?` | Nodes shown while the call is collapsed. |
| `body?` | Nodes shown while it is expanded; clients show `summary` when there is none. |
| `actions?` | Actions shown with the call. |
| `hidden?` | Clients do not show the call. |
| `showsDuration?` | Clients show the call's elapsed time. |

A custom message's presentation (`MessagePresentation`) is `{ title?, summary?, body }`, which its type's message presenter returns.

Clients draw the chrome around a presentation: the call's state, its elapsed time, collapsing between `summary` and `body`, the result's images, and the work the call started. A call without a presenter of its own has a generic presentation: the tool's name, its arguments as JSON, and its output. A message without one shows its text.

Running tool calls reach clients on the live lane as `tool` items carrying `presentation` or a `patch` of it, and calls and messages in the log carry theirs in the entry's transcript `view` (`view.presentation`). See [Tool Presentation](extensions.md#tool-presentation) and [Message Presentation](extensions.md#message-presentation).

## Patches

A tree that changes reaches clients as a patch against the tree they hold, so streaming output appends lines instead of resending a whole card. A patch is a list of operations, applied in order to a tree (a list of root nodes):

| Operation | Effect |
|---|---|
| `{ op: "replace", path, node }` | Replaces the node at `path`; at the roots (`[]`), the tree becomes that one node. |
| `{ op: "remove", path }` | Removes the node at `path`; at the roots, the tree becomes empty. |
| `{ op: "insert", path, before?, node }` | Inserts `node` into the roots, a `list`, or a card section at `path`: before its child keyed `before`, or last. |
| `{ op: "append_lines", path, lines, omittedLines? }` | Appends lines to the `terminal` node at `path`. `omittedLines`, when present, is the node's new `omittedLines`, and the oldest lines it newly counts are dropped from the front. |

A path is a chain of keys from the roots, at most 32: each key selects the one child with that key, where a node's children are a list's items, a card's sections, and a section's children. The empty path names the roots.

```json
[
  { "op": "append_lines", "path": ["build", "out", "log"], "lines": ["test 41 passed", "test 42 passed"] },
  { "op": "replace", "path": ["build", "out", "status"], "node": { "type": "text", "key": "status", "text": "Done", "token": "success" } }
]
```

Patches appear as:

- live `patch{key, ops}` items for an extension panel (`ext_panel/<id>/<name>`, whose `node` is a one-node tree) and a work item's detail (`work/<workId>`, whose `detail` is a tree of at most one node);
- the `patch` of a live `tool` item: `{ summary?, body? }`, each a patch of that tree of the call's presentation (an absent tree is the empty tree).

The host computes patches with `diffUiTree(prev, next)`, which matches children by key and turns a terminal node that only gained lines into `append_lines`; where children are unkeyed or a patch would be no smaller, it replaces the nearest keyed ancestor or the whole tree. Clients apply them with `applyUiPatch(tree, ops)`; both are exported by `@hansjm10/volt-protocol`. A patch that does not apply (a key names no child, or the node cannot take the operation) means the client's state diverged: it resubscribes after its position.

## Size Limits

Sizes are UTF-8 bytes of the JSON.

| What | Bound |
|---|---|
| Extension panel node | 32 KB; at most 16 panels per extension |
| Status item text | 1 KB; at most 32 status items per extension |
| Notification | 16 KB |
| Dialog | a body of at most 32 KB; 1 to 8 actions; a one-line title |
| Window title | 256 characters, one line |
| Tool or message presentation | 64 KB for local clients, 16 KB for paired devices |
| Extension work detail | 7 KB; a live work value holds at most 8 KB |
| Terminal node | 2,000 lines |
| Terminal or diff line | 4,096 characters |
| Image data | 1 MiB of base64 characters |
| Key | 256 characters |
| Action, field, or tree item id | 160 characters |
| Patch path | 32 keys; nodes nest at most 32 levels |

Panels, status items, notifications, dialogs, and work detail that are invalid or over their bound are refused: the extension call throws (a work detail that fails shows the item's progress only). A presentation over its bound first loses the oldest lines of its terminal nodes and the ends of its code and diff nodes; one that still does not fit, or is invalid, is replaced by the generic presentation (for a paired device, the tool's name only). A live work value over its bound drops its detail, then its steps.

## ANSI and Control Characters

`UiNode` data never carries ANSI or other terminal control sequences. The host normalizes everything extensions and tools produce before any client sees it:

- **Styled-text fields** (a `text` node's text, titles, table headers and cells, key-value items, progress labels and steps, tree items, field descriptions, and terminal lines): ANSI SGR styling becomes tokens and emphasis.

  | SGR | Becomes |
  |---|---|
  | 31, 91 (red) | `error` |
  | 32, 92 (green) | `success` |
  | 33, 93 (yellow) | `warning` |
  | 34, 94, 36, 96 (blue, cyan) | `info` |
  | 35, 95 (magenta) | `accent` |
  | 90 (bright black), 2 (dim) | `muted` |
  | 1, 3, 4 | `bold`, `italic`, `underline` |

  Every other attribute (black and white, 256-color and RGB colors, backgrounds) is dropped.
- **Other text** (markdown, code, action and field labels, badges, diff lines and paths): control sequences are removed without styling.
- **Everywhere**: every other escape sequence (cursor movement, OSC, DCS, and the like), C0 and C1 control characters other than tab and line feed (carriage returns included), and bidirectional embedding, override, and isolate characters are removed.
- **Terminal output** is split into lines at line feeds; a node keeps its newest 2,000 lines and counts the rest in `omittedLines`, and terminal and diff lines are cut to 4,096 characters, ending in `…`.

## Rendering

Each client renders the data with its own components:

- **TUI.** Every node type renders as a terminal component in both screen modes, with tokens in the active theme's colors. Code is syntax-highlighted by `language`; images render as terminal images where the terminal supports them, else as a one-line description; steps with times show their durations. Forms, action rows, cards, and trees take keyboard input once focused, and Tab moves through a card's interactive children. A `terminal` node shows its newest 12 lines, except in a tool card, which shows them all. Status items show in the footer; panels above or below the editor, or in fullscreen mode's sidebar (above the editor in regular mode), at most 12 rows each; dialogs and forms in place of the editor; tool calls as cards that Ctrl+O (`app.tools.expand`) expands from `summary` to `body`.
- **RPC and SDK clients** receive the data in protocol frames and apply patches with `applyUiPatch`; the live fold (`foldLiveFrame` in `@hansjm10/volt-protocol`) applies the live lane's items. [rpc-extension-ui.ts](../examples/rpc-extension-ui.ts) renders the data as plain lines.
- **Paired phones** render the same data on the remote profile: presentations within 16 KB and without image data, with host paths redacted from every frame. See [Iroh remote protocol](iroh-remote-protocol.md#the-remote-profile).
- **HTML export** (`/export`) renders tool calls and custom messages from their presentations: text escaped, tokens as CSS classes, and actions and forms as inert text.
