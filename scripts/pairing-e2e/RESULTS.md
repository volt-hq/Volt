# Fresh-install pairing evidence — 2026-09-14

The private simulator lane passed. This is **not** physical-device Apple/Firebase
release acceptance, a published CLI package test, or a paid model-inference test.

## Run

- Rig: `/tmp/volt-pairing-run-20260914h`, container prefix `volt-e2e-e6d851a1`.
- Real TLS broker: `https://127.0.0.1:18443`; JWT-only Iroh relay:
  `https://127.0.0.1:19443`; real PostgreSQL.
- CLI: private bundle of the current checkout over the fresh private npm base
  image; local Linux arm64 CA-capable binding. No host HOME, credentials,
  workspace preregistration, daemon prestart, or Volt runtime overrides.
- App: staged Debug arm64 simulator build, normal ad-hoc signing, on `Volt-E2E`
  (`3F3766D2-D7F3-42DC-A935-2565841E5EA3`). A fresh build-time bundle ID,
  `com.hansjm10.volt.pairing-e2e.h`, isolated app data and Keychain from earlier
  failed trials without erasing any simulator. Its staged proof-provider guard
  used that exact ID; the ordinary app/project was not changed.
- Native inputs: `.3`-based private Swift binding and Linux Node binding described
  by the native source manifest. Published dependency/release pins are unchanged.

## Observed workflow

1. Infrastructure verification passed: trusted HTTPS, rejection without the CA,
   isolated topology, empty CLI HOME, no Volt overrides, and actual native relay
   rejection with `authorization header missing`.
2. Started **bare `volt`** in `/workspace` through isolated tmux. In `/remote`,
   chose **Start daemon**, **Register current directory**, **Pair a phone**, and
   **Coding**. The UI created the daemon, workspace, and TUI-owned conversation.
3. Copied the ticket through the UI's OSC52 clipboard action. Camera-free launch
   input populated the app; automatic managed pairing correctly refused to proceed
   without confirmation. Reviewed the matching fingerprint
   `9E6E2233-72C7BB0F-84DFE46A-1BF4EDE0`, workspace, and exact relay origin.
   Before confirmation, PostgreSQL had **0 endpoints and 0 consumed App Check proofs**.
4. Confirmed in the app. Pairing succeeded. PostgreSQL recorded one approved and
   exchanged claim, one consumed synthetic App Check proof, assertion counter 1,
   and two unrevoked endpoints (host/app) sharing one grant.
5. App Workspaces displayed `workspace` and `Computer reachable`. Named the TUI
   conversation `Fresh Docker pairing` with `/name`, then ran the harmless local
   command `!printf "pairing-e2e-marker\n"` to create durable transcript content.
   From the app's Recent Sessions, opened that exact TUI conversation and observed
   its completed command and result. No provider credentials were introduced.
6. Stopped the selected app, then relaunched it **without arguments or a ticket**
   at 15:53:15 UTC, after the original ticket expired at 15:52:23 UTC. It reopened
   the same selected conversation, showed Ready, and retained the command result.
   Host/app node identities, grant, and TUI lease/session ID were unchanged.

## Independent evidence

Private run files `before-cold.json` and `after-cold.json` contain only selected
non-secret broker rows, relay counters, and daemon status. The latter records:

- One phone connection and one paired client.
- Same TUI-owned session `01a0a094-0faf-7a07-9cb3-976f772bf58f`, with one relay attachment.
- Relay sent bytes: **149,984 → 193,312** across cold reconnect.
- Relay received bytes: **153,584 → 197,422**.
- Relay packets sent: **306 → 406**; received: **309 → 419**.
- Broker approval/exchange/proof counts remained **1**, not a second pairing.

The relay only admits valid JWTs; positive relay packet counters establish actual
relay traffic, not merely successful direct peer connectivity. A screenshot of
the post-reconnect transcript result is retained as `cold-transcript.jpg` in the
private run directory. No tickets, JWTs, refresh tokens, or proof secrets belong
in this report.

## Fixes and validation

The initial native ticket had only a Docker-private UDP address because the host
had not enrolled for relay credentials yet. Normal daemon ticket generation now
includes its first configured relay when no observed home relay exists. Observed
home relays, endpoint identity, direct addresses, relay-free mode, the wire format,
and all authentication checks remain unchanged.

- Three native ticket round-trip regressions passed.
- Thirteen daemon credential-recovery tests passed after updating their native mock.
- Eight private builder/rig tests passed.
- `npm run check` and the coding-agent build passed. Existing informational lint
  suggestions and three platform-specific launcher skips remain.
- Private simulator build and real enrollment/transport/cold reconnect passed.
  Earlier private-profile simulator tests covered exact broker/ticket authorities
  and native invalid-CA rejection followed by successful bind/close.

The isolated CLI cannot download optional `fd`/`rg` helpers or discover provider
models without public networking/credentials. Those expected warnings did not
block pairing or transcript sharing. Model inference and push are outside this lane.

## Reproduction and lifecycle

Follow [RIG.md](RIG.md) and the app's `scripts/pairing-e2e/README.md`. Build the CLI
before `rig.mjs up`, which embeds the current private bundle. Use a fresh rig and
fresh app identity; do not reuse expired proof authority. The app README documents
the exact build-time bundle override used here when simulator erasure is unavailable.
Use `launch_app_sim.launchArgs` for camera-free input: the installed `type_text`
automation changed the ticket's `+` to `=`, while launch arguments preserved it.
UI fingerprint confirmation remains mandatory.

After evidence capture, stop the private app and use `rig.mjs down` for the exact
run. This removes only label-verified rig resources, not the development daemon,
other containers, or simulators. Local nonpublishable artifacts remain private.
