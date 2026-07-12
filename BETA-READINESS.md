# Volt Beta Release Gates

The npm CLI/daemon and standalone binaries are **not ready for public beta
distribution** until every hard gate below is closed. Source development and
internal testing can continue while these external release prerequisites are
completed.

## Hard gates

- [ ] **Bootstrap npm publishing.** Reserve the four public
  `@hansjm10/volt-*` names with the non-installable `0.0.0-bootstrap.0`
  placeholder under only the `bootstrap` dist-tag, configure the
  `build-binaries.yml` trusted publisher for the `npm-publish` environment, and
  let tagged CI publish lockstep `0.1.0` under `beta` with provenance. Follow
  [Initial npm Release Bootstrap](docs/npm-release-bootstrap.md); do not publish
  the beta as `latest` and do not substitute a long-lived npm token for trusted
  publishing.
- [ ] **Approve standalone-binary license compliance.** The Bun executable
  statically links JavaScriptCore/WebKit portions licensed under LGPL-2.0.
  Complete a release-specific review of the exact embedded dependency and
  license inventory, preserve all required license texts, and provide the
  corresponding source/relinking materials required for the pinned Bun
  release. See [Third-Party Notices](THIRD-PARTY-NOTICES.md) and
  [Bun licensing](https://bun.sh/docs/project/license).

  The release build now includes the exact locally available Photon,
  Highlight.js, and Marked license files. The pinned clipboard packages do not
  ship an authoritative license text, and the Bun/WebKit materials are not
  available in this checkout. Obtain and review those exact materials before
  closing this gate; do not synthesize attribution from package metadata.

  **Do not publish the standalone binary until the release owner approves this
  compliance gate.** Configure the GitHub `binary-release` environment with a
  at least one required release-owner reviewer who owns this sign-off, prevent
  self-review, and restrict deployments to protected `v*` tags. Do not add
  environment secrets. The workflow may build and checksum the binaries, but
  its final GitHub release job is the only job with `contents: write` and must
  remain unapproved until the exact release's compliance record is complete.
  Do not silently omit or disable binary builds to make a release pass.
- [ ] **Prove the npm daemon distribution.** From an unpublished package
  installed outside the repository, run the full Node smoke test in
  [AGENTS.md](AGENTS.md#releasing). Then use an isolated
  `VOLT_CODING_AGENT_DIR` to start `volt daemon`, verify `volt daemon status
  --json`, register a disposable workspace, and stop that isolated daemon.
  Confirm the optional native `@number0/iroh` adapter loads on macOS arm64,
  Linux x64/arm64 (glibc and musl), and Windows x64/arm64. The pinned adapter
  has no Darwin x64 binding, so Intel macOS must remain explicitly local
  CLI/TUI only. A Bun binary is also intentionally local CLI/TUI only and must
  reject daemon/remote commands; see
  [Binary Capabilities](packages/coding-agent/BINARY-CAPABILITIES.md).
- [ ] **Create one auditable release source.** Run `npm run check`, complete the
  changelog review and outside-repository smoke tests, then create the canonical
  annotated `v0.1.0` tag whose commit is reachable from protected
  `main` and exactly matches all four package versions and changelog headings.
  Configure a GitHub repository ruleset that restricts creation, update, and
  deletion of `v*` tags to release owners. The release workflow verifies the
  local invariants and refuses to replace an existing artifact with different
  bytes; the repository ruleset is required because workflow code from an
  untrusted tag cannot protect itself.

## Release-owner sign-off

Record the npm bootstrap verification, binary compliance approval, smoke-test
platforms/results, final commit, protected annotated tag, and generated
checksums in the release record before inviting beta users.
