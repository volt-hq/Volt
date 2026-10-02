# Live Firebase deletion verification — September 9, 2026

Result: live operator deletion verified for disposable Firestore push targets
and Firebase installations in `volt-3fae7`. The owner explicitly authorized the
live verification. No existing customer records, development installations,
Apple purchases, cloud permissions, production SQL services or deployments were
changed. No email or notification was sent.

## Scope and evidence

Two fresh random FIDs were registered through the Firebase Installations wire
protocol used by the pinned iOS SDK. Both successfully generated authentication
tokens before deletion. Two matching-role Firestore test targets were created
with non-deliverable synthetic tokens, notifications disabled, a rehearsal
marker and one-hour expiry. These were new records owned by this exercise;
existing device identifiers were not used.

The existing gcloud identity passed the required project permission check. ADC
was unset, so the operator command used a short-lived OAuth token through its
process environment. Tokens were not printed, passed as command arguments, or
stored as operator credentials. The actual Firebase Admin SDK performed the
deletions; no emulator was configured.

| Step | Observed result |
| --- | --- |
| Both FIDs before deletion | Refresh requests returned HTTP 200. |
| Delete subject push target with its reviewed update time | Operator receipt reported document deletion; a fresh query reported absent. |
| Query control target after subject deletion | Its update time was unchanged. |
| Submit subject FID deletion | Firebase Admin accepted the request. |
| Probe subject and control | Subject refresh returned HTTP 404; control still returned HTTP 200. |
| Clean up control target and FID | Control target query reported absent; both FID refresh requests returned HTTP 404. |
| Remove verification credentials | Both refresh credentials removed from the active private case file; only identifiers and redacted evidence retained. |

This proves the tested live deletion path and separation of the selected subject
from the control. It does not prove every Google backend/backup copy was already
erased. Firebase's documented associated-data removal window is tracked with a
follow-up date of **March 8, 2027** (180 days after the accepted request). Source:
[Firebase installation management](https://firebase.google.com/docs/projects/manage-installations).

The exercise used API-created disposable installations. It did not run a real
user's device through the new app screen, authenticate an emailed request,
demonstrate mailbox delivery/deletion, or verify human ownership of shared
records. Those are separate operational checks in the request runbook.

## Private case storage and retained copies

The ledger lives under `~/Library/Application Support/Volt/PrivacyRequests` on
the verified FileVault-enabled internal data volume. Its directory is mode 0700
and case files are mode 0600. It is outside source repositories and SQL/Firestore
backups. No Time Machine destination is configured. A later AES-256 archive on
the External drive passed a full 20-file restore comparison; independent
password-manager custody and successful opening were confirmed by Jordan. See
[ledger recovery](privacy-ledger-recovery.md).

Sanitized evidence and configuration snapshots are in
`/Volumes/External/DeveloperCaches/volt-349-live-privacy-20260909/`, including
`live-verification-summary.json`, `preflight.json`, backup inventories and
`cloudflare-dashboard-evidence.json`. Private record identifiers and individual
receipts stay in the internal ledger. No working refresh credentials remain.

The [approved retention schedule](privacy-retention-decisions.md) lists exact
on-demand backup IDs and review dates. Shared backups were retained; individual
deletion decisions remain conditional on recovery review. On September 9 Jordan
approved the schedule and confirmed Gmail as the sole support-email store: he
monitors the Gmail destination of the published `volt-cli.dev` forwarding address.
Jordan subsequently confirmed test delivery into Gmail and acknowledgment
delivery back to the original sender. The subsequent owner-assisted phone/Mac
walkthrough and read-only record lookup are documented separately in
[ownership walkthrough](privacy-ownership-walkthrough.md). Correspondence removal
and other retained-copy follow-ups remain open. Current Cloudflare Worker logging configuration was checked
through the dashboard without changing settings.

## Validation

After adding the short-lived-token option, `go test -race ./cmd/privacy-request`,
`go vet ./...`, and `npm run check` passed. The live operator exercised that
option successfully for both Firestore and FID deletion. The earlier complete
repository test run remains passing; no JavaScript or app code changed in this
live exercise. Public policy and release gates remain separate.
