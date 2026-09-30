---
name: release
description: Run a Volt release end to end, from pending changesets to published npm packages and the GitHub Release. Use when asked to cut, prepare, or publish a Volt version, to recover a failed release step, or to verify a standalone candidate. Covers local pre-flight, Prepare Release, release PR review and merge, candidate build and verification, native smoke tests, Approve Release, and post-publish checks.
---

# Releasing Volt

The authoritative runbook is `docs/github-release-automation.md`; the release rules in `AGENTS.md` still apply. This skill is the fast path distilled from real releases. If it disagrees with the runbook or the workflows, they win.

## Authority

- The user asking for a release authorizes pre-flight fix PRs, including merging them once their CI passes, Prepare Release, reviewing and merging the release PR, approving its pending CI run, and the candidate build.
- **Approve Release needs the owner's explicit go-ahead in the conversation**, given after you present the candidate review. It creates an immutable tag and publishes to npm; never infer consent.
- Never push to `main`, create or move tags, or publish npm packages locally.
- Before a tag exists, a bad release commit on `main` is fixed by a PR that reverts it, then Prepare Release again (precedents #480, #505, #507). A fix on top of the release commit is not approvable. After the tag exists, only rerun **Publish Release** at that tag.

## 0. Pre-flight (local, before dispatching anything)

1. `git fetch origin`; confirm the `origin/main` tip, `git log --oneline v<previous>..origin/main`, no open release PR, and no `v<version>` tag.
2. Curate fragments with the `/cl` prompt (`.volt/prompts/cl.md`): `npm run changelog:preview`, then land wording fixes through a PR. Ask the owner which features get highlight billing.
3. Work in a release worktree at the `origin/main` tip. Check `git worktree list` first, since an earlier session may have left `../.worktrees/release-<version>`. Reuse it only when `git status` is clean and nothing runs in it: `git checkout --detach origin/main`, rerun `npm ci --ignore-scripts` if `package-lock.json` changed, and rebuild whichever of `packages/tui`, `packages/ai`, `packages/agent` changed, in that order. Otherwise `git worktree add ../.worktrees/release-<version> origin/main`, then `npm ci --ignore-scripts` and build those three packages in that order. Wait for `git worktree add` to finish before starting the install.
4. Catch model-catalog drift now; Prepare Release regenerates models from live catalogs and fails on the result:
   ```bash
   npm --prefix packages/ai run generate-models && npm run check
   node .volt/skills/release/check-default-models.mjs
   node .volt/skills/release/diff-model-catalog.mjs
   git checkout -- packages/ai/src/models.generated.ts
   ```
   `check-default-models.mjs` fails on any provider default missing from the regenerated catalog. `diff-model-catalog.mjs` compares the working tree with `HEAD` and lists each changed, added, or removed entry, plus the tests that quote each changed or removed model key. Fix type errors from retired model IDs and any newly missing default in a PR first (#503); ask the owner to pick replacement defaults. Discard the regenerated file afterwards; Prepare Release regenerates it.
5. Local release smoke: `npm run release:local -- --out /tmp/volt-local-release-<version> --force`. Its packed-daemon smoke uses an isolated `VOLT_CODING_AGENT_DIR`, so a running `voltd` is safe. From `/tmp`, for both `node/volt` and `standalone/volt`: `--help`, `--version` (still the previous version), `--list-models`, `-p "Say exactly: ok"`, and one interactive prompt in tmux (see the `view-cli` skill).

## 1. Prepare Release

```bash
gh workflow run prepare-release.yml --ref main -f target=patch   # minor for breaking changes
gh run list --workflow prepare-release.yml --limit 1 --json databaseId,headSha
gh run watch <run-id> --interval 30 --exit-status
gh run view <run-id> --log | grep PULL_REQUEST_URL
```

A failed run pushes nothing; read `gh run view <run-id> --log-failed`, fix through a PR, and dispatch again.

## 2. Review and merge the release PR

- The PR holds one commit, `Release v<version>`. Check lockstep versions in all four `packages/*/package.json`; `.changeset/` holds only `README.md` and `config.json`; the new `CHANGELOG.md` section opens with the unsigned-Windows disclosure; lockfile and shrinkwrap diffs are version bumps only (example extensions such as `sandbox` carry their own versions). For `models.generated.ts` drift, `git fetch origin <release-branch>` and run `node .volt/skills/release/diff-model-catalog.mjs <pre-release-main-sha> FETCH_HEAD`; check each test it names.
- Its CI run waits in `action_required`. Approve it:
  ```bash
  gh run list --branch <release-branch> --json databaseId,status,conclusion
  gh api -X POST repos/volt-hq/Volt/actions/runs/<run-id>/approve
  ```
  Commits you push to the release branch trigger CI without approval.
- Known flakes: `test/suite/extension-work.test.ts` evidence validation (#509) and Windows PowerShell `spawnSync ... ETIMEDOUT`. Confirm the failure is unrelated, then `gh run rerun <run-id> --failed`.
- Merge with `gh pr merge <n> --squash`; GitHub's default `Release v<version> (#<n>)` subject is accepted. Confirm `git diff <pr-head> origin/main` is empty and record the new `main` SHA. Do not merge anything else to `main` until approval.

## 3. Build and verify the candidate

```bash
gh workflow run build-standalone-candidate.yml --ref main -f commit=<sha>
gh run watch <run-id> --interval 30 --exit-status
gh api repos/volt-hq/Volt/actions/runs/<run-id>/artifacts \
  -q '.artifacts[] | select(.name=="standalone-candidate-<sha>") | "\(.id) \(.digest) \(.expires_at)"'
gh run view <run-id> --log | grep CANDIDATE_ARTIFACT_DIGEST_RAW     # must equal the API digest
gh run download <run-id> -n standalone-candidate-<sha> -D /tmp/volt-candidate-<version>
node .volt/skills/release/verify-candidate.mjs /tmp/volt-candidate-<version> --commit <sha> --run <run-id> --previous v<previous>
```

The verifier checks the nine-file layout, `source-commit.txt`, `SHA256SUMS`, `release-record.json`, each archive's build manifest against `compliance/standalone-runtime.json`, the copied Node license, the metafile checksum, every npm license file, the complete file manifest, prohibited files, and one attestation per file bound to the commit, `main`, the candidate workflow, and the run. It must end with `Problems: none`. `--previous` downloads the last release's archives and lists every bundled npm package added, removed, updated, or relicensed since then; review each entry, especially new licenses and `(undeclared)`. Windows archives must report `no certificate table (unsigned)`; the verifier fails if a Windows `volt.exe` has any certificate table.

The verifier extracts the `.tar.gz` archives with `tar` and the Windows zips with `unzip`, so both must be on `PATH`.

## 4. Native smoke tests

CI only runs `volt --version` on each native runner. Test what this host can run and report the rest as not smoke-tested.

- **Host platform:** extract its archive, then `--version` (the new version), `--help`, `--list-models`, `-p "Say exactly: ok"`, one tmux prompt, and `volt daemon status`, which the standalone binary must reject.
- **Linux in containers:** use `debian:bookworm-slim` (glibc 2.36; the minimum is 2.28). Do not mount credentials, since OAuth refresh-token rotation can sign out the host; `FIREWORKS_API_KEY=x volt --provider fireworks --model <default> -p hi` must reach the API and return 401.
  - On macOS, use Colima. It shares only `$HOME`, so copy the extracted `volt/` directory under `$HOME` before bind-mounting it; `/tmp` mounts come up empty. Apple silicon runs `linux/arm64` natively and `linux/amd64` under emulation. Run `colima stop` afterwards if it was stopped before.
  - On a Linux host, the host archive is the native test; the other architecture needs Docker or Podman with QEMU binfmt. Without a container runtime, only the host target can be smoke-tested.
- **darwin-x64** needs Rosetta on Apple silicon; **Windows** cannot run on either host. Report every target you could not run as covered only by CI's `volt --version`.

## 5. Approve Release (owner go-ahead required)

Present the version, SHA, run ID, digest, verifier result, smoke coverage and gaps, and the authorization phrase. Only after explicit approval:

```bash
gh workflow run approve-release.yml --ref main \
  -f version=<version> -f candidate_commit=<sha> -f candidate_run_id=<run-id> \
  -f candidate_artifact_digest=sha256:<digest> \
  -f license_compliance_approved=true -f native_smoke_tests_approved=true \
  -f unsigned_windows_acknowledged=true -f confirm_release=true \
  -f "authorization_phrase=release v<version> from <sha> using run <run-id> and sha256:<digest>"
```

Expect `preflight`, `tag-release`, and `dispatch-publication` to succeed, then check the tag with `git fetch origin tag v<version> && git cat-file -p v<version>`: annotated, tagged by the release App, targets `<sha>`, and records the candidate run, digest, and approval run.

## 6. Publish and verify

Approval dispatches **Publish Release** at the tag: `gh run list --workflow build-binaries.yml --limit 1`. Expect `validate`, `assemble`, `publish-npm`, and `release` to succeed.

`publish-npm` waits up to 20 minutes for each accepted package to become visible (#533); in v0.2.2, `volt-coding-agent` took about 7 minutes to list and 12 minutes to serve its tarball. If it still fails with `npm accepted @hansjm10/<pkg>@<version>, but its registry metadata is not visible after 20 minutes`, npm accepted that package but has not served it yet. Do not publish by hand or rerun preparation or approval. Wait until `npm view @hansjm10/<pkg>@<version> dist.integrity` answers and `https://registry.npmjs.org/@hansjm10/<pkg>/-/<pkg>-<version>.tgz` returns 200, then rerun at the same tag:

```bash
gh workflow run build-binaries.yml --ref v<version> -f tag=v<version>
```

The rerun repeats build, check, and tests (about 15 minutes), skips each package after exact-byte and provenance verification, and publishes the GitHub Release. Then:

- `gh release view v<version> --json isDraft,isPrerelease,isImmutable,assets,body`: published, immutable, not a prerelease, exactly 8 assets, and notes that open with the disclosure. `gh api repos/volt-hq/Volt/releases/latest -q .tag_name` is the new tag.
- `gh release download v<version> -D <dir>`, then `shasum -a 256 -c SHA256SUMS`, `cmp` each asset against the candidate, `gh release verify v<version>`, and `gh release verify-asset v<version> <file>` for every asset.
- For `volt-ai`, `volt-tui`, `volt-agent-core`, and `volt-coding-agent`: `npm view @hansjm10/<pkg>@<version> version dist-tags gitHead dist.attestations.provenance.predicateType --json` shows `latest` on the new version, `beta` on `0.1.0`, `bootstrap` on `0.0.0-bootstrap.0`, `gitHead` equal to the release SHA, and SLSA provenance.
- Clean install in a temporary directory (`npm init -y && npm install --ignore-scripts @hansjm10/volt-coding-agent@<version>`; a tarball 404 soon after publication is propagation, so wait and retry): `--version`, one `-p` prompt, `node scripts/check-iroh-native-load.mjs --from <dir>/node_modules/@hansjm10/volt-coding-agent` (the shrinkwrap nests `volt-iroh` under the package), and an isolated daemon with `VOLT_CODING_AGENT_DIR=<dir>/.agent VOLT_IROH_RELAY_MODE=disabled`: `daemon start`, poll `daemon status --json` until `remoteTransport.state` is `ready`, then `daemon stop`.

## 7. Clean up

Remove the release worktree, merged local branches, `/tmp` release artifacts, and started containers or VMs. Report every flake rerun, skipped platform, and follow-up worth an issue.

## Pitfalls

- Recent `gh` releases print the new run's URL from `gh workflow run` (2.101 does); older ones print nothing. Either way, confirm the run with `gh run list --workflow <file> --limit 1 --json databaseId,headSha` and match `headSha`.
- `gh attestation verify` prints nothing without a TTY; use `--format json`, as the verifier does.
- `--list-models` shows only providers with credentials; set a dummy key such as `FIREWORKS_API_KEY=x` to inspect a provider's catalog.
- Standalone archives: macOS and Linux extract to `volt/`; Windows zips put `volt.exe` at the root.
