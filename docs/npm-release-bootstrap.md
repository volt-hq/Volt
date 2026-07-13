# Initial npm Release Bootstrap

The four Volt package names are declared in their package manifests:

- `@hansjm10/volt-ai`
- `@hansjm10/volt-agent-core`
- `@hansjm10/volt-tui`
- `@hansjm10/volt-coding-agent`

The initial Volt beta uses lockstep version `0.1.0` and the npm `beta` dist-tag.
Before releasing it, reserve the four names with a non-installable
`0.0.0-bootstrap.0` placeholder under the `bootstrap` dist-tag. npm requires
every package to have a `latest` tag, so `latest` also remains pinned to this
inert placeholder throughout the beta. This creates the
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
   removes the temporary files. It never publishes `0.1.0` or creates `beta`;
   npm automatically points its required `latest` tag at the inert placeholder.
   A partial network failure is safe to retry: exact
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
5. Configure the GitHub `binary-release` environment with administrator bypass
   disabled and restrict deployments to protected `v*` tags. In the current
   solo-maintainer workflow, complete and record the exact standalone-binary
   license review before creating the release tag; tag creation is the release
   owner's authorization for the final release job.
6. Verify each package with
   `npm view <name>@0.0.0-bootstrap.0 name versions license dist-tags repository --json`.
   The explicit selector avoids resolving through `latest`. Before the real
   release, the only version must be `0.0.0-bootstrap.0`; `bootstrap` and
   npm-required `latest` must both point to it; `beta` and `0.1.0` must be
   absent.
7. Run the normal build, checks, tests, and package dry-run inspection, then
   commit the reviewed `0.1.0` migration on `main`.
8. From a clean local `main` that exactly matches `origin/main`, prepare the
   already-versioned initial release commit with
   `npm_config_min_release_age=0 node scripts/release.mjs prepare 0.1.0`.
   Unlike normal `patch` and `minor` releases, this one-time explicit-current target does not
   increment the manifests: it verifies the placeholder-only registry state and
   target-version absence before changing any files, converts each
   `[Unreleased]` changelog section into the `0.1.0` release section,
   regenerates release artifacts, runs the release checks, commits
   `Release v0.1.0`, and pushes that exact commit to `main` without creating a
   tag.
9. Dispatch `build-standalone-candidate.yml` with the full 40-character commit
   printed by preparation. Record the successful run's positive decimal ID,
   download the combined artifact from that exact run, require
   `source-commit.txt` to match that commit, inspect and smoke-test all six
   native archives, verify `SHA256SUMS`, and complete the standalone-binary
   compliance record. The workflow is read-only and cannot publish or tag.
10. After every beta hard gate is closed, create the tag with an explicit
   approval of that exact candidate and workflow run:

    ```bash
    VOLT_APPROVED_CANDIDATE_RUN_ID=<approved-run-id> npm run release:finalize -- <exact-40-character-candidate-commit>
    ```

   Finalization refuses a different `HEAD` or invalid run ID, queries GitHub to
   require that exact successful run and its unexpired combined artifact,
   rechecks the package metadata and tag/npm availability, records the approved
   commit and run ID in annotated `v0.1.0`, pushes the tag, then pushes a separate
   next-cycle changelog commit. It refuses to
   run if `v0.1.0` already exists locally or on `origin`; never recreate or
   replace a release tag.
11. Let `build-binaries.yml` publish the real packages from `v0.1.0` in
   dependency order using trusted publishing, provenance, public access, and the
   `beta` dist-tag. It locates the successful candidate workflow for the tag's
   exact commit and promotes those reviewed standalone archives rather than
   rebuilding them. The workflow accepts safe partial-publication reruns, but
   fails if an already-published target version does not have `beta` pointing
   to it. Its final GitHub release job uses the tag-restricted
   `binary-release` environment and does not pause for a reviewer in the
   solo-maintainer setup.
12. Verify each real package with
   `npm view <name>@0.1.0 name version license dist-tags repository --json`.
   Confirm that `beta` resolves to `0.1.0`, `latest` remains pinned to the inert
   `0.0.0-bootstrap.0` placeholder, and the npm provenance links to
   `hansjm10/Volt` and the release workflow. Beta users must install with
   `@beta`; an unqualified install intentionally resolves to the placeholder.
13. Verify the final GitHub release assets and checksums match the approved
    candidate and release record.

npm requires a package to exist before a trusted-publisher relationship can be
configured. Only the non-installable name-reservation placeholder uses the npm
account's approved interactive authentication; the real `0.1.0` and subsequent
versions use the trusted publisher. Do not add a long-lived publish token to the
workflow as a shortcut.
See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and
[publishing scoped public packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/).
