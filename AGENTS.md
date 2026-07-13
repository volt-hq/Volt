# Development Rules

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text (e.g., "Thanks @user" not "Thanks so much @user!")
- Technical prose only, be direct
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check node_modules for external API types; don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Use only erasable TypeScript syntax (Node strip-only mode) in code checked by the root config (`packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs needing JS emit. Use explicit fields with constructor assignments.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- Never hardcode key checks (e.g. `matchesKey(keyData, "ctrl+x")`). Add defaults to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS` so they stay configurable.
- Never modify `packages/ai/src/models.generated.ts` directly; update `packages/ai/scripts/generate-models.ts` instead, then regenerate. Including the resulting `models.generated.ts` diff is always OK, even if regeneration includes unrelated upstream model metadata changes.

## Commands

- After code changes (not docs): `npm run check` (full output, no tail). Fix all errors, warnings, and infos before committing. Does not run tests.
- Never run `npm run build` or `npm test` unless requested by the user.
- Never run the full vitest suite directly: it includes e2e tests that activate when endpoint/auth env vars are present. For all non-e2e tests, run `./test.sh` from the repo root. Otherwise run specific tests from the package root: `node ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts`.
- If you create or modify a test file, run it and iterate on test or implementation until it passes.
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` + the faux provider. No real provider APIs, keys, or paid tokens.
- Put issue-specific regressions under `packages/coding-agent/test/suite/regressions/` named `<issue-number>-<short-slug>.test.ts`.
- For ad-hoc scripts, `write` them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands.
- You may commit your own completed work without asking when a commit is a useful checkpoint or natural outcome of the task. Do not commit unrelated work or unfinished changes unless the user asks.

## Dependency and Install Security

- Treat npm dep and lockfile changes as reviewed code. Direct external deps stay pinned to exact versions.
- Hydrate/update locally with `npm install --ignore-scripts`; clean/CI-style with `npm ci --ignore-scripts`. Don't run lifecycle scripts unless the user asks.
- If dep metadata changes, refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.
- If `packages/coding-agent/npm-shrinkwrap.json` needs regen, run `node scripts/generate-coding-agent-shrinkwrap.mjs` (verify with `--check` or `npm run check`). New deps with lifecycle scripts require review and an explicit allowlist entry in that script; never add one silently.
- Pre-commit blocks lockfile commits unless `VOLT_ALLOW_LOCKFILE_CHANGE=1`. Don't bypass unless the user wants the lockfile change committed.

## Git

Multiple volt sessions may be running in this cwd at the same time, each modifying different files. Git operations that touch unstaged, staged, or untracked files outside your own changes will stomp on other sessions' work. Follow these rules:

Committing and pushing:

- You may commit your own completed work without explicit user consent when a commit is a useful checkpoint or natural outcome of the task.
- You may push without an extra confirmation when pushing is the expected next step for the requested workflow and the remote/branch are unambiguous.
- Ask before committing or pushing if the scope, target branch, remote, ownership of changes, or safety implications are unclear.
- Only commit files YOU changed in THIS session.
- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- `packages/ai/src/models.generated.ts` may always be included alongside your files.
- Message format: `{feat,fix,docs}[(ai,tui,agent,coding-agent)]: <commit message> (optionally multiple lines)`. Message is informative and concise.

Never run (destroys other agents' work or bypasses checks):

- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.

If rebase conflicts occur:

- Resolve conflicts only in files you modified.
- If a conflict is in a file you did not modify, abort and ask the user.
- Never force push.

## Issues and PRs

See `CONTRIBUTING.md` for the contributor gate (auto-close workflows, `lgtm`/`lgtmi`, quality bar).

When reviewing PRs:

- Do not run `gh pr checkout`, `git switch`, or otherwise move the worktree to the PR branch unless the user explicitly asks.
- Use `gh pr view`, `gh pr diff`, `gh api`, and local `git show`/`git diff` against fetched refs to inspect PR metadata, commits, and patches without changing branches.
- If you need PR file contents, fetch/read them into temporary files or use `git show <ref>:<path>` without switching branches.

When creating issues:

- Add `pkg:*` labels for affected packages (`pkg:agent`, `pkg:ai`, `pkg:coding-agent`, `pkg:tui`); use all that apply.

When posting issue/PR comments:

- Write the comment to a temp file and post with `gh issue/pr comment --body-file` (never multi-line markdown via `--body`).
- Keep comments concise, technical, in the user's tone.
- End every AI-posted comment with the AI-generated disclaimer line specified by the originating prompt (e.g. `This comment is AI-generated by `/wr``).

When closing issues via commit:

- Include `fixes #<number>` or `closes #<number>` in the message so merging auto-closes the issue. For multiple issues, repeat the keyword per issue (`closes #1, closes #2`); a shared keyword (`closes #1, #2`) only closes the first.

## Testing volt Interactive Mode with tmux

Run the TUI in a controlled terminal (from the repo root):

```bash
tmux new-session -d -s volt-test -x 80 -y 24
tmux send-keys -t volt-test "./volt-test.sh" Enter
sleep 3 && tmux capture-pane -t volt-test -p     # capture after startup
tmux send-keys -t volt-test "your prompt here" Enter
tmux send-keys -t volt-test Escape               # special keys (also C-o for ctrl+o, etc.)
tmux kill-session -t volt-test
```

## Changelog

Location: `packages/*/CHANGELOG.md` (one per package).

Sections under `## [Unreleased]`: `### Breaking Changes` (API changes requiring migration), `### Added`, `### Changed`, `### Fixed`, `### Removed`.

Rules:

- All new entries go under `## [Unreleased]`. Read the full section first and append to existing subsections; never duplicate them.
- Released version sections (e.g. `## [0.12.2]`) are immutable; never modify them.

Attribution:

- Internal (from issues): `Fixed foo bar ([#123](https://github.com/hansjm10/Volt/issues/123))`
- External contributions: `Added feature X ([#456](https://github.com/hansjm10/Volt/pull/456) by [@username](https://github.com/username))`

## Releasing

**Repository prerequisite**: protect `refs/tags/v*` with a GitHub repository
ruleset that restricts creation, update, and deletion to release owners. The
release script and CI validate an annotated tag on `main`, but checks loaded
from a tag cannot defend against an actor who can replace that tag or its
workflow without a repository-level rule.

Configure the GitHub `binary-release` environment with administrator bypass
disabled and restrict deployments to protected `v*` tags. While Volt has one
maintainer, the release owner must complete and record the standalone-binary
license gate in `BETA-READINESS.md` before creating the release tag; the tag is
the authorization for the final release-assets job.

**Lockstep versioning**: all packages share one version; every release updates all together. `patch` = fixes + additions, `minor` = breaking changes. No major releases.

1. **Update CHANGELOGs**: ask the user whether they ran the `/cl` prompt on the latest commit on `main`. If not, they must run `/cl` first to audit and update each package's `[Unreleased]` section before releasing.

2. **Local smoke test**: build an unpublished release and smoke test from outside the repo (so it can't resolve workspace files):
   ```bash
   npm run release:local -- --out /tmp/volt-local-release --force
   cd /tmp

   # Node package install smoke tests
   /tmp/volt-local-release/node/volt --help
   /tmp/volt-local-release/node/volt --version
   /tmp/volt-local-release/node/volt --list-models
   /tmp/volt-local-release/node/volt -p "Say exactly: ok"
   /tmp/volt-local-release/node/volt

   # Standalone Node SEA smoke tests
   /tmp/volt-local-release/standalone/volt --help
   /tmp/volt-local-release/standalone/volt --version
   /tmp/volt-local-release/standalone/volt --list-models
   /tmp/volt-local-release/standalone/volt -p "Say exactly: ok"
   /tmp/volt-local-release/standalone/volt
   ```
   Verify both the npm install and standalone startup, model/account listing, interactive startup, and at least one real prompt with the intended default provider. The bare commands `/tmp/volt-local-release/node/volt` and `/tmp/volt-local-release/standalone/volt` start interactive mode; run each in tmux, submit a prompt, and wait for the model reply before considering the interactive smoke test passed. Failures are release blockers unless the user explicitly accepts the risk.

3. **Prepare the exact release candidate**:

   Preparation creates and pushes the final release commit to `main`, but does
   not create or push a release tag:

   ```bash
   VOLT_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:initial  # first 0.1.0 beta only
   VOLT_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:patch    # fixes + additions
   VOLT_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:minor    # breaking changes
   ```
   The package manifests are already at `0.1.0`, so use `release:initial` for
   the first beta. `release:patch` would intentionally prepare `0.1.1`.
   Use `npm_config_min_release_age=0` only for the release command. The repo's normal npm age gate can otherwise block the release lockfile refresh when the current workspace package version was published recently. Review any lockfile or shrinkwrap diffs the release creates before push.

   The prepare phase first requires clean local `main` to exactly match
   `origin/main`, verifies that the planned tag and npm package versions are
   still available before changing any files, then bumps all package versions,
   updates changelogs, regenerates release artifacts, runs `npm run check`,
   commits `Release vX.Y.Z`, and pushes that exact commit to `main`. Record the
   full 40-character candidate commit printed by the script. Do not amend it or
   add the next `## [Unreleased]` sections yet.

4. **Build, inspect, and approve the pre-tag native candidate**:

   Dispatch `.github/workflows/build-standalone-candidate.yml` with the exact
   40-character commit from step 3. For example, with GitHub CLI:

   ```bash
   candidate=$(git rev-parse HEAD)
   gh workflow run build-standalone-candidate.yml --ref main -f commit="$candidate"
   ```

   Record the successful workflow run's positive decimal run ID. Download the
   combined `standalone-candidate-$candidate` artifact from that exact run.
   Verify its `source-commit.txt` is exactly `$candidate`, inspect and smoke-test all six
   native archives, review their binary and file manifests, verify
   `SHA256SUMS`, and record the license-compliance approval described in
   `BETA-READINESS.md`. Confirm every other hard gate, including the recorded
   Doom generated-artifact removal, before continuing. The candidate workflow has read-only
   permissions and cannot publish npm packages, push a tag, or create a GitHub
   release.

   Only after approving that exact candidate, finalize it with the SHA as an
   explicit sign-off:

   ```bash
   candidate_run=<approved-successful-workflow-run-id>
   VOLT_APPROVED_CANDIDATE_RUN_ID="$candidate_run" npm run release:finalize -- "$candidate"
   ```

   Finalization again requires clean `main` to exactly match `origin/main`,
   requires the supplied SHA to equal `HEAD`, requires the positive decimal run
   ID, queries GitHub to require that exact run to be a successful
   `workflow_dispatch` on `main` for the candidate commit with the expected
   unexpired combined artifact, verifies the prepared release commit and
   package metadata, and rechecks tag/npm availability. It then creates the annotated tag at the approved
   commit with machine-readable `Standalone-Candidate-Commit` and
   `Standalone-Candidate-Run` lines, pushes the tag, adds fresh
   `## [Unreleased]` sections in a separate next-cycle commit, and pushes
   `main`. With no independent environment reviewer, the explicit commit/run
   sign-off is the release owner's authorization for the tag-triggered jobs.

5. **CI publishes npm packages before exposing binaries**: pushing the
   `vX.Y.Z` tag triggers `.github/workflows/build-binaries.yml`. The
   workflow locates the successful candidate run for the tag's exact commit,
   downloads and reverifies the same six reviewed archives and checksums, and
   promotes those bytes; it does not rebuild replacement standalone archives.
   The `publish-npm` job uses npm trusted publishing through GitHub Actions OIDC
   with environment `npm-publish`. The final GitHub release job runs only after
   npm succeeds through the tag-restricted `binary-release` environment. In the
   solo-maintainer workflow it does not pause for a reviewer, so the compliance
   gate must be complete before the release tag is created.
   Except for the documented one-time name-reservation placeholders, real
   releases never use local `npm publish`, a long-lived token, OTP, or WebAuthn.

6. **If CI publish fails**: inspect the failed `publish-npm` job. The publish helper is idempotent and skips package versions already present on npm, so rerun the existing tag workflow after fixing CI or transient npm issues. Do not rerun either release phase or recreate the tag for the same version.

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.
