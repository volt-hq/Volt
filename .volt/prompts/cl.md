---
description: Audit changeset coverage before release
---
Audit changeset fragments for all commits since the last release.

## Process

1. **Find the last release tag:**
   ```bash
   git tag --sort=-version:refname | head -1
   ```

2. **List all commits since that tag:**
   ```bash
   git log <tag>..HEAD --oneline
   ```

3. **Read the pending fragments:**
   - List `.changeset/*.md` (ignore `README.md`).
   - Preview the generated section with `npm run changelog:preview`.

4. **For each commit, check:**
   - Skip: changeset/doc-only changes, release housekeeping
   - Skip: changes to generated model catalogs (for example `packages/ai/src/models.generated.ts`) unless accompanied by an intentional product-facing change in non-generated source/docs.
   - Purely internal changes (refactors, CI, test-only) need either no fragment or an `internal:` fragment; do not force user-facing wording onto them.
   - Otherwise verify a fragment covers the commit's user-visible behavior (use `git show <hash> --stat` to scope it).
   - For external contributions (PRs), verify attribution format: `([#N](url) by [@user](url))`

5. **Check fragment quality** (format reference: `.changeset/README.md`):
   - First line is `kind(area): One user-facing sentence.` with kind in `feature`, `improvement`, `fix`, `breaking`, `internal`.
   - The sentence describes observable behavior, not implementation.
   - `breaking` fragments use a `minor` bump and include migration guidance in the body.
   - Related commits share one fragment instead of near-duplicate fragments.

6. **Curate the highlights:**
   - Run `npm run changelog:preview` and review the `### Highlights` section (all `feature` fragments).
   - Propose to the user which features deserve highlight billing, with doc links in their sentences whenever possible; demote the rest to `improvement`.

7. **Report:**
   - List commits with missing fragments
   - List fragments that need rewording, re-kinding, or merging
   - Add or fix fragments directly after confirming with the user
