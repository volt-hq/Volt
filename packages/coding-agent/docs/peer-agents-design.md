# Peer Agents (experimental)

## Status

Spike. A terminal conversation can delegate a task to the agent of another person's Volt on the local network and get that agent's final reply back as a tool result. Off by default; permissions beyond what pairing already provides are deferred.

## Usage

On the peer host (Bob), create a pairing ticket for the workspace the delegated tasks should run in. The access preset is the peer's grant on Bob's machine:

```bash
volt remote pair --workspace shared-api --access coding   # or review for read-only tools
```

On the delegating host (Alice), pair as a peer with that ticket, then turn on the tool in global settings (`~/.volt/agent/settings.json`):

```bash
volt remote peer add bob '<ticket>'
volt remote peer list
volt remote peer remove bob
```

```json
{ "remote": { "peers": true } }
```

Alice's agent can then call `peer` without arguments to list peers, or with `{ "peer": "bob", "task": "..." }` to delegate. Bob sees the task's conversation in his session list (`volt -r`) and can attach to it while it runs.

## Design

- **Transport.** Alice's daemon dials Bob's daemon over Iroh with the existing remote protocol (`volt/1`): handshake, then protocol 1 frames on the remote profile. Bob's side is unchanged; Alice's daemon is one more paired client to it.
- **Identity.** Alice's daemon dials from a client-only endpoint of its own (`daemon/peers.json`, 0600: secret key and saved peers), separate from its phone-facing host identity. Relays are disabled on this endpoint, so peers reach each other over direct (LAN) addresses only. Bob's host tickets always carry direct addresses, whatever its relay mode.
- **Pairing.** `peer_add` redeems the one-time secret on a `workspaceDiscovery` stream, verifies the host node ID against the ticket, and saves `{name, hostNodeId, irohTicket, workspace}`.
- **Runs.** The tool runs in Alice's conversation worker and sends `worker_peer_run` to its daemon. The daemon opens a `target:new` conversation stream on Bob's host, sends the task as a `prompt` intent, waits until the conversation is idle (up to 60 minutes), and answers with the last assistant transcript item. Abort on Alice's side sends `worker_peer_cancel`; the daemon sends `abort` to Bob's conversation, then closes the stream. A closed stream alone only detaches.
- **Loops.** Bob's conversation is phone-origin on his host, which never offers the `peer` tool, so delegation is one hop.
- **Scope of the tool.** Only TUI-opened conversations get it (subagents included), and only when global settings enable it.

## Security model

- Bob's pairing ticket is the explicit allow. With `coding` access, Alice's tasks can run `bash`, `edit`, and `write` on Bob's machine as Bob. `review` limits them to read-only tools. Bob revokes Alice with `volt remote revoke <node-id>` (her daemon is labeled `peer:<hostname>` in `volt remote clients`).
- Prompt injection crosses machines: anything Alice's agent read can end up in a task Bob's agent executes. The tool's guidelines tell the model to treat replies as untrusted data, which is a mitigation, not a boundary.
- Bob's model, credentials, and tokens pay for delegated work.

## Limits

- LAN only. A peer host whose direct port changes after a restart must issue a new ticket (`volt remote peer remove` then `add`).
- No streaming progress: the tool returns only the final reply, bounded by the remote profile (12,000 scalars, marked truncated beyond that).
- The peer agent cannot ask Alice questions (`request_user_input`, dialogs); the run's client answers no host requests.
- Standalone binaries do not bundle Iroh, so peers need npm or source installs, as phone pairing does.

## Next steps

Candidate follow-ups, not started: a peer-specific access preset and per-peer tool ceiling on the peer host, an asynchronous message mode, presence and discovery (mDNS in the Iroh wrapper), streaming progress into the tool's presentation, and a dedicated audit event for delegated runs.
