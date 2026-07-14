---
description: Editorial pass over pending changesets before release
---
Review the pending changeset fragments and curate the release highlights. CI
already guarantees coverage (PRs that change product source must include a
fragment), so this pass is about editorial quality, not completeness.

## Process

1. **Render the pending section:**
   ```bash
   npm run changelog:preview
   ```
   List the fragments behind it: `.changeset/*.md` (ignore `README.md`).

2. **Review fragment quality** (format reference: `.changeset/README.md`):
   - Each first line is `kind(area): One user-facing sentence.` describing
     observable behavior, not implementation.
   - Kinds are honest: `feature` only for genuinely new capability, `internal`
     only for changes with no user-visible behavior.
   - `breaking` fragments use a `minor` bump and include real migration
     guidance in the body.
   - Near-duplicate fragments for related changes are merged into one.
   - External contributions carry attribution: `([#N](url) by [@user](url))`.

3. **Curate the highlights:**
   - Review the `### Highlights` section of the preview (all `feature`
     fragments).
   - Propose to the user which features deserve highlight billing, adding doc
     links to their sentences whenever possible; demote the rest to
     `improvement`.

4. **Report and fix:**
   - List fragments that need rewording, re-kinding, or merging, then apply
     the fixes after confirming with the user.
