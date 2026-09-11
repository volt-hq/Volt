# Pairing attestation rollout

Issue: https://github.com/volt-hq/Volt/issues/387
Companion app: https://github.com/volt-hq/volt-app/issues/278

## Evidence and change

On September 11, 2026, the real TestFlight installation failed inside forced
`AppTransaction.refresh()` before broker approval. Apple system logs showed a
missing account token on one attempt and a sandbox authentication HTTP 502 on a
later attempt. StoreKit classified the latter as cancellation despite completed
sign-in. These observations do not establish a TestFlight-only Apple bug.

The diagnostic app verified `AppTransaction.shared` immediately and again after
relaunch, with proof age increasing from 0 to 103 seconds. It is usable cached
installation evidence, not a fresh pairing proof. The coordinated changes use
that verified evidence plus a two-minute, single-use, request-bound App Attest
challenge and monotonic assertion counter. App Store verification, device digest,
current subscription lookup and limited-use Firebase App Check remain required.

## Deployment prerequisites

Do not publish the companion app before the canary broker supports the new
routes. An iOS TestFlight GitHub Action uploads only the app; this repository has
no broker deployment Action. Broker deployment uses the reviewed Cloud Run
process in `deploy/canary.sh` (or an explicitly approved revision update).

Before deploying the broker:

1. Verify the release archive's signed `application-identifier`; configure that
   complete value as `VOLT_APP_ATTEST_APP_ID`. The prefix need not equal Team ID.
   The signed TestFlight build 4 artifact was inspected on September 11, 2026:
   `application-identifier=FLCDL5CJU2.com.hansjm10.volt`, production App Attest,
   `get-task-allow=false`. Canary defaults to this verified App ID; a future
   signing-prefix change requires review of the new signed authority.
2. Preserve the existing canary database, KMS key, issuer/audience and Firebase
   allowlist. Set `VOLT_APP_STORE_MODE=apple`, `VOLT_APP_CHECK_MODE=firebase`,
   `VOLT_APP_STORE_ENVIRONMENTS=Sandbox`, and the exact canary issuer. Startup
   rejects missing App Attest authority. Ensure the deployment environment
   includes the new variable. The updated canary script supplies it through
   `VOLT_APP_ATTEST_CANARY_APP_ID` with the verified default above.
3. Permit POST to the three new `/attestation/status`, `/attestation/challenge`
   and `/attestation/register` routes under an existing claim path at the edge,
   with the approval rate budget. Bodies are capped at 128 KiB to accommodate a
   48 KiB signed transaction plus a bounded 24 KiB base64 attestation. Assertion
   objects are capped at 1 KiB, responses at 16 KiB in the app.
4. Back up and apply migration 0004 through normal broker startup. It adds key
   and challenge tables without resetting current grants or credentials. Old
   receipt-consumption records remain available to reviewed privacy deletion.
   Coordinate the migration and traffic cutover: the old broker rejects unknown
   migrations on startup, so staging a new revision at zero traffic can make old
   instances unable to start once migration 0004 is applied. Use a maintenance
   window and promptly move traffic to the ready new revision. A code-only
   rollback to the old schema-0003 binary is not safe.
5. Verify broker readiness, issuer and new-route responses before publishing the
   paired app commit through its signed TestFlight workflow.

Canary uses Sandbox purchases but **production App Attest**, validation category
2 (TestFlight). Production uses Production purchases and category 4 (App Store).
A development-signed app, simulator, unsupported device or missing signed
metadata cannot substitute for either. The broker requires signed build version
and validation-category extensions. Their actual availability on the target
TestFlight OS/build must be checked during acceptance; there is no silent
fallback if Apple omits them.

## Acceptance on the existing TestFlight installation

Install the new TestFlight build through TestFlight, preserving app data. Record
version, build, commit, OS and broker revision. Keep daemon identity and saved
hosts; no purchase, restore, credential reset or daemon restart is required.

- Capture one normal pairing. Verify shared installation proof, App Attest key
  registration, challenge/assertion approval, broker exchange and authenticated
  host discovery. Record only bounded stage/error identifiers.
- Retry a deliberately lost approval response with the same claim/node/refresh
  hash but a fresh limited-use token, nonce and higher counter; endpoint/grant
  authority must remain identical.
- Relaunch the app and confirm reconnect and ordinary credential refresh.
- Against isolated fixtures, reject changed claim/host/node/refresh/proof/device/
  issuer/token/key/build, expired nonce, old counter, consumed challenge/token,
  invalid Apple chains/signatures, wrong environment/category, missing metadata
  and inactive subscription. Failed approval must roll back all replay state.

Never log or attach raw receipts, JWS, App Attest objects, tokens, pairing secrets,
account identifiers or device identifiers. App Attest keys are not automatically
pruned to reset counters; exhausted capacity fails closed and needs an explicit
retention review. Recovery after loss of a previously registered hardware key is
not an automatic credential-reset path.

A rollback must keep the database and authority intact. Old app/broker approval
protocols are incompatible; coordinate any code rollback without deleting the
new key counters or re-enabling a receipt-only approval path.

## Production requirements

For production, deploy the matching broker image to
`relay-credential-broker-production` with `VOLT_APP_ATTEST_APP_ID` set to the
verified signed App ID, its existing production KMS/database/Firebase authority,
Production-only App Store verification and the production issuer/audience.
Its verifier requires App Store validation category 4, not TestFlight category 2.
Add the three POST attestation routes to the production edge allowlist and keep
the bounded body/rate controls. Take a backup and apply migration 0004 without
resetting grants, counters or credentials. Validate with an App Store-distributed
installation; a TestFlight upload is not production acceptance. The user
authorized the production broker deployment on September 11, 2026 while CI
finishes, noting there are no users. App Store publication remains separate.

## Canary deployment record — September 11, 2026

The authorized deployment serves 100% of canary traffic from
`relay-credential-broker-canary-appattest-c3675d07b`, built from runtime commit
`c3675d07b` (Cloud Build `357cfcc6-6a08-4adf-a87e-2e2fb1170281`). Image digest:
`sha256:b08b8d5ef578de6c99208d4557e0e1742a59224d47aa8b70128f36f4c2517ecc`.
Cloud SQL backup `1789145553339` completed before deployment. The existing
database, signing authority, issuer/audience and Firebase configuration were
preserved; the new App Attest App ID is the verified value above.

The staged revision passed readiness before traffic cutover. The public canary
origin returned 503 while traffic still targeted the old revision after the
migration; service recovered after moving traffic to the new revision. Public
`/livez` and `/readyz` now return 200, JWKS is available, and all three new routes
reject missing/invalid authentication or input. These probes created no claims
and do not establish successful real-device App Attest enrollment or pairing.

## Production deployment record — September 11, 2026

Production serves 100% of traffic from
`relay-credential-broker-production-appattest-c3675d07b`, using the identical
runtime image digest recorded for canary. Cloud SQL backup `1789147655455`
completed successfully at `2026-09-11T17:29:06.824Z` before deployment. Migration
0004 ran through startup, followed immediately by the traffic switch to the
ready new revision.

Only the image and `VOLT_APP_ATTEST_APP_ID` were changed in the container
configuration. The production database attachment, service account, secret
references, KMS authority and all existing environment settings were preserved.
Production-only purchases and validation category 4 remain required. Public
health endpoints return 200, JWKS matches the pre-deployment key set, and the
three attestation routes reject unauthenticated or invalid requests. No claims
were created by probes. Real App Store enrollment and pairing remain unvalidated.

## Approved parser dependencies

The user approved `github.com/fxamacker/cbor/v2 v2.9.3` and its dependency
`github.com/x448/float16 v0.8.4` on September 11, 2026 after checksum, MIT-license,
release and decoder-limit review. Only these versions/checksums are added to the
module files. The decoder rejects duplicate keys, tags, indefinite lengths,
invalid UTF-8, unknown fields and excessive nesting/collection sizes; outer
object sizes are bounded before decoding.
