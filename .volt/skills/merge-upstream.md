---
name: merge-upstream
description: Workflow for merging upstream Pi (earendil-works/pi-mono) changes into the Volt fork. Covers fetching, conflict resolution under the pi-to-volt package rename, the rename sweep script, verification, and committing.
---

# Merging Upstream Pi into Volt

Volt is a fork of Pi (`earendil-works/pi-mono`) with packages renamed from
`@earendil-works/pi-*` to `@hansjm10/volt-*`. Most merge conflicts come
from that rename colliding with upstream changes to import lines. Merge often;
small merges stay trivial.

## 1. Fetch and Inspect

```bash
git remote get-url upstream   # https://github.com/earendil-works/pi-mono.git (add if missing)
git fetch upstream --prune
git log --oneline main..upstream/main          # incoming commits
git diff --stat main...upstream/main           # affected files
git status --short                             # working tree must be clean
```

Enable `git rerere` if not already on (`git config rerere.enabled true`); it
replays previously resolved conflicts automatically (staged for you; still
review them).

## 2. Merge

```bash
git merge upstream/main --no-commit
```

List upstream fixes in the eventual commit message (one line per incoming
commit subject).

## 3. Resolve Conflicts

Almost all conflicts are the package rename on import lines. Resolution rule:

- Keep Volt package names (`@hansjm10/volt-ai`, `volt-agent-core`,
  `volt-tui`, `volt-coding-agent`).
- Adopt upstream's logic and any new imports it added.

If a conflict involves real logic (not just imports), read the full file and
both sides before resolving. If unsure whether Volt intentionally diverged,
ask the user.

## 4. Rename Sweep

New upstream files arrive with Pi package names. Run:

```bash
node scripts/rename-upstream.mjs
```

This rewrites `@earendil-works/pi-*` to `@hansjm10/volt-*` in tracked
source files. It deliberately skips CHANGELOGs (upstream issue/PR links must
keep pointing at `pi-mono`) and lockfiles.

Then manually review new upstream files for cosmetic Pi references the script
does not touch, e.g. tmpdir prefixes (`"pi-1234-"` should be `"volt-1234-"`),
`pi` binary names in strings, or Pi-specific doc wording:

```bash
git diff HEAD --name-only --diff-filter=A | xargs grep -ln '"pi\b\|pi-[0-9]' 2>/dev/null
```

## 5. Verify

```bash
npm run check
```

Fix everything it reports. Then run only the tests the merge touched
(`git diff --stat HEAD` shows them), per package:

```bash
cd packages/<pkg> && node ../../node_modules/vitest/dist/cli.js --run test/<file>.test.ts
```

Caveats:

- `packages/tui` uses Node's test runner: `node --test test/<file>.test.ts`.
- `packages/agent` tests resolve `@hansjm10/volt-ai` through the package
  exports (`dist/`). If unbuilt, build that one dependency:
  `cd packages/ai && npm run build`. The build regenerates
  `models.generated.ts` / `image-models.generated.ts` as a side effect; restore
  them afterwards with `git checkout -- packages/ai/src/*.generated.ts` unless
  the merge intentionally changed them.
- Never run the full vitest suite directly; use `./test.sh` from the repo root
  if a broad run is needed.

## 6. Commit and Push

Stage only conflict resolutions and rename-sweep edits (merged files are
already staged), then commit:

```bash
git add <resolved/renamed paths>
git commit -m "Merge upstream pi-mono into Volt

Brings in N upstream fixes:
- <upstream commit subjects>

Conflict resolutions keep Volt package names while adopting upstream logic."
```

Ask the user before pushing.
