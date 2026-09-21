# Rebuilding workspace filesystem native prebuilds

**Build Workspace FS Prebuilds** (`.github/workflows/build-workspace-fs-prebuilds.yml`)
produces a review bundle for the eight committed workspace-fs native addons.
It does not commit, push, create a release, or publish a package. Every job has
only `contents: read`, and no repository credentials are persisted in checkout.

## Run the workflow

The workflow must first exist on the default branch for GitHub to accept a
manual dispatch. When introducing it alongside a change that already needs new
prebuilds, land the workflow/scripts/tests separately before building the
feature branch; do not merge stale native artifacts to bootstrap the workflow.

1. Push the intended native source and workflow to a branch.
2. Copy that branch's exact lowercase 40-character commit SHA.
3. Open **Actions → Build Workspace FS Prebuilds → Run workflow**.
4. Select that branch and enter its SHA in `commit`. The input must equal the
   selected ref's commit at dispatch; a branch movement causes validation to
   fail rather than silently building different source.
5. Wait for all eight builds and assembly to succeed.

Equivalent CLI dispatch, once the workflow is registered on the default branch:

```bash
gh workflow run build-workspace-fs-prebuilds.yml \
  --repo volt-hq/Volt --ref <source-branch> -f commit=<exact-sha>
```

The matrix uses native-architecture macOS, Windows, and Ubuntu runners. The two
musl builds compile and test inside a digest-pinned Rust 1.97.1 Alpine container
with Rust's static CRT disabled, rather than mixing Ubuntu's glibc toolchain
with musl. Their addons must also load in the pinned Node.js 22.19 Alpine container. Every target runs
Rust formatting, Clippy, and tests, and verifies its embedded source fingerprint
and native exports before upload. No npm dependency installation is needed.

Each target uploads only its binary and a receipt containing the target, commit,
source fingerprint, API version, and binary SHA-256. Assembly downloads artifacts
from the same workflow run and rejects missing/extra targets, unexpected files,
symlinks, mixed source identities, and checksum mismatches. It never fills a
missing target from a checked-in prebuild. Reruns replace only the corresponding
run-local artifacts; they do not replace repository or release assets.

## Review and commit the bundle

Download `workspace-fs-native-<exact-sha>` from the successful run. The summary
records its artifact digest and download link. The extracted bundle contains:

- `source-commit.txt` and `build-record.json` with source and per-target receipts;
- `SHA256SUMS` covering every other bundled file;
- `packages/coding-agent/native/workspace-fs/prebuilds/` with all eight addons and
  the regenerated manifest;
- `packages/coding-agent/native/workspace-fs/licenses/` with regenerated license
  texts and inventory.

Verify the source commit and run identity before copying anything. From the
extracted bundle, run `sha256sum -c SHA256SUMS` (or `shasum -a 256 -c SHA256SUMS`
on macOS). Review the native job logs, receipts, and license inventory.

Apply only the bundled `prebuilds/` and `licenses/` trees to a clean checkout of
the source branch. Do not copy the review metadata into the package. If native
source or Cargo metadata changed since the recorded source SHA, rebuild instead
of applying stale binaries. Review any removed license files explicitly rather
than leaving old files behind or deleting unrelated files.

Before committing the generated files:

```bash
node scripts/workspace-fs-native.mjs verify
node scripts/workspace-fs-native.mjs verify-licenses
npm run check
```

`verify` checks every artifact digest and loads the current platform's addon.
The workflow's per-target jobs supply the other platforms' load evidence; one
successful local load does not establish that every platform works.

The assembly/workflow regression tests run in normal CI and can be run locally:

```bash
node --test scripts/workspace-fs-prebuilds.test.mjs
```
