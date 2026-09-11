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
   The app source currently uses Team ID `FLCDL5CJU2` and bundle
   `com.hansjm10.volt`; that is not a substitute for inspecting signed authority.
2. Preserve the existing canary database, KMS key, issuer/audience and Firebase
   allowlist. Set `VOLT_APP_STORE_MODE=apple`, `VOLT_APP_CHECK_MODE=firebase`,
   `VOLT_APP_STORE_ENVIRONMENTS=Sandbox`, and the exact canary issuer. Startup
   rejects missing App Attest authority. Ensure the deployment environment
   includes the new variable; the existing `--set-env-vars` script must not erase
   it. Review this deployment configuration change before executing it.
3. Permit POST to the three new `/attestation/status`, `/attestation/challenge`
   and `/attestation/register` routes under an existing claim path at the edge,
   with the approval rate budget. Bodies are capped at 128 KiB to accommodate a
   48 KiB signed transaction plus a bounded 24 KiB base64 attestation. Assertion
   objects are capped at 1 KiB, responses at 16 KiB in the app.
4. Back up and apply migration 0004 through normal broker startup. It adds key
   and challenge tables without resetting current grants or credentials. Old
   receipt-consumption records remain available to reviewed privacy deletion.
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
