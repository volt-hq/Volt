# Changesets

Every user-visible change adds one fragment file here (any unique kebab-case
name ending in `.md`). Release tooling consumes all fragments into a generated
version section in `packages/coding-agent/CHANGELOG.md` — never edit that file
directly.

## Format

```md
---
"@hansjm10/volt-coding-agent": patch
---

fix(daemon): Fixed workspace unregister leaving orphaned worktree records. ([#123](https://github.com/hansjm10/Volt/issues/123))
```

The front matter lists the workspace package(s) the change touches
(`@hansjm10/volt-coding-agent` when in doubt) with a bump of `patch`, or
`minor` for breaking changes. `major` is never used.

The first line of the summary is `kind(area): One user-facing sentence.`

- `kind` is one of:
  - `feature` — new capability; rendered under **Highlights**
  - `improvement` — better existing behavior; rendered under **Improvements**
  - `fix` — bug fix; rendered under **Fixes**
  - `breaking` — requires user action; rendered under **Breaking Changes**,
    must use a `minor` bump, and must include migration guidance in the body
  - `internal` — refactors, CI, docs plumbing; never rendered in release notes
- `area` is an optional lowercase slug grouping related entries
  (`daemon`, `remote`, `tui`, `lsp`, `subagents`, `mcp`, ...).

Write the sentence for a Volt user: describe observable behavior, not
implementation. Paragraphs after the first line become indented detail under
the bullet — use them for context or migration steps, not to restate the diff.

Attribution stays inline in the sentence:

- Internal (from issues): `([#123](https://github.com/hansjm10/Volt/issues/123))`
- External contributions: `([#456](https://github.com/hansjm10/Volt/pull/456) by [@username](https://github.com/username))`

## Commands

- `npx changeset` — interactive authoring (writing the file directly is fine too)
- `npx changeset status` — list pending fragments
- `npm run changelog:preview` — render the release section the pending fragments would produce

Never run `npx changeset version` or `npx changeset publish`: they would consume
fragments and bump versions outside the guarded release flow. Release tooling
(`scripts/changelog.mjs` via `release.mjs`) owns consumption; the changesets CLI
is for authoring and status only.
