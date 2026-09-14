# Private simulator-pairing CLI build

This is development tooling, not a release entrypoint. It does not start a daemon,
register a workspace, supply credentials, or change runtime environment settings.

First build the current coding-agent sources using the ordinary build. Then run
from the repository root:

```sh
node scripts/pairing-e2e/build-cli.mjs /absolute/run/ca.pem /absolute/new/bundle
```

The CA must be one currently valid, self-signed public PEM CA certificate. Generate
it per run; never use checked-in TLS test fixtures. Private keys are rejected. The
output directory must not exist and must be outside this checkout. The build fails
if its deployment module is absent from the compiled input (for example, stale
`dist` from before the deployment seam).

The separate esbuild plugin substitutes `remote/iroh-deployment` with only:

- Broker: `https://127.0.0.1:18443`
- Relay: `https://127.0.0.1:19443`
- The run's public CA for Node HTTPS and the native `caRoots` binding.

Normal build/release entrypoints do not load the plugin. Their production/canary
authority and default TLS trust are unchanged. There is no runtime E2E flag or
environment fallback. The private profile rejects other relay configurations and
fails endpoint startup if its native binding lacks `caRoots`.

Output includes `private: true` package metadata and a nonpublishable artifact
manifest with the CA fingerprint. These files are a **CLI bundle, not an installed
npm package or a complete E2E rig**. Future harness packaging must preserve the
private marker on the outer package, retain current workspace package dependencies
and assets, and install the locally built native binding into a fresh container.
Never copy this bundle into normal release output or publish it.

Checks:

```sh
node --test scripts/pairing-e2e/build-cli.test.mjs
cd packages/coding-agent
node node_modules/vitest/dist/cli.js --run test/iroh-deployment.test.ts test/daemon-iroh-service.test.ts test/http-dispatcher.test.ts
```

See [the E2E design](../../docs/simulator-pairing-e2e-design.md) for simulator,
isolation, real-broker/relay, UI-confirmation, and acceptance requirements. The
simulator lane does not replace genuine Apple/Firebase verification on a device.
