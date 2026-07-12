# Initial npm Release Bootstrap

The four Volt package names are declared in their package manifests:

- `@earendil-works/volt-ai`
- `@earendil-works/volt-agent-core`
- `@earendil-works/volt-tui`
- `@earendil-works/volt-coding-agent`

As of the beta-readiness audit, neither the old installer identity
`@hansjm10/volt-cli` nor the intended Volt package names existed on the public
npm registry. The release workflow therefore fails before building or creating
a GitHub release until all intended names have been bootstrapped. This avoids a
successful binary release paired with a broken default installer.

An npm organization owner must perform the one-time bootstrap outside the
automated release:

1. Confirm the `@earendil-works` organization owns the intended Volt names and
   that the public repository metadata points to `hansjm10/Volt`.
2. Run the normal build, checks, tests, and package dry-run inspection.
3. Publish the current lockstep version as public in dependency order: `volt-ai`,
   `volt-agent-core`, `volt-tui`, then `volt-coding-agent`. A new scoped package
   requires `--access public` and interactive/approved npm authentication.
4. For each new package, configure npm trusted publishing for GitHub repository
   `hansjm10/Volt`, workflow filename `build-binaries.yml`, environment
   `npm-publish`, with `npm publish` allowed.
5. Configure a GitHub repository ruleset for `refs/tags/v*` that restricts tag
   creation, update, and deletion to release owners. Do not rely on checks that
   run from the tagged commit as a substitute for this repository-level rule.
6. Verify each package with `npm view <name> name version license --json`, then
   create the release tag. The release helper skips an already-published
   lockstep version, so a bootstrap version is safe to rerun through CI.

npm requires a package to exist before a trusted-publisher relationship can be
configured. Do not add a long-lived publish token to the workflow as a shortcut.
See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and
[publishing scoped public packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/).
