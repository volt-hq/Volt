# Iroh Saved Host Pairing Design

## Purpose

Define the target user workflow for pairing the Volt iOS app with a desktop Volt host once, then reconnecting after app, network, computer, or host-service restarts without scanning a new QR code.

This document uses plain product language first, then maps the behavior to the current Volt/Iroh implementation.

## Target User Workflow

1. The user opens Volt on their computer.
2. Volt shows host status and a "Pair phone" action.
3. The user selects "Pair phone".
4. Volt generates and shows a temporary QR code.
5. The user installs the Volt app and scans the QR code.
6. The phone and computer complete pairing.
7. The computer remembers that this phone is allowed.
8. The phone remembers this computer as a saved Volt host.
9. Later, the user restarts the computer or the host service.
10. When the host service starts again, the phone reconnects from the saved host entry.
11. The user does not scan another QR code unless they add a new phone, reinstall the app, delete saved state, or revoke/re-pair the device.

The QR code is a first-time invitation. It is not the long-term credential.

## Product Model

Use two different concepts:

- Pairing QR: short-lived invite used to add a new trusted phone.
- Saved host: durable relationship between one phone and one computer.

The pairing QR should behave like a setup code. After it is used, future authentication depends on the saved phone identity and saved host identity.

Client-specific storage and UI details should live in client docs. For the iOS app handoff, see `/Users/jordan.hans/Projects/volt-app/.volt/designs/iroh-saved-host-app-design.md`.

This is the safer mental model:

- A screenshot of an old QR should not let someone connect forever.
- A previously paired phone should reconnect without another scan.
- The desktop user can revoke a phone from the host.
- The phone user can forget the saved host from the app.

## Current Implementation Summary

The current code already has most of the needed pieces:

- The host persists an Iroh endpoint secret key in the host state file as `hostSecretKey`.
- The host persists paired clients by Iroh client node ID.
- Pairing tickets are short-lived and one-time.
- The iOS app persists its own Iroh endpoint key in Keychain.
- After a successful connection, the iOS app saves a `SavedHostRecord` in Keychain.
- The saved host record removes the one-time pairing secret.
- The iOS app can reconnect from the saved host record on later launches.

Important current behavior:

- If the app is launched with `--volt-iroh-ticket`, it uses that launch argument first.
- That means local development can accidentally force the fresh-QR path every run and hide the saved-host path.

## Desired Behavior

### First Pairing

When the user selects "Pair phone", the desktop host creates a one-time QR code containing:

- host connection information
- workspace name
- relay mode
- short expiry
- one-time pairing secret

The phone scans it and connects to the host. During the handshake:

- the phone proves it has the one-time secret
- the host records the phone's Iroh node ID as an allowed client
- the phone saves the host as a trusted host
- the phone saves a `SavedHostRecord` with no pairing secret

After this succeeds, the pairing QR can expire or be consumed.

### Reconnect

On app launch, if no explicit launch ticket is supplied, the app should:

1. Load the saved host from Keychain.
2. Bind its Iroh endpoint with the same saved phone identity.
3. Connect to the host using the saved host connection information.
4. Send a handshake without a pairing secret.
5. The host authorizes the phone by its persisted client node ID.

This is the normal path after first pairing.

### Host Restart

When the host service restarts, it should:

1. Load the same host state file.
2. Reuse the persisted `hostSecretKey`.
3. Recreate the Iroh endpoint with the same host identity.
4. Load the existing paired-client list.
5. Accept reconnects from already-paired phone node IDs.

The host should not print or display a fresh pairing QR merely because it restarted. It should offer a "Pair phone" action for adding new devices, but existing devices should not need it.

## State Responsibilities

### Host State

Persisted on the computer:

- host Iroh secret key
- known workspaces
- paired client node IDs
- client labels
- allowed workspaces per client
- allowed tools per client
- paired timestamp
- last-seen timestamp
- optional last session ID by workspace
- revoked client tombstones keyed by client node ID
- explicit re-pair approvals for revoked client node IDs, if any
- consumed pairing secret hashes
- pending pairing ticket hashes and non-secret metadata

The host should not persist raw pairing secrets.

Default host state path:

```text
~/.volt/agent/remote/iroh-host.json
```

CLI host, desktop app host, and future background service host should all use this same default path unless the user explicitly overrides it. If the user passes an explicit state path, saved reconnect only works for host launches that use that same path. Any future state path migration must preserve `hostSecretKey`, paired clients, workspace grants, and consumed/pending pairing metadata.

### Client State

Persisted on the client device:

- client Iroh endpoint secret key
- saved host record

`SavedHostRecord` should contain:

- stable host node ID
- host display name, if available
- relay mode
- saved workspace names or workspace grant reference
- endpoint discovery data needed by Iroh
- sanitized endpoint ticket data, if this remains the current Iroh implementation detail
- saved timestamp
- last connected timestamp, if available

The saved host record should not contain the one-time pairing secret. The product contract is a saved host identity and discovery record, even if v1 stores today's sanitized endpoint ticket as one internal field.

The iOS v1 app may support exactly one saved desktop host, but the storage shape should be able to evolve into multiple saved hosts later. App-specific storage, launch, offline-state, and Forget Host behavior is defined in `/Users/jordan.hans/Projects/volt-app/.volt/designs/iroh-saved-host-app-design.md`.

## QR Code Rules

Pairing QR codes should be:

- short-lived
- one-time use for new clients
- safe to discard after pairing
- generated on demand from the running host
- revocable indirectly by revoking the paired client after use

A pairing secret should be consumed only after a successful first pairing transaction. Failed connection or authorization attempts should not consume it. After one successful pairing, all later uses of that pairing secret should be rejected, including attempts from the same phone. Concurrent scans should allow at most one successful pairing.

Pairing QR codes should not be:

- reused as permanent credentials
- required for every app launch
- required for reconnect after host restart
- usable after the phone has already paired and saved the host

## Relay and Discovery

Mobile reconnect should default to Iroh relay/discovery mode because phones move between Wi-Fi, cellular, and constrained networks.

Target default for mobile pairing:

```bash
volt remote host --relay default
```

The ticket should include `relayMode: "default"` so the iOS app binds with compatible Iroh options.

## Local Development Guidance

When testing the desired flow:

1. Start the host with a persistent state path.
2. Scan the QR once.
3. Remove `--volt-iroh-ticket` from the iOS app launch arguments.
4. Relaunch the iOS app.
5. Verify that the app reconnects from the saved host.

If `--volt-iroh-ticket` is still present, the app will prefer that explicit ticket and may not exercise saved-host reconnect.

## Failure and Re-Pairing Cases

The user should need to scan again when:

- the phone app is deleted or its Keychain state is cleared
- the user taps "Forget Host"
- the desktop host state file is deleted
- the desktop user revokes that phone
- the host identity or host state is replaced
- the saved host record is malformed, references a different host identity, or the reached host no longer recognizes the phone

Changing workspace membership or permissions should not require re-pairing if the host identity and host state remain the same. If a saved host record references a workspace the host no longer exposes, the app should show a workspace unavailable or permission error rather than automatically sending the user through full pairing again.

The user should not need to scan again when:

- the app is force-quit and reopened
- the phone temporarily loses network
- the computer restarts
- the host service restarts with the same state path
- the host generates a fresh QR for another device after the user selects "Pair phone"

## Saved-Host Recovery Boundaries

Resolved 2026-06-22: ordinary offline hosts and stale discovery data are retryable saved-host states, not reasons to discard the saved host or force QR pairing.

Use these boundaries:

- `host_unreachable`: the app cannot open a transport to the saved host using the saved record and available Iroh discovery. Keep the saved host, show offline/retry, and do not offer QR scanning as the primary path. This covers the host process being stopped, the computer being asleep, temporary network loss, relay outage, and discovery lookup failure where no different host identity was reached.
- stale-but-refreshable discovery: the saved record is structurally valid and still names the authoritative host node ID, but its endpoint/discovery data is outdated. The app should keep the saved host, attempt Iroh discovery by the saved host node ID and relay mode, and refresh non-secret discovery fields after it reaches and verifies the same host identity. If refresh cannot reach the host, report `host_unreachable`, not `saved_host_invalid`.
- `host_identity_mismatch`: the app reaches a node whose cryptographic host node ID differs from the `SavedHostRecord` host node ID, or the host handshake proves a different identity. Stop automatic reconnect for that saved host, do not overwrite the saved host identity, and offer Pair Again or Forget Host.
- `saved_host_invalid`: the local saved host record cannot be parsed or lacks required v1 fields needed to identify and dial the host, such as a valid host node ID, supported relay mode, or usable discovery/ticket data. Do not attempt network reconnect from that record; offer Forget Host and Pair Again.
- `client_unknown`: the app reaches the saved host identity, but the host does not authorize the phone node ID. Keep the distinction from offline and invalid local data; offer Pair Again or Forget Host because host-side state no longer contains the phone relationship.
- `client_revoked`: the app reaches the saved host identity, but the host has a durable revocation tombstone for the phone node ID. Keep the saved host and phone endpoint identity, show that the phone was revoked by the desktop host, and offer Pair Again only after desktop approval plus Forget Host.
- `workspace_unavailable` and `workspace_forbidden`: keep the saved host. These outcomes are workspace access problems, not pairing or discovery failures.

## Revocation and Re-Pairing

Resolved 2026-06-22: revocation is a durable host-side block for a specific phone node ID, not only deletion from the paired-client list.

When the desktop user revokes a phone, the host should:

- remove the phone from the active allowed-client list
- close active connections from that node ID
- retain a revoked-client tombstone keyed by the phone node ID
- record enough non-secret metadata for status, audit, and future approval, such as label, revoked timestamp, previous paired timestamp, previous workspace grants, and previous allowed tools
- reject reconnects from that node ID with `client_revoked`
- reject fresh pairing attempts from that same node ID with `client_revoked` unless the desktop user explicitly approved re-pair for that revoked node ID

A generic "Pair phone" QR is approval to add a new phone. It is not, by itself, approval for a previously revoked node ID to come back. Re-pairing the same phone identity requires an explicit desktop action such as "Allow re-pair" for that revoked device. After that approval, the next successful pairing from the same phone node ID may reuse the existing phone endpoint identity and create a new paired-client record, replacing or clearing the revocation tombstone according to the host-state implementation.

The app should not rotate or clear its endpoint identity automatically when it receives `client_revoked` or `client_unknown`. Keeping the phone identity lets the host make an authoritative decision and lets a desktop-approved re-pair reuse the same phone node ID. The app should rotate or clear the endpoint identity only when the user intentionally removes local state, such as Forget Host in the one-host v1 app, app deletion, Keychain deletion, or a future explicit "Reset phone identity" action.

If the app has cleared its endpoint identity, the host cannot cryptographically connect the new node ID to the revoked tombstone. That device is treated as a new phone and still requires a fresh desktop-generated pairing QR. The product should not describe endpoint rotation as a way to bypass revocation.

## UX Requirements

Desktop host:

- Show host status and a "Pair phone" action for first setup and adding devices.
- Generate the QR only after the user selects "Pair phone".
- Explain that the QR is temporary.
- Show saved paired devices.
- Allow revoking a device.
- Show revoked devices separately from active paired devices.
- Offer an explicit re-pair approval action for a revoked device when the desktop user wants to trust the same phone identity again.
- Prefer labels like "Jordan iPhone" over raw node IDs when available.

iOS app:

- Show saved host status.
- Try saved-host reconnect on launch.
- Provide "Forget Host".
- Show useful errors:
  - host unavailable
  - phone revoked by this desktop
  - saved host invalid
  - pairing ticket expired

Detailed iOS UX and state behavior lives in `/Users/jordan.hans/Projects/volt-app/.volt/designs/iroh-saved-host-app-design.md`.

## Auth and Error Outcomes

The app needs stable machine-readable outcomes, not only human-readable error strings. These outcomes should drive whether the app retries, keeps the saved host, asks the user to pair again, or asks the user to inspect the desktop host.

Resolved 2026-06-22: reconnect UX must classify failures by saved-host recovery boundary. Offline and stale discovery keep the saved host; identity mismatch, revoked/unknown client, and invalid local records require explicit Pair Again or Forget Host decisions.

Suggested outcomes:

- `host_unreachable`: app could not reach the host. Keep the saved host and show offline/retry.
- `pairing_secret_expired`: QR expired before pairing. Ask the user to generate a new QR.
- `pairing_secret_consumed`: QR was already used. Ask the user to generate a new QR.
- `client_unknown`: saved host exists, but the host does not know this phone. Offer Pair Again or Forget Host.
- `client_revoked`: phone was revoked by the desktop host. Keep the saved host and phone endpoint identity; offer Pair Again only after desktop approval, plus Forget Host.
- `workspace_unavailable`: requested workspace is no longer exposed by the host. Keep the saved host and show workspace unavailable.
- `workspace_forbidden`: phone is paired but not allowed for that workspace. Keep the saved host and show permission denied.
- `host_identity_mismatch`: saved host record reached a different host identity. Stop reconnecting and offer Pair Again or Forget Host.
- `saved_host_invalid`: local saved host record is malformed or unusable. Offer Forget Host and Pair Again.

## Implementation Plan

1. Verify current saved-host path end to end.
   - Pair once.
   - Relaunch app without `--volt-iroh-ticket`.
   - Confirm reconnect succeeds.

2. Make local development workflow explicit.
   - Document that launch-argument tickets bypass saved-host reconnect.
   - Consider an Xcode scheme or helper script that launches without `--volt-iroh-ticket`.

3. Make host startup reconnect-friendly.
   - Ensure the default host state path is stable.
   - Ensure `hostSecretKey` is reused.
   - Prefer `--relay default` for mobile-facing host commands.

4. Improve pairing UX.
   - Treat QR generation as an explicit "Pair phone" action.
   - Add or polish `volt remote pair` for generating new pairing QR codes from a running host.
   - Keep existing clients authorized through saved state.

5. Improve status and diagnostics.
   - Host should expose paired device list and revoke controls.
   - App should distinguish "needs pairing" from "host offline" and "revoked".

6. Validate host restart.
   - Pair phone.
   - Stop host.
   - Restart host with same state path and relay mode.
   - Open app and reconnect without scanning.

## Test Plan

Host/core tests:

- Existing paired client reconnects without `secret`.
- New unpaired client without `secret` is rejected.
- Consumed pairing secret cannot pair a second client.
- Failed pairing attempt does not consume the pairing secret.
- Concurrent pairing attempts allow at most one successful pairing.
- Expired pairing secret is rejected.
- Host restart with same state authorizes existing client node ID.
- Host restart with deleted state requires re-pairing.
- Revoked client cannot reconnect.
- Revoked client cannot re-pair with the same node ID until desktop approval.
- Desktop-approved re-pair can reuse the same phone node ID.

iOS tests:

- See `/Users/jordan.hans/Projects/volt-app/.volt/designs/iroh-saved-host-app-design.md`.

Manual smoke test:

1. Start host with `--relay default`.
2. Launch app with QR ticket and scan/connect.
3. Confirm saved host appears in Settings.
4. Kill and relaunch app without launch ticket.
5. Confirm app reconnects without scan.
6. Restart host with same state path.
7. Confirm app reconnects without scan.
8. Revoke phone on host.
9. Confirm app can no longer reconnect until re-paired.

## Acceptance Criteria

- A user can pair the iOS app to a desktop host by scanning one QR code.
- A paired phone reconnects after app restart without scanning.
- A paired phone reconnects after host restart without scanning when the same host state is reused.
- The QR remains short-lived and one-time for new pairings.
- The host can list and revoke paired phones.
- The iOS app can forget a saved host.
- Development launch arguments do not obscure the saved-host path during testing.

## Resolved Design Questions

### Should the product default for mobile host setup always be `--relay default`?

Yes. Mobile-facing host setup should default to `--relay default`.

Phones frequently move between Wi-Fi, cellular, VPNs, hotspots, and sleep/wake network states. A local-only default would make reconnect feel unreliable for normal phone use. Relay-capable setup should be the product default, while LAN-only mode can remain available as an explicit advanced option.

### Should the desktop host print a QR on every startup, or only when the user chooses "Pair phone"?

Only when the user chooses "Pair phone".

The QR is a temporary invite for adding a new device. Printing it every startup makes pairing look like a required reconnect step and creates unnecessary active invites. Startup can show that no phone is paired yet and offer a "Pair phone" action, but QR generation should be tied to that explicit user action.

### Should saved reconnect use the current endpoint ticket format, or do we need a more stable host identity/discovery ticket for stronger restart/network-change behavior?

Saved reconnect should use a stable saved-host record.

`SavedHostRecord` is the product model. It should contain the stable host node ID, relay mode, workspace grant reference or workspace names, endpoint discovery data, saved timestamp, optional last connected timestamp, and no pairing secret.

The current sanitized endpoint ticket can be one internal field in the v1 record if it proves reliable across host restarts with the same host key, state path, and relay mode. The product contract should still be "saved host identity and discovery," not "reuse the original QR." If endpoint-ticket reuse is brittle, replace that internal field with stronger discovery data without changing the user-facing flow.

### Should one desktop host support multiple named workspaces under a single saved phone relationship?

Yes, the design should make multiple workspaces easy to support later.

The first implementation may pair a phone to one workspace, but the durable relationship should be between the phone and the desktop host identity. Workspace access should remain a permission on that relationship. The host state and app model should avoid one-folder-only assumptions so a paired phone can later be granted access to multiple named workspaces without rethinking pairing.

### What should the app show when the saved host exists but the host service is not currently running?

The app should show a saved-host offline state, not a pairing failure.

Suggested copy:

- Status: "Host offline"
- Detail: "Volt is paired with this computer, but the host service is not reachable."
- Primary action: "Retry"
- Secondary action: "Forget Host"
- Optional guidance: "Start Volt on your computer to reconnect."

The QR scanner should not be the main path from this state. Offline means the saved relationship may still be valid. Re-pairing should be reserved for explicit user choice, revoked clients, deleted state, or invalid saved-host data.

### Where is the boundary between offline, stale discovery, identity mismatch, and invalid saved-host data?

Resolved 2026-06-22: the authoritative saved-host identity is the saved host node ID. A well-formed saved host with that node ID stays saved through offline and stale-discovery failures. The app should retry and refresh non-secret discovery data when it can verify the same host identity. It should only leave the normal reconnect path when local data is malformed or unsupported (`saved_host_invalid`), when a reached host proves a different node ID (`host_identity_mismatch`), or when the reached saved host rejects the phone relationship (`client_unknown` or `client_revoked`).

### Can a revoked phone re-pair with the same phone identity?

Resolved 2026-06-22: not silently. The host must keep a revocation tombstone for the phone node ID and reject both saved reconnect and fresh pairing from that node ID with `client_revoked` until the desktop user explicitly approves re-pair for that revoked device. After desktop approval, the app may re-pair with the same phone endpoint identity. The app should not rotate endpoint identity automatically for `client_revoked`; it clears endpoint identity only when the user intentionally removes local state, such as Forget Host in the one-host v1 app, app deletion, Keychain deletion, or a future explicit reset identity action.
