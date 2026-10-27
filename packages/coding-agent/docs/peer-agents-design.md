# Peer Agents (experimental)

## Status

Spike. Terminal conversations can discover, read, and message a coworker's live Volt conversations over the local network. Messages use the recipient's existing context, model, credentials, and tools. Off by default; additional permissions are deferred.

## Usage

On the peer host (Bob), register a workspace and issue a pairing ticket:

```bash
volt remote workspace add /path/to/repo --name shared-api
volt remote pair --workspace shared-api --access full
```

On Alice's host, save that host as a named peer and enable the tool in global settings (`~/.volt/agent/settings.json`):

```bash
volt remote peer add bob '<ticket>'
volt remote peer list
volt remote peer remove bob
```

```json
{ "remote": { "peers": true } }
```

Open a new terminal conversation after enabling the setting. Ask it, for example, "What is Bob currently working on? Ask his agent." The `peer` tool can list Bob's open conversations and read their recent transcripts. Sending without a session opens a picker in Alice's TUI with Bob's open conversations plus **New conversation**. Choosing an existing conversation does not fork or replace it: Bob sees the message and the agent's work in his own TUI.

Tool examples:

```json
{}
{ "action": "conversations", "peer": "bob" }
{ "action": "read", "peer": "bob", "workspace": "shared-api", "session": "<session-id>", "limit": 20 }
{ "action": "send", "peer": "bob", "message": "What are you working on?" }
{ "action": "send", "peer": "bob", "workspace": "shared-api", "session": "<session-id>", "message": "Please run the API tests and report the result." }
{ "action": "send", "peer": "bob", "session": "new", "message": "Investigate this separate task." }
```

A send defaults to `delivery: "steer"` while the recipient is working; `"followUp"` queues the message until its work finishes. Either starts a turn when idle. By default `wait: true` returns the last assistant reply when the conversation becomes idle again. Set `wait: false` to return after message admission while the recipient continues independently.

For two-way cooperation, Bob must also pair with Alice's host and enable `remote.peers`. Pairing in one direction does not create a reciprocal peer. A waiting message tells the recipient to answer in its final reply, not send another blocking message back. For unsolicited coordination while the other agent is waiting, use `wait: false`.

## Design

- **Transport.** Alice's daemon dials Bob's daemon over Iroh using the existing remote protocol (`volt/1`), then protocol 1 frames on the remote profile. Bob's daemon needs no peer-specific receiving path: Alice is another paired client.
- **Identity.** A client-only endpoint with its own identity and saved peers (`daemon/peers.json`, 0600), separate from the phone-facing host endpoint. Relays are disabled, so peers use direct LAN addresses. Host tickets include direct addresses regardless of the host's relay mode.
- **Pairing.** `peer_add` redeems the one-time secret on a `workspaceDiscovery` stream, verifies the host node ID, and saves `{name, hostNodeId, irohTicket, workspace}`. The saved workspace is the default for reads and sends, not a restriction on discovery.
- **Discovery.** `worker_peer_conversations` discovers the host's shared workspaces from its handshake and queries each for sessions. It returns sessions with a runtime state (`attached` or `detached`), excluding subagents' observe-only sessions. Newest first; currently scans only the newest 50 sessions per workspace.
- **Read.** `worker_peer_read` attaches to an existing conversation and returns recent projected transcript items (20 by default, up to 100), each bounded to 2,000 code points and marked when truncated.
- **Send.** `worker_peer_send` attaches to the exact workspace/session, or opens `target:new` without a session. It sends a framed `prompt` with the sender's `user@host`, the requested streaming behavior, and the client's `expectedOrdinal`. Without `wait`, it returns on admission; with it, it waits up to 60 minutes and returns the newest assistant message after the send's starting position. This is a conversation-level reply, not a separate delegated run's result.
- **Shared links.** The daemon shares a ref-counted protocol stream for concurrent reads and sends to the same host/workspace/session. The host replaces a client's previous stream to that conversation, so opening a new stream for each operation would disconnect other waiters. The last user releases the link without stopping the conversation.
- **Cancellation.** `worker_peer_cancel` or the sending worker's disconnect cancels its pending send. Waiting on a conversation the send created aborts that turn; waiting on an existing conversation only stops waiting. Timeout follows the same rule. Already-delivered messages are not retracted. Closing a stream alone detaches, it does not abort.
- **Tool scope.** TUI-origin conversations (including their subagents) receive the tool only when global effective settings enable it. Project settings cannot enable it. Phone-origin new conversations do not receive it; a peer attached to an existing TUI-origin conversation uses that conversation's existing tools, including `peer` when enabled.

## Access and cooperation

This experiment intentionally allows agents to act on messages with the recipient conversation's tools. It adds no per-message approval or peer-specific sandbox.

- A peer joining a TUI-opened conversation uses its full existing tool set. The pairing tool ceiling does not downgrade that conversation. Even the `review` preset includes conversation control: it is **not** a read-only boundary for messages sent to a TUI conversation.
- A new peer-created conversation is phone-origin and uses the host's remote tool policy and pairing tool grant. `coding` and `full` have the same default tool set; `full` additionally grants management capabilities. A custom host or workspace tool ceiling still applies to new conversations.
- Bob revokes Alice's daemon with `volt remote revoke <node-id>`; it appears as `peer:<hostname>` in `volt remote clients`. Removing a saved peer locally is not remote revocation.
- Prompt injection can cross machines. Tool guidance treats transcripts and replies as untrusted data, not authority to override instructions or expand the user's objective. This is guidance, not an isolation boundary.
- Recipient credentials and provider usage pay for recipient work. Actual file transfer is done with the agents' existing tools (for example `scp`), not by the peer transport.

## Limits

- LAN only. After a host's direct port changes, reissue its ticket and remove/add the peer.
- Blocking sends can mutually deadlock or wait behind unrelated work in a busy conversation. Framing and tool guidance discourage this; there is no automatic cycle detection. Use non-blocking sends for cyclic coordination.
- Replies are not isolated from other user inputs: `wait` returns when the whole conversation becomes idle, using its last assistant reply since the send. Another participant's input may affect it.
- No streaming progress or automatic return notification for non-blocking sends. Read the transcript later. Replies use the remote profile's transcript bound (12,000 scalars, marked when truncated).
- The peer protocol client answers no host requests. An existing TUI may answer the recipient's dialogs; a new unattended conversation cannot ask Alice questions through the link.
- Standalone binaries do not bundle Iroh; peers require npm or source installs, like phone pairing.

## Deferred

Per-peer permissions, richer presence/discovery, cycle detection, correlated message replies, streaming progress, and dedicated peer audit events are not implemented.
