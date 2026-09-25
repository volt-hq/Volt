# Privacy request ownership walkthrough

Related: [Volt #349](https://github.com/volt-hq/Volt/issues/349) and
[volt-app #253](https://github.com/volt-hq/volt-app/issues/253).

## September 9 simulator result

The follow-up app built and launched on the existing development iPhone 17 Pro
running iOS 26.5 using Xcode 26.6. The iOS 26.1 StoreKit comparison and toolchain
were preserved. Settings > Privacy Requests opened, and its explicit Prepare
button produced a current FID, project/app IDs, timestamp, schema version and
saved host node ID. No push target was present. The share control and all three
policy links were displayed. This checks the export flow in the observed layout;
it does not complete the policy-access matrix across subscription states or
accessibility sizes.

The simulator displayed **Host offline** for its saved pairing. A separate
read-only `volt daemon status --json` query on this Mac reported the daemon
running with transport ready but zero phone connections. The operator therefore
cannot use this report as authority to delete a host, grant or its other
endpoints. No pairing was changed and no app/provider record was deleted.

XcodeBuildMCP's semantic snapshot returned no actionable elements despite the
visible UI. Native Simulator screenshots/clicks and the supported simulator
scroll gesture completed navigation. No app workaround was added for that tool
limitation. Private screenshot and an allowlisted status summary are in
`PrivacyRequests/ownership-walkthrough-20260909/`; no credential-bearing daemon
state or raw status output was retained.

## September 9 physical iPhone result

The follow-up Release app was built, installed and launched on Jordan's iPhone
using `scripts/deploy-iphone.sh Jordan` and the existing Xcode 26.6 toolchain.
Jordan prepared and supplied the report at 16:11:03 UTC. Its project/app IDs
match the deployed app configuration; its selected host ID appears in the Mac's
daemon log. The report includes an installation ID and push target, retained
only in the private case record.

Read-only daemon observations correlated Jordan's instructed app actions:

| UTC observation | Owner action/context | Phone connections |
| --- | --- | --- |
| 16:14:42 | Initial baseline after report sharing | 0 |
| 16:16:18 | Reopened Volt and reported connected | 1 |
| 16:16:52 | Reported fully closing Volt; cleanup still pending | 1 |
| 16:17:37 | Kept Volt closed | 0 |
| 16:18:42 | Reopened Volt | 1 |

The daemon process remained the same. One paired client's activity advanced on
the first connection and that same client's activity advanced on reconnection.
This completes the owner-assisted live phone/Mac connection walkthrough. The
operator observed Mac status and owner confirmations, not the phone screen
directly. It does not independently authenticate the supplied Firebase IDs or
authorize deletion of a whole grant, other endpoints, or shared records. Review
those mappings and scope before any actual request is executed. No working
records were deleted; disposable deletion evidence is recorded separately.

The earlier connection interruption was resolved and is tracked separately in
[Volt #375](https://github.com/volt-hq/Volt/issues/375). No StoreKit action or
pairing change occurred during this walkthrough. The private receipts postdate
the verified encrypted snapshot and remain due for the September 11 manual
backup review. Subscription lifecycle and policy layout checks remain open.

## Read-only record mapping

The reviewed operator `push-plan` found the reported target in live Firestore,
enabled and associated with the same Firebase app ID as the prepared report.
No `grantId` is stored on that target. This does not establish absence of a
broker relationship, and the shared Firebase app ID is not a device identity.

A host-scoped lookup used the existing canary database through a temporary local
Cloud SQL Auth Proxy. The transaction reported read-only mode and was rolled
back; the proxy was stopped afterward. The production database remained untouched.
The lookup returned five historical/current grants, 17 endpoints and four claims
for this host, with one active grant. The observed phone node matches two
historical/current endpoints, exactly one active. Its active grant contains that
phone and the host endpoint, with no other app endpoints, and has a subscription
binding. Those facts locate records; they do not establish Apple purchase
ownership or authorize deleting that binding or host.

The current rehearsal therefore demonstrates live phone/Mac correlation and
read-only record discovery. A real deletion still needs exact scope review. The
supplied FID has no independently verified server-side link to the push target
or phone node in this evidence; the push target also lacks a stored grant link.
Do not turn these missing associations into guessed matches or an application
entitlement workaround. No existing record, notification, subscription, grant or
pairing was changed. Exact IDs, query receipts and the bounded operator decision
are in the private case ledger and due for the September 11 manual backup review.

## Procedure for subsequent live device checks

1. Jordan uses his unlocked iPhone and the intended paired computer while the
   operator observes the live interaction. Use the reviewed app build. Record
   the device/context privately, and agree whether the request covers only the
   installation, one host relationship, or additional devices/shared records.
2. Open Volt and select the intended saved computer. Confirm a live authenticated
   connection. On that computer, query daemon status and inspect the applicable
   client and workspace metadata without opening its credential-bearing state
   file. Observe the phone connection change while Jordan opens/closes the app
   connection and correlate it with the selected computer. If concurrent devices
   make the relationship ambiguous, keep verification open.
3. With the context stable, Jordan opens Settings > Privacy Requests and presses
   Prepare during the observed session. Compare the fresh report with that
   installation and selected host context. A forwarded report, screenshot, fresh
   timestamp or email address alone is insufficient. Record the observed actions,
   exact identifiers privately, scope and operator decision; do not ask for keys
   or tokens over email.
4. Review any grant's other endpoints and shared ownership before approving a
   destructive scope. Possession of one installation does not authorize erasing
   every device, subscription or shared host record. Missing/offline/disputed
   devices require a separate owner-reviewed method, not guessed associations.
5. Record the bounded verification result. This walkthrough need not delete the
   owner's working records: the separate disposable Firebase exercise and local
   broker deletion/restore replay provide that evidence. Keep unresolved scopes
   open, and refresh the encrypted case snapshot at the next manual review.

Do not start or repair an unrelated daemon, create a new pairing, change grants,
invoke StoreKit, or enter Apple Account authentication as a side effect of this
check. An offline pairing is an incomplete ownership check, not proof of an
entitlement failure.
