# Initial npm Release Bootstrap

The four Volt package names are declared in their package manifests:

- `@hansjm10/volt-ai`
- `@hansjm10/volt-agent-core`
- `@hansjm10/volt-tui`
- `@hansjm10/volt-coding-agent`

The initial Volt beta uses lockstep version `0.1.0` and the npm `beta` dist-tag.
Before releasing it, reserve the four names with a non-installable
`0.0.0-bootstrap.0` placeholder under the `bootstrap` dist-tag. This creates the
npm package settings needed for trusted publishing without consuming the real
version or publishing release code outside the tagged CI workflow.

The owner of the `hansjm10` npm scope must perform the one-time bootstrap
outside the automated release:

1. Confirm that the npm account owns the `@hansjm10` scope and that public
   repository metadata points to `hansjm10/Volt`.
2. Review the reservation helper, then check all four names without changing
   npm:

   ```sh
   node scripts/bootstrap-npm-packages.mjs
   ```

   The command fails closed if any name contains content other than Volt's exact
   bootstrap placeholder. Authenticate interactively with npm, then explicitly
   create any missing reservations:

   ```sh
   npm login --registry=https://registry.npmjs.org/
   node scripts/bootstrap-npm-packages.mjs --publish
   ```

   The helper creates temporary minimal packages outside the repository source,
   publishes them as public in dependency order, verifies each result, and
   removes the temporary files. It never publishes `0.1.0` and never creates
   `beta` or `latest`. A partial network failure is safe to retry: exact
   placeholders are verified and skipped.
3. For each reserved package, configure npm trusted publishing for GitHub
   repository `hansjm10/Volt`, workflow filename `build-binaries.yml`,
   environment `npm-publish`, with `npm publish` allowed. Then set package
   publishing access to require two-factor authentication and disallow tokens,
   and revoke any obsolete automation publish tokens. Trusted OIDC publication
   continues to work without leaving a long-lived credential.
4. Configure a GitHub repository ruleset for `refs/tags/v*` that restricts tag
   creation, update, and deletion to release owners. Do not rely on checks that
   run from the tagged commit as a substitute for this repository-level rule.
5. Configure the GitHub `binary-release` environment with a required
   release-owner reviewer. This approval is the enforcement point for the
   standalone-binary license gate; do not approve the final release job until
   the exact binary compliance record is complete.
6. Verify each package with
   `npm view <name>@0.0.0-bootstrap.0 name versions license dist-tags repository --json`.
   The explicit selector matters because the reservation intentionally has no
   `latest` tag. Before the real release, the only version must be
   `0.0.0-bootstrap.0`, the only dist-tag must be `bootstrap`, and `0.1.0` must
   be absent.
7. Run the normal build, checks, tests, and package dry-run inspection, then
   commit the reviewed `0.1.0` migration on `main`.
8. From a clean local `main` that exactly matches `origin/main`, prepare the
   already-versioned initial release with
   `npm_config_min_release_age=0 node scripts/release.mjs 0.1.0`. Unlike normal
   `patch` and `minor` releases, this one-time explicit-current target does not
   increment the manifests: it verifies the placeholder-only registry state and
   target-version absence before changing any files, converts each
   `[Unreleased]` changelog section into the `0.1.0` release section,
   regenerates release artifacts, runs the release checks, creates the annotated
   `v0.1.0` tag, and pushes the normal next-cycle changelog commit. It refuses
   to run if `v0.1.0` already exists locally or on `origin`; never recreate or
   replace a release tag.
9. Let `build-binaries.yml` publish the real packages from `v0.1.0` in
   dependency order using trusted publishing, provenance, public access, and the
   `beta` dist-tag. The workflow accepts safe partial-publication reruns, but
   fails if an already-published target version does not have `beta` pointing to
   it. Its final GitHub release job waits for `binary-release` approval.
10. Verify each real package with
   `npm view <name>@0.1.0 name version license dist-tags repository --json`.
   Confirm that `beta` resolves to `0.1.0`, `latest` is still absent, and the npm
   provenance links to `hansjm10/Volt` and the release workflow.
11. Complete the standalone-binary compliance record, approve the
    `binary-release` environment, and verify the final GitHub release assets and
    checksums.

npm requires a package to exist before a trusted-publisher relationship can be
configured. Only the non-installable name-reservation placeholder uses the npm
account's approved interactive authentication; the real `0.1.0` and subsequent
versions use the trusted publisher. Do not add a long-lived publish token to the
workflow as a shortcut.
See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and
[publishing scoped public packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/).
