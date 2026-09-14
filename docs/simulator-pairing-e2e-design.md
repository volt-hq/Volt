# Fresh-install simulator pairing E2E

Status: native CA binding, private CLI build seam, and tagged broker implemented and locally tested; app/harness integration and full pairing pending.

## Objective and baseline

Install packages built from the current Volt checkout into a clean Linux Docker
container, launch **bare `volt`**, and complete setup through **`/remote`** using
an iOS simulator. No runtime Volt environment overrides, copied host credentials,
pre-registered workspaces, or prewritten Volt settings may establish the happy
path. The harness may provision its own infrastructure and build test artifacts.

The September 14, 2026 manual run used CLI commit
`2f8cafc8f1d828954c5f69f0ca890d8400a62511`, Linux arm64, Node 24.21.0, and the
project's iPhone 17 Pro simulator. The packed CLI installed with
`--ignore-scripts`, launched without provider credentials, and completed:

1. `/remote` -> Start daemon.
2. Register current directory.
3. Pair a phone -> Coding access.
4. Create a production-relay claim and compare matching ticket fingerprints.

Confirmation stopped at `IrohPairingAttestationError.unavailable`. The daemon
reported transport ready, relay credential state `pairing`, no clients, and zero
phone connections. This is not successful pairing or relay-path validation. The
simulator already had app state, so this run is not fresh iOS onboarding evidence.

## Decision

Use two validation lanes:

- **Simulator E2E:** test-only installation, subscription, App Check, and App
  Attest proof providers; real UI, approval HTTP routes, PostgreSQL transactions,
  grant state, JWT signing, authenticated Iroh relay, persistence, and reconnect.
- **Release acceptance:** production-distributed app on a physical iPhone with
  genuine Apple/Firebase verification and the exact release CLI defaults.
  TestFlight/canary acceptance remains distinct from App Store/production
  acceptance. The simulator lane cannot replace either Apple acceptance gate.

The simulator lane uses explicit, nonpublishable build profiles with a fixed
isolated broker/relay authority. The user workflow remains bare `volt` followed
by `/remote`; test deployment selection is a build input, never an implicit
runtime fallback. Record that these are test-profile artifacts, not byte-identical
production release artifacts.

## Isolation boundaries

- Separate simulator E2E build and bundle identity, using the dedicated `Volt-E2E`
  device owned by the test harness; never erase the development iPhone 17 Pro.
- Separate build-tagged broker command and private run directory. Do not add a
  simulator verification mode to `cmd/relay-credential-service`.
- Run-local PostgreSQL instance, signing key, installation identity, and proof
  authority. No production or canary credentials, subscriptions, database, KMS,
  Firebase debug-token registrations, DNS, or deployments are used.
- Test clients accept only the exact test broker/relay pair. Synthetic proof
  providers reject production/canary origins before sending any evidence.
- Generate proof authority per run, keep secrets out of argv/logs, and never
  include private keys in source or distributable artifacts. Persist a run's
  identity and counters through reconnect tests; start fresh on a new run.
- Production build outputs exclude the synthetic providers and test command.
  Test artifact manifests identify profile, source commits, and native artifacts;
  release packaging must reject test-profile outputs.
- Local services must remain inaccessible outside the rig. Publish Docker ports
  only on host loopback; keep PostgreSQL unexposed. Check port ownership and fail
  rather than reusing an unrelated service.

## TLS dependency gate

Use **real HTTPS with a private, run-scoped test CA**, not HTTP or disabled
certificate verification. Both
`services/relay-credential-broker/internal/appattest/request.go` and
`volt-app/Packages/VoltClient/Sources/VoltClient/Transport/IrohPairingAttestationRequest.swift`
require an HTTPS issuer in the signed request binding. Existing local HTTP
canary exceptions cannot complete this contract.

The installed `@hansjm10/volt-iroh` `EndpointBuilder` and the inspected
`iroh-ffi/src/endpoint.rs` expose relay selection but not custom CA trust.
Underlying Iroh has `Builder::ca_tls_config` and
`CaTlsConfig::custom_roots`; its embedded trust roots do not acquire a private CA
merely because the simulator or operating system trusts it.

Approved supporting change: expose
bounded DER root-certificate configuration through the native bindings used by
both Node and Swift. Preserve default verification when unset; retain hostname,
chain, validity, and signature checks when set. Do not expose skip-verification.
Confirm the API against the exact native source revision used for both artifacts
before implementation. Validate an expected CA, wrong CA, wrong hostname,
expired certificate, and malformed certificate inputs. Only the E2E profile
loads the run's CA. Native Iroh peer-identity verification remains untouched.

The user approved the native-binding workstream on September 14, 2026. The
implementation adds `EndpointBuilder.ca_roots` / `caRoots` with shared bounded
DER validation in `iroh-ffi/src/ca_tls.rs`, using the already-locked Rustls
version. Rust tests exercise the bound endpoint's actual HTTPS configuration;
Node tests exercise real loopback TLS handshakes. No skip-verification API is
exposed. Local verification passed four Rust TLS tests, the existing peer echo
roundtrip, four Node TLS tests each on macOS and Linux arm64 Docker, and one
binding test each for Swift, Python, and Kotlin. Swift's test ran on macOS,
not the iOS simulator; its debug host library emitted deployment-floor linker
warnings. The iOS arm64 simulator static library compiled successfully.
A full simulator/relay pairing pass cannot yet be claimed.

The inspected native checkout is `v1.1.1-volt.2`; the iOS app currently pins
`v1.1.1-volt.3`, which excludes Apple-private UDP APIs. The CA binding
change was applied to an isolated `.3` source snapshot for the simulator rebuild;
the app's native dependency was not downgraded. Local, nonpublishable artifacts
are under `/tmp/volt-pairing-native-20260914/` (`node/` and `swift/`), with the
source baselines recorded in `source-manifest.txt`. The Linux validation image
is `volt-pairing-native:ca-test`. These debug artifacts are not a release
XCFramework or published npm packages. Release pins remain unchanged.

Native commit `9243f5a` was also cherry-picked onto the app's `.3` baseline in
`.worktrees/iroh-ffi-pairing-e2e`, branch `volt/pairing-e2e-ca`, as `c53177e`.
Both native commits are local and signed; neither was pushed or published.

## Broker implementation seam

Add `services/relay-credential-broker/cmd/relay-credential-e2e/`, with
`//go:build volt_e2e` on its source files. Construct the normal components:

- `database.Migrate` and a private `pgxpool`;
- `credential.LoadOrCreateSigner` with test-only issuer/audience/key;
- `broker.New`, injecting `broker.Config.AttestationVerifier`;
- `httpapi.NewServer`, injecting `httpapi.AppCheckVerifier` and
  `appstore.Verifier`.

Do not modify production challenge, approval, refresh, or revocation logic.
Keep synthetic verifiers inside the tagged command, not a production package.
Accept explicit private harness configuration rather than inherited production
broker environment settings. Reject production/canary issuer values and avoid
KMS entirely.

Synthetic verifier requirements:

- App Check envelopes are run-authenticated, bounded, uniquely identified and
  have a fixed expiry. Re-verifying the same token retains its JTI and expiry.
  PostgreSQL, not the fake verifier, consumes the token at approval.
- Installation proofs are run-authenticated and device-bound. Hash their raw
  payload bytes identically in Swift and Go. Retain installation/subscription
  identity on retries and entitlement reconciliation. Use the existing Sandbox
  database environment with an explicitly synthetic product/identity.
- Attestation registration and assertions bind the independently calculated
  production request digest. A synthetic registration object and monotonic
  counter-bearing assertion suffice; they are not evidence of Apple signatures.
- Fail closed on notification operations not covered by this pairing harness.

Existing examples are in `internal/httpapi/attestation_test.go`,
`internal/httpapi/server_test.go`, and `internal/broker/attestation_test.go`.
Do not reuse the permissive test authentication unchanged. The production
`DevelopmentAppCheckVerifier` has no replay-protected identity and the normal
local broker has no App Attest verifier; neither currently supports this lane.

## Implementation checkpoint

The tagged broker now lives in
`services/relay-credential-broker/cmd/relay-credential-e2e/`. Its README specifies
the exact private-file and proof contracts. The isolated implementation passed
unit tests, vet, and an HTTPS/PostgreSQL race-test run covering registration,
approval, replay rejection, counter rollback/advance, exchange, refresh, and real
JWT verification. That disposable database container was removed afterwards.
Ordinary Go builds exclude all six tagged Go files. These are broker-layer
results, not simulator or Iroh-relay evidence.

The CLI now keeps its managed deployment registry in
`packages/coding-agent/src/remote/iroh-deployment.ts`. Normal builds retain the
same production/canary registry and no custom trust roots. The separate
`scripts/pairing-e2e/build-cli.mjs` substitutes the exact loopback deployment and
public CA at bundle time, writes only to a new directory outside the checkout,
and marks its output private/nonpublishable. It rejects missing deployment input,
private-key material, invalid CA input, and output collisions. No runtime E2E
flag or environment selector was added. The daemon's private profile rejects
other relay authorities and requires the new native `caRoots` method after
preset selection. Node HTTPS trust survives later dispatcher reconfiguration.

Validation passed six build/TLS tests, 53 targeted coding-agent tests (including
existing daemon tests), the ordinary coding-agent build, and `npm run check`.
The check reported existing informational literal-key lint suggestions and three
platform-specific launcher skips, but no failures. A complete private CLI bundle
was built with a newly generated CA under
`/tmp/volt-pairing-cli-build-ty7FPj/bundle`; it is not yet an installed fresh
container package. CLI tests prove profile selection and HTTPS trust, not native
relay traffic or full pairing. The app has not yet been changed for this profile.

## App, CLI, and harness work

1. Add a nonpublishable CLI test build profile for the exact isolated HTTPS
   deployment and CA. Preserve all production defaults and origin-binding checks.
   Pack current workspace packages using the existing local-release process.
2. Add a simulator-only app test build with explicit proof-provider injection.
   The `IrohPairingAppAttestProvider` protocol and the existing approval-proof
   provider are the seams. Normal Debug, device, and Release builds retain real
   verification. Persist test key/counter state under the isolated app identity.
3. Build the pinned JWT relay, loading only the run's signing public key. Keep
   issuer/audience/subject/expiry validation and JWT-only admission enabled.
   Do not substitute public relays or use an unauthenticated relay dev mode.
4. Add a separate fresh-install pairing harness; do not silently repurpose
   `volt-app/scripts/e2e/e2e-sim.sh`. That existing conversation harness writes
   settings/trust, starts the daemon via CLI, and can read developer relay state,
   so it does not satisfy this test's first-install contract.
5. Harness starts bare Volt in an isolated terminal and navigates `/remote`.
   Obtain the ticket through the UI's Copy pairing ticket action. Simulator
   paste/injection replaces only the camera; UI confirmation is still required.
6. Fail the run if database integration, native relay, or simulator prerequisites
   are unavailable. A skipped test must not be recorded as E2E success.

## Acceptance and evidence

Required first milestone:

- Fresh container HOME and fresh isolated app/keychain state.
- No Volt runtime overrides, presets, provider credentials, or model calls.
- UI-owned daemon startup, workspace registration, access selection, and ticket.
- No approval before the user/test confirms the matching ticket details.
- Successful broker registration/approval/exchange and an app-scoped credential.
- Daemon records the expected paired identity, granted access, and live connection.
- App can discover the container workspace and the TUI-owned conversation.
- Independent relay evidence proves JWT-authenticated relay traffic; a connected
  UI alone could be using a direct path and is insufficient.
- App cold relaunch reconnects without a new ticket or a changed endpoint identity.

Supporting negative tests:

- Changed claim, host, app node, refresh hash, installation proof, device, token,
  issuer, key, or build cannot use an existing attestation.
- Replayed token/challenge/counter and expired proof/challenge are rejected;
  failed approval does not consume otherwise valid retry authority.
- Wrong run proof authority and wrong relay signing key/subject are rejected.
- Synthetic proofs are rejected by real verification and test artifacts cannot
  be selected by normal release builds.
- TLS trust failures stay failures, not triggers for a weaker transport.

Record source SHAs, build profiles, package/native/image digests, bounded stage
results, sanitized screenshots, and test outcomes. Never retain raw ticket,
receipt, assertion, token, private key, or account/device identifiers in reports.
Real provider prompt validation is a separate opt-in step after pairing, not a
reason to prepopulate a supposedly fresh installation.
