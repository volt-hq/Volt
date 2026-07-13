# Volt Beta Release Gates

The npm CLI/daemon and standalone binaries are **not ready for public beta
distribution** until every hard gate below is closed. Source development and
internal testing can continue while these external release prerequisites are
completed.

## Hard gates

- [ ] **Bootstrap npm publishing.** Reserve the four public
  `@hansjm10/volt-*` names with the non-installable `0.0.0-bootstrap.0`
  placeholder under `bootstrap`, with npm-required `latest` also pinned to that
  inert placeholder, configure the `build-binaries.yml` trusted publisher for
  the `npm-publish` environment, and let tagged CI publish lockstep `0.1.0`
  under `beta` with provenance. Follow
  [Initial npm Release Bootstrap](docs/npm-release-bootstrap.md); do not publish
  the beta as `latest` and do not substitute a long-lived npm token for trusted
  publishing.
- [ ] **Approve standalone-binary license compliance.** Standalone artifacts
  use the official Node.js 22.23.1 runtime as a Single Executable Application,
  replacing the previous standalone runtime design. The runtime version,
  per-platform archive checksums, exact consolidated Node license, and license
  checksum are pinned in `compliance/standalone-runtime.json`.

  For the exact release commit, confirm that every native build verifies its
  pinned runtime archive, includes
  `LICENSES/node-v22.23.1-LICENSE.txt`, and emits both
  `binary-metafile.json` and `binary-license-manifest.json`. Review the
  manifest's metafile checksum, embedded npm package identities, copied
  license-file checksums, and any checksum-pinned overrides. Verify
  `standalone-file-manifest.json` accounts for every other staged archive file.
  Confirm the npm package and all standalone archives exclude
  `examples/extensions/doom-overlay`, and contain only components represented
  by the pinned runtime license or generated bundle inventory. See
  [Third-Party Notices](THIRD-PARTY-NOTICES.md).

  Build and smoke-test the native matrix: macOS arm64/x64, Linux arm64/x64,
  and Windows arm64/x64. The official Linux runtime requires glibc 2.28 or
  newer and does not support Alpine/musl. Windows beta executables are not
  Authenticode-signed; verify and record this disclosure and the final archive
  checksums before inviting testers.

  Prepare and push the untagged `Release vX.Y.Z` commit first (`npm run
  release:initial` for the already-versioned first `0.1.0` beta), then dispatch
  `build-standalone-candidate.yml` with its exact lowercase 40-character commit
  SHA. The workflow builds all six native archives with read-only permissions
  and publishes only a 30-day workflow artifact containing `source-commit.txt`
  and `SHA256SUMS`; it cannot publish npm packages or create a release. Download
  that combined artifact from the successful workflow run you will approve,
  require `source-commit.txt` to match the prepared commit, record the positive
  decimal workflow run ID, and perform this compliance review against those
  exact archives.

  **Do not create the release tag until the release owner approves and records
  this compliance gate for the exact prepared commit and workflow run.**
  Finalization requires that full commit SHA as an explicit argument and the
  approved positive decimal run ID in `VOLT_APPROVED_CANDIDATE_RUN_ID`, refuses
  a different `HEAD`, queries GitHub to verify that exact successful run and its
  unexpired combined artifact before tagging, and records both values in the
  annotated tag.
  Configure the GitHub `binary-release` environment
  with administrator bypass disabled and restrict deployments to protected
  `v*` tags. Do not add environment secrets. In the current solo-maintainer
  workflow there is no independent deployment reviewer, so pushing the release
  tag authorizes the final GitHub release job with `contents: write` to proceed
  after npm publication.
- [x] **Resolve Doom source-archive provenance.** The unverified generated Doom
  JavaScript/WebAssembly and Doom artwork have been removed from the repository.
  The remaining source-only demo ignores generated output, cloned upstream
  source, and the downloaded WAD; its optional local build pins the exact
  DoomGeneric source commit and warns that redistributed output is GPL-2.0.
  The npm package and custom standalone archives continue to exclude the whole
  demo as defense in depth.
- [x] **Prove the npm daemon distribution.** From an unpublished package
  installed outside the repository, run the full Node smoke test in
  [AGENTS.md](AGENTS.md#releasing). Then use an isolated
  `VOLT_CODING_AGENT_DIR` to start `volt daemon`, verify `volt daemon status
  --json`, register a disposable workspace, and stop that isolated daemon.
  Confirm the optional native `@number0/iroh` adapter loads on macOS arm64,
  Linux x64/arm64 (glibc and musl), and Windows x64/arm64. The pinned adapter
  has no Darwin x64 binding, so Intel macOS npm installs remain explicitly
  local CLI/TUI only. Standalone Node SEA binaries intentionally exclude Iroh
  on every platform and must reject daemon/remote commands; see
  [Binary Capabilities](packages/coding-agent/BINARY-CAPABILITIES.md).

  The release owner confirmed this gate complete on 2026-07-12 after extensive
  daemon and physical-iPhone deployment, pairing, reconnect, and session testing.
- [ ] **Create one auditable release source.** Run `npm run check`, complete the
  changelog review and outside-repository smoke tests, prepare the untagged
  release commit on protected `main`, and build and approve the six-platform
  standalone candidate for that exact commit. Then run

  ```bash
  VOLT_APPROVED_CANDIDATE_RUN_ID=<approved-run-id> npm run release:finalize -- <exact-candidate-commit>
  ```

  to create the canonical annotated `v0.1.0` tag at that same commit. The tag commit must be reachable
  from protected `main` and exactly match all four package versions and
  changelog headings. Configure
  a GitHub repository ruleset that restricts creation, update, and deletion of
  `v*` tags to release owners. The release workflow verifies the local
  invariants, requires a successful candidate run for the tag's exact commit,
  promotes those reviewed archive bytes without rebuilding them, and refuses
  to replace an existing artifact with different bytes; the repository ruleset
  is required because workflow code from an untrusted tag cannot protect
  itself.

## Release-owner sign-off

Record the npm bootstrap verification, candidate workflow run, exact candidate
commit, workflow run ID, and `source-commit.txt`, runtime and binary-license
manifest approval, Doom source-archive resolution, native-platform smoke
results, unsigned-Windows disclosure, final commit, explicit finalization
sign-off, protected annotated tag, and generated checksums in the release record
before inviting beta users.
