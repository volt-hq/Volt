# Private Docker pairing infrastructure

Completed lane evidence: [2026-09-14 fresh-install pairing and cold reconnect](RESULTS.md).

These scripts build and provision infrastructure only. They **never run Volt**, start
its daemon, register a workspace, import credentials, or write Volt settings.
The interactive bare-`volt` → `/remote` workflow belongs to the operator.
See [the accepted design](../../docs/simulator-pairing-e2e-design.md),
[CLI build contract](README.md), and
[tagged broker contract](../../services/relay-credential-broker/cmd/relay-credential-e2e/README.md).

## Build before generating a run

Requires Docker running Linux arm64 (Colima works), Node compatible with the existing
private bundle builder, npm, Go, OpenSSL, git, and the already-built current checkout
packages. Builders require at least 5 GiB of free host disk before starting; allow
additional headroom for concurrent app builds. No dependencies or release pins
are changed. Builds access package/crate registries; the running rig has no public
network routing. If Colima reports an aborted journal or read-only filesystem,
stop: recovery may require restarting the shared VM and must be approved by the
operator because existing containers would be interrupted.

From the Volt repository:

```sh
node scripts/pairing-e2e/build-infra.mjs \
  /tmp/volt-pairing-infra-build /absolute/local/iroh-git-checkout
node scripts/pairing-e2e/build-cli-image.mjs \
  /tmp/volt-pairing-cli-build \
  /tmp/volt-pairing-native-20260914/node/iroh.linux-arm64-gnu.node
node --test scripts/pairing-e2e/rig.test.mjs
node scripts/pairing-e2e/rig.mjs up /tmp/volt-pairing-run \
  /tmp/volt-pairing-infra-build/artifact.json \
  /tmp/volt-pairing-cli-build/artifact.json
```

Every output directory must be new and outside the checkout under `/tmp`.
The local Iroh checkout is read-only input: `git archive` extracts exactly
`f2eb930dda3779c6d852b72f3712aacd6e573ab1`, then applies the checked-in JWT patch
only in the build directory. The arm64 Docker build uses Rust 1.97.1, locked
Cargo dependencies, format validation, release-mode binary tests, Clippy with
warnings denied, and a release build. This is a local arm64 build, not the
production x86_64/Zig release artifact.

Fresh `npm pack --ignore-scripts` runs for all four workspace packages. Only staged
copies receive private metadata and publication rejection hooks. Package contents,
assets, dependency pins, and shrinkwrap remain otherwise unchanged. The installed
native package receives the explicit local Linux arm64 binding, not a published
replacement. `up` inserts the current explicit private CLI bundle into its ordinary
npm entrypoint. It excludes the bundle-local `package.json` from that entrypoint
because config discovery must reach the full outer CLI package metadata.

No host HOME, settings, auth, provider credentials, source checkout, or Docker
socket is mounted in the CLI container. Its user is `node`, HOME is the empty
`/home/volt`, and its stable working directory is `/workspace`. The startup command
is only `sleep infinity`; no `VOLT_*` runtime overrides are set.

## Isolation and evidence

Each run creates uniquely labeled containers, volumes, and an **internal** network.
Broker, relay, and CLI share a dedicated internal container network namespace.
Docker ignores port publishing on internal networks, so a separate unprivileged,
read-only, mount-free TCP forwarding helper binds exactly ports 18443 and 19443
on the Linux VM's `127.0.0.1`. It forwards unchanged TLS bytes only to those same
ports on the namespace's private IP; it cannot choose a destination from client
input and has no proof authority or Docker socket. Colima forwards the VM's
loopback listeners to macOS loopback. The broker, relay, database and CLI still
have no public network route. Thus
both the CLI and simulator use exactly:

- `https://127.0.0.1:18443` — tagged TLS broker; fixed issuer.
- `https://127.0.0.1:19443` — real TLS Iroh relay; JWT-only admission.

PostgreSQL has no published ports and resolves only on the private network as
`postgres`. Relay metrics and its captive-portal HTTP listener bind namespace
loopback and are not published. No public relay or broker fallback is configured.
Port conflicts fail; existing containers and host services are never reused.

A new CA, IP-valid server certificate, Ed25519 signing seed, database password, and
proof authority are generated only after expensive builds. Config files are `0600`
and private directories `0700`. The broker's config and three assets are distinct
siblings, copied through Docker's API into a root-owned Docker volume to satisfy
its same-owner policy. This does not depend on Colima mounting host `/tmp`.
The relay receives only its TLS files and signing **public** key. The CLI image
build context contains only public trust material, JS, and artifact metadata—not
run secrets. The run expires after at most two hours; broker, relay, database, and
namespace processes have independent expiry timers. Teardown is still required.

`up` verifies trusted HTTPS from host and namespace, rejection without the run CA,
loopback-only publishing, an internal network, an unexposed database, empty CLI
HOME, and absence of Volt runtime overrides. A native Iroh endpoint then attempts
a real relay handshake without a JWT. A stoppable home-relay watch observes that
it remains offline; an unresolved `online()` future would pin native shutdown.
Success requires both no admission and the relay's specific
`authorization header missing` denial—not merely a timeout.

The run directory contains:

- `ca.pem`, `ca.der`: public CA for the isolated app build/simulator trust.
- `app-proof.json`: **private**, exact `{runId, proofSecret, expiresAt}` app config.
- `rig.json`: container names, volume/network names, absolute path, expiry.
- `images.json`, `cli-context/artifact.json`: image/package/native/profile evidence.
- `verification.json`: sanitized infrastructure results; pairing remains unattempted.

Do not print the app proof config, broker config, seeds, tokens, or raw logs.
Failure logs, when present, stay private within the run directory.
The synthetic proof providers exist only in the tagged broker and isolated app
build; this rig does not mint test approval tokens or bypass normal grant routes.

Before starting the UI, verification can be repeated:

```sh
node scripts/pairing-e2e/rig.mjs verify /tmp/volt-pairing-run
```

This intentionally rejects a HOME that is no longer pristine. Full simulator
pairing, authenticated relay traffic, workspace discovery, and cold reconnect are
separate acceptance steps; infrastructure readiness does not claim their success.

## Teardown

After the operator's UI workflow and evidence capture:

```sh
node scripts/pairing-e2e/rig.mjs down /tmp/volt-pairing-run
```

Teardown checks each resource's exact run-ownership label before removing it. It
also removes PostgreSQL's anonymous data volume. It leaves local private images
and the run directory for controlled evidence retention; those are nonpublishable
and contain sensitive private-run material. Do not reuse an expired authority.
No command touches `volt-beta-fresh`, a development daemon, or a simulator.
