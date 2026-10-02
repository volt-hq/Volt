---
description: Write the changeset fragment for this session's change
---
Write the changeset fragment for the change you made in this session (if you
made no change here, describe the currently staged or branch diff instead).
You have the full context of what changed and why — use it; the fragment
should describe intent and observable behavior, not the diff.

1. Decide the kind: `feature` (new user-visible capability), `improvement`
   (better existing behavior), `fix` (bug fix), `breaking` (requires user
   action — migration guidance is mandatory), or `internal` (no user-visible
   behavior change; never rendered in release notes).
2. Pick an area slug if one fits: `daemon`, `remote`, `tui`, `lsp`,
   `subagents`, `mcp`, `compaction`, `providers`, `store`, ...
3. Write ONE sentence for a Volt user, past tense, describing observable
   behavior — never file names, functions, or implementation details. Follow
   `.changeset/README.md`. Include attribution links if the work closes an
   issue or lands an external PR.
4. Create the fragment:
   ```bash
   npm run changeset:add -- <kind> [area] "Sentence." [--details "..."] [--package <name>]
   ```
   Pass `--package` once per touched package (default is
   `@hansjm10/volt-coding-agent`); `breaking` requires `--details` with the
   migration steps.
5. Show the written fragment and run `npm run changelog:preview` so the user
   can confirm the rendered entry. Adjust wording if they push back.
