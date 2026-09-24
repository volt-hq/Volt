# Privacy request operations

Owner: Jordan Hans. Public intake: `jordan.hans@volt-cli.dev`, forwarded to the
Gmail inbox Jordan monitors (confirmed on 2026-09-09). Gmail is the sole support
email store reported by the owner. Related: [Volt #349](https://github.com/volt-hq/Volt/issues/349)
and [volt-app #253](https://github.com/volt-hq/volt-app/issues/253).

This is an operator procedure for the approved email-based policy. It does not
add a public deletion endpoint. The tooling is locally rehearsed, and live
disposable Firebase deletion was verified on September 9 (see
[live verification](privacy-live-verification.md)). The owner approved the
retention schedule and confirmed the support-email inventory on September 9.
Mailbox delivery and the owner-assisted live phone/Mac walkthrough now pass;
retained-copy follow-ups remain open. An encrypted ledger archive on the
External drive passed restore verification; Jordan confirmed successful archive
opening and password-manager custody (see [ledger recovery](privacy-ledger-recovery.md)).
Do not infer deletion of every provider backup from a live endpoint result.

## Intake and verification

The [ownership walkthrough](privacy-ownership-walkthrough.md) records the
simulator export result and completed live iPhone/computer connection check.
The subsequent read-only lookup matched the observed phone to one active broker
endpoint and located its reported push target. Exact scope still requires review
before any actual deletion; neither the report nor a host match authorizes
deleting a whole grant.

A private mailbox rehearsal is prepared at
`PrivacyRequests/support-intake-20260909/`, with a request, acknowledgment draft
and walkthrough. Jordan confirmed that the test reached Gmail on September 9.
Jordan also confirmed the acknowledgment reached the original sender, completing
the mailbox delivery test. Actual From/Reply-To headers were not inspected; this
does not establish a domain send-as identity. Remove this case's test
correspondence, including Gmail Trash and controlled sender copies, by October 9
under the approved schedule; actual removal remains unconfirmed. Include the
final confirmation in the next manual encrypted snapshot (September 11 review).
No mailbox contents have been accessed by the agent. Mail delivery alone does
not verify device ownership.

1. Create a private case with request date, requested action (access/deletion),
   reply channel, systems/devices in scope, owner and next review date. Keep the
   case outside GitHub and product backups; restrict access and encrypt storage.
2. Ask the requester to prepare **Settings > Privacy Requests** details on each
   available Volt installation and each relevant selected computer. The new app
   screen exports FID, Firebase project/app IDs, current push target and current
   host node ID. It excludes notification tokens, pairing secrets and content.
   It does not export every historical pairing or prove purchase ownership.
3. Treat reports, email addresses, receipts and screenshots as lookup leads,
   not authorization. Verify control of the relevant installation and host
   through a live owner-supervised check using the running app/paired computer.
   Record the method, date, scope and operator decision. Never ask users to email
   private node keys, refresh keys, push credentials, FCM tokens or Apple login
   credentials. For lost devices, disputed/shared ownership or insufficient
   evidence, keep the case open and agree an alternative verification method
   with the owner before disclosing or deleting records.
4. Explain the requested scope and consequences: removing a grant disconnects
   **all** its endpoints; deleting broker entitlements does not cancel an Apple
   subscription or erase Apple's records. An active service can create fresh
   records. Arrange cessation of affected service activity during deletion.
   Do not change entitlement enforcement to prevent legitimate future use.

## Locate and review broker records

Use the approved database connection and confirm its cloud instance, project,
database and schema in the case. The production broker was stopped at the
September 9 audit; this procedure does not authorize starting it.

Run read-only queries with bound parameters in a private database client. For a
verified host node ID (`$1`), start with:

```sql
SELECT g.id, g.host_node_id, g.created_at, g.revoked_at,
       ge.app_transaction_id
FROM grants g LEFT JOIN grant_entitlements ge ON ge.grant_id = g.id
WHERE g.host_node_id = $1 ORDER BY g.created_at;

SELECT c.id, c.grant_id, c.approved_app_endpoint_id, c.created_at, c.expires_at,
       p.app_transaction_id
FROM pairing_claims c
LEFT JOIN app_store_approval_proofs p ON p.claim_id = c.id
WHERE c.host_node_id = $1 ORDER BY c.created_at;
```

For each candidate grant, list `endpoints.id`, `kind`, `node_id`, `created_at`
and `revoked_at` by `grant_id`. Review all affected endpoints with the requester.
For each candidate app transaction, inspect `grant_entitlements` and approval
proofs joined to claims. A subscription may have transferred to a different
grant; the current binding is not a complete history or proof of ownership.
Unbound claims need explicit claim IDs. Never select all records based on an
email address, a shared host, or a guessed association.

Create a private `scope.json` with exact reviewed IDs (example values only):

```json
{
  "caseID": "case-2026-example",
  "verificationReference": "private-case/ownership-review",
  "database": "reviewed_database",
  "schema": "public",
  "grantIDs": ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
  "appTransactionIDs": ["verified-app-transaction-id"],
  "claimIDs": ["verified-unbound-claim-id"]
}
```

From `services/relay-credential-broker`, provide `VOLT_PRIVACY_DATABASE_URL`
through the operator's secret environment, not shell history. Use `umask 077`
and save outputs in the private case directory. Commands below use placeholders:

```sh
go run ./cmd/privacy-request -operation broker-plan -scope /private/case/scope.json
go run ./cmd/privacy-request -operation broker-apply -scope /private/case/scope.json -fingerprint REVIEWED_PLAN_FINGERPRINT
go run ./cmd/privacy-request -operation broker-plan -scope /private/case/scope.json
```

Save/review the first plan's counts and fingerprint before applying. Zero counts
do not prove that the right identifiers were supplied. The final plan must show
zero for the reviewed scope. Retain the applied scope and receipt in the deletion
ledger before closing the case. Do not blindly retry after an ambiguous error:
re-query first and preserve the failure/partial result in the case.

The tool supports migrations 1–3. It rejects relationships crossing the reviewed
scope and changes since the plan. Apply uses one transaction with brief table
write locks (5-second lock timeout, 30-second statement timeout); arrange a
maintenance window. Failed broker deletion rolls back. Firebase, logs, support
and backup work are separate operations with separate outcomes.

`consumed_app_check_tokens` cannot be attributed to an individual from the stored
hash. Do not broadly delete anti-replay records. Record their expiry/processing
and any justified retention exception. Existing access tokens may remain usable
until their configured expiry; verify that old refresh keys fail without logging
them. Later App Store notifications or renewed service use may recreate records;
recheck and explain continuing processing rather than claiming permanent erasure.

## Push registration and Firebase installation

Use approved Application Default Credentials with access to the **explicitly
reviewed project**. Do not grant roles or enable APIs as part of a request. Remove
any `FIRESTORE_EMULATOR_HOST` setting before live operations; record whether each
receipt came from a rehearsal or a live provider. Match the app's project/app ID
to the operator inventory. A push target ID and a Firebase installation ID are
different identifiers; neither proves control by itself.

Alternatively, supply an existing short-lived OAuth token through the
`VOLT_PRIVACY_ACCESS_TOKEN` process environment. This overrides ADC for this
invocation and does not change the operator's saved sign-in. Capture the token
programmatically from the authorized identity; keep it out of shell history,
command arguments and case receipts. The live rehearsal used this path because
gcloud was signed in while ADC was unset.

```sh
go run ./cmd/privacy-request -operation push-plan -project REVIEWED_PROJECT -case CASE_ID -verification PRIVATE_REVIEW_REFERENCE -push-target EXACT_TARGET
go run ./cmd/privacy-request -operation push-delete -project REVIEWED_PROJECT -case CASE_ID -verification PRIVATE_REVIEW_REFERENCE -push-target EXACT_TARGET -update-time REVIEWED_UPDATE_TIME
go run ./cmd/privacy-request -operation push-plan -project REVIEWED_PROJECT -case CASE_ID -verification PRIVATE_REVIEW_REFERENCE -push-target EXACT_TARGET
go run ./cmd/privacy-request -operation installation-delete -project REVIEWED_PROJECT -case CASE_ID -verification PRIVATE_REVIEW_REFERENCE -installation VERIFIED_FID
```

Review the push plan's grant/app IDs and timestamps. A missing `grantId` is not
proof of no association; newly registered targets may not have delivered a
notification. Delete requires the reviewed document's exact update time, so a
changed registration fails instead of being silently removed. Re-query for
`document-absent`; retain receipts for each installation/target. The tool never
outputs the FCM token or push authorization hash.

The installation operation calls Firebase Admin's `DeleteInstanceID` with the
verified **FID**. Its receipt means the provider accepted a deletion request.
[Firebase documents](https://firebase.google.com/docs/projects/manage-installations)
that server deletion takes time to propagate and associated live/backup data
removal can take up to 180 days. Firebase services can create a new FID if the
app continues using them. FCM token deletion alone does not cover this operation.
Record provider follow-up dates; do not report immediate total deletion.

## Retained copies, support and restoration

Inventory each case's applicable copies: broker SQL instances/backups/PITR,
Firestore exports/backups, Cloud Logging buckets/sinks, Cloudflare logs, email
forwarding destination, support mailbox, attachments and operator exports.
Use the actual current configuration, not a blanket retention deadline. At the
September 9 audit, old on-demand SQL backups still existed and Cloudflare
Logpush inspection returned 403; those findings do not prove automatic expiry
or absence of copies. Log retention and mailbox-provider deletion need explicit
case decisions. Do not delete shared audit/security records without a reviewed
basis; record the limited retained data, reason and next expiry review instead.

Keep a restricted deletion ledger separate from product backups with the exact
scope, verification reference, per-system receipts, retained-copy inventory,
expiry/follow-up dates and completion decision. Give this ledger its own owner
and documented retention decision; it also contains personal identifiers.
Delete temporary raw exports and excess support attachments once no longer
needed; review Trash, synced devices and the mailbox provider's retained copies.
Keep the minimum case evidence needed to track the request and any exception.

Before restoring a backup to service, isolate it from clients, notification
workers and external traffic. Consult the independent ledger, re-query and
review each completed case against the restored data, reapply applicable
deletions, and verify absence **before** reopening traffic. Do not reuse an old
fingerprint without a fresh scope review. Mark backup expiry only after the
inventory confirms it. A restored or continuing-service record is not proof
that a previous delete failed, but it requires follow-up processing.

Reply with completed systems, provider requests still processing, justified
retained data and follow-up dates. A broker success must not close a failed
Firebase/support/backup step. For access requests, prepare a separate reviewed
export excluding credentials, other users' data and security-sensitive records;
the deletion plan's counts are not a subject access export.

## Rehearsal and remaining verification

Local PostgreSQL tests cover selected/unrelated subjects, crossed ownership
relationships, stale review, atomic rollback, repeat planning, and a real
`pg_dump`/`psql` backup restore followed by deletion replay. Firebase tests use
the actual pinned Admin SDK with local HTTP/gRPC fixtures to check exact FID
targeting, failed provider acceptance, document version preconditions, absence
queries and exclusion of push credentials. They do not test live IAM or prove
provider-side data removal.

Run with `VOLT_TEST_DATABASE_URL` explicitly pointing at a disposable database;
the restore test requires a local Unix socket and `pg_dump`/`psql` on PATH:

```sh
go test -race ./internal/privacyrequest ./cmd/privacy-request
```

Before closing operational verification, the owner must complete a disposable
case through intake, live ownership review, actual provider operations, retained
copy decisions and response. Record that evidence privately. Keep unresolved
StoreKit, exact-archive privacy/export answers, upload authorization and physical
iPhone TestFlight checks tracked separately from the merged policy implementation.

The Firebase portion of that exercise is now complete. The approved manual
retention schedule and exact backup review list are in
[retention decisions](privacy-retention-decisions.md). Remove routine support
email and attachments from Gmail, including case-specific Trash, within 30 days
after closure unless a dated exception applies. Review due cases weekly. Keep
minimal case evidence for 12 months after the final provider/copy obligation is
resolved. Approval of this schedule does not authorize individual shared-backup
deletions; complete the listed recovery reviews first.

September 9 local validation: after the owner authorized the workspace build,
`npm run build`, `npm run check`, and the full `./test.sh` run passed. The test
launcher ran with provider credentials removed and restored its temporary auth
file move successfully. Results: 6,842 passed, 818 skipped, including all 68
push-relay tests. Broker race tests, database restore/replay and vet passed
separately. These are local validation results, not live-provider deletion proof.
