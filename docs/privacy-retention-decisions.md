# Operational retention decisions — September 9, 2026

Status: approved by Jordan Hans in the September 9, 2026 conversation. His
"Yes to both" approved this schedule and confirmed Gmail as the sole support
email store. He clarified that he monitors Gmail, which receives the published
`jordan.hans@volt-cli.dev` address through forwarding. Existing verified settings are
distinguished from new manual procedures. This does not change the public policy
or authorize deletion of an existing shared backup. Owner: Jordan Hans.

## Approved operating schedule

| Record/copy | Approved decision | Completion evidence |
| --- | --- | --- |
| Support email and raw diagnostics/attachments | Remove within 30 days after the support case closes, unless a documented dispute, security or legal need requires a dated exception. Extract minimal case evidence first. Review due items weekly. | Case-specific Gmail deletion, including its Trash, plus downloaded/synced copies identified by the owner. |
| Privacy verification secrets and temporary exports | Remove as soon as the required verification finishes. Never retain working credentials as case evidence. | Record removal time; keep redacted results and receipt references. |
| Minimal privacy case ledger | Keep for 12 months after the last provider follow-up and applicable retained-copy obligation is resolved. Retain the exact deletion mapping while any affected backup remains restorable. Every extension needs a reason and next review date. | Recorded closure basis, expiry date and a later deletion entry; quarterly review of exceptions. |
| New on-demand SQL cutover backups | Set a 30-day review/target-removal date when created. Remove only after rollback is no longer needed and a usable replacement/recovery path is established. | Exact backup ID, owner decision, successful deletion or dated extension. No blanket deletion command. |
| Existing automated SQL backups | Keep current count settings: 7 canary / 14 production, with configured production PITR of 7 days. These are counts/configuration, not promises that all copies disappear in that many days. | Current inventory and restore-time deletion replay. Stopped production requires a manual review because new backups are not rotating the old set. |
| Google Cloud operational/audit logs | Keep verified `_Default` 30-day and `_Required` 400-day retention. No broad shared-log purge during an individual request. | Record applicable scope, justified retained metadata and expiry; inspect any additional sinks separately. |
| Firebase installation data | Submit the exact FID deletion, verify the live endpoint stops accepting its refresh credential, retain the acceptance receipt and provider follow-up date. | Distinguish live endpoint verification from Google's separate live/backup data removal process. |
| Website, mail-provider and independent-provider copies | Record each known provider and any copies under the owner's control. Do not assert that inaccessible or independent-provider records were erased. | Provider configuration/support evidence or a clearly recorded unresolved item. |

Gmail normally leaves deleted messages in Trash for up to 30 days; case-specific
permanent deletion avoids silently adding that period to the approved support
schedule. This is not proof that every provider backend copy has been purged.
Source: [Gmail deletion behavior](https://support.google.com/mail/answer/7401).

Firebase describes an associated live/backup removal window of up to 180 days
after FID deletion. Its server deletion process and subsequent recreation of a
new installation are separate from immediate app-service cessation. Source:
[Firebase installation management](https://firebase.google.com/docs/projects/manage-installations).

## Existing on-demand backups requiring explicit review

Fresh listings show these successful backups. None was deleted by this audit.
Approved review dates below are 30 days after creation. Each backup still needs
its own recovery review and deletion decision before removal.

| Instance | Backup ID | Purpose/date | Target review |
| --- | --- | --- | --- |
| Canary | `1787423152123` | Managed relay acceptance, August 22 | September 21 |
| Canary | `1787455783441` | Pre-issuer cutover, August 23 | September 22 |
| Production | `1787464174160` | Authority cutover, August 23 | September 22 |
| Canary | `1788803053596` | Subscription cutover, September 7 | October 7 |

Production remains stopped. Its successful automated backups are also still
present from August 23/24. Keep them pending an owner recovery decision; do not
start production to force rotation or delete its recovery set as a side effect
of privacy verification. Review that stopped-instance set on September 22 with
the authority-cutover backup.

Cloud SQL retention depends on the backup configuration/type; a successful
backup listing is not a tested restore. Source:
[Cloud SQL backup overview](https://docs.cloud.google.com/sql/docs/postgres/backup-recovery/backups).

## Verified inventory and unresolved copies

- Firestore: no listed backups or backup schedules in the inspected database
  location; PITR disabled, version retention one hour. This does not establish
  that no manually copied records exist elsewhere.
- Cloud Storage: the three listed buckets serve Cloud Functions/Cloud Build.
  Upload staging has a one-day lifecycle rule. The function-source bucket keeps
  versions, with cleanup based on newer-version count. Cloud Build has no listed
  age lifecycle. Each has seven-day soft-delete retention. Do not treat a bucket
  object deletion as immediate erasure of all versions/copies. Any customer
  exports found there require their own reviewed scope.
- Cloudflare: the published contact address forwards to Gmail. Fresh zone and
  account Logpush API queries both return HTTP 403. Authenticated dashboard
  inspection shows the domain on Free, both Logpush pages showing plan
  availability notices, and the `volt` Worker serving only static assets.
  Worker logs/traces are disabled; its settings explicitly disallow Logpush and
  Tail Workers for static-only Workers. This resolves the current Worker export
  configuration; it does not establish absence of Cloudflare infrastructure,
  security/analytics records or historical copies.
- Support: the owner confirmed that he monitors the Gmail destination of the
  published forwarding address and that Gmail is the sole support-email store.
  No outside support-email copies were reported. No mailbox content was accessed
  or deleted by the agent. Jordan confirmed both test delivery into Gmail and
  acknowledgment delivery back to the original sender. The mailbox delivery test
  closed September 9; its correspondence-removal deadline is October 9, including
  Gmail Trash and the controlled test-sender copies. Removal remains unconfirmed.
- Private case storage: `~/Library/Application Support/Volt/PrivacyRequests`,
  outside repositories/product backups, mode 0700 on the FileVault-enabled
  internal data volume. No Time Machine destination is configured. A separate
  AES-256 archive on the External drive passed restore verification on September
  9; Jordan confirmed successful archive opening and password-manager custody.
  See [ledger recovery](privacy-ledger-recovery.md). Require access
  to the ledger before restoring product data and keep restored services closed
  until deletion replay is verified.

## Manual review calendar

Jordan owns weekly due-case reviews, recorded for Fridays beginning September
11, 2026. Review dated retention exceptions quarterly, next on December 9, 2026.
The private `PrivacyRequests/review-schedule.json` records these dates, the backup
reviews above and the Firebase follow-up on March 8, 2027. These are manual
review entries; no automated reminders were configured.

The disposable Firebase case stays open for provider follow-up. March 8, 2028
is its earliest conditional ledger-expiry date, only if all provider follow-ups
and applicable retained-copy obligations finish by March 8, 2027. Otherwise
calculate expiry 12 months after the last obligation is resolved and record the
reason and next review date. A provider follow-up date alone is not erasure proof.
The encrypted archive and its local restore have been verified; Jordan confirmed
successful opening and independent password-manager custody on September 9.

These are operational decisions and evidence limits, not a determination of
every jurisdiction's legal retention obligations. Escalate a concrete legal
hold or statutory requirement for owner/legal review and record its scope and
review date instead of silently overriding the schedule.
