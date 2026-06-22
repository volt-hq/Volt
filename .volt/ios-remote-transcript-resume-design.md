# iOS Remote Transcript Resume Design

## Status

Complete.

## Problem

The iOS app can resume a saved Iroh host, start a fresh conversation, list current-workspace sessions, and switch to a session by ID. After reconnect or `switch_session_by_id`, the app currently refreshes session state but does not load the prior transcript. The UI therefore looks empty even though the host has resumed the selected session.

## Goals

- Load prior transcript content after reconnect and session switch.
- Keep transcript access scoped to the active authorized workspace/session.
- Avoid exposing host session file paths or raw internal session payloads.
- Return UI-ready transcript items that the iOS app can render directly.
- Preserve existing Iroh outbound redaction guarantees for host-local paths.
- Support pagination so the initial load can stay bounded.

## Non-goals

- Do not expose raw `get_messages` over Iroh.
- Do not add arbitrary host session file access.
- Do not replay historical streaming deltas.
- Do not return full raw bash output, full file contents, or provider/internal payloads.
- Do not implement full transcript search in this phase.

## Design Summary

Add a new remote-safe RPC command, `get_transcript`, that returns a projected transcript for the active session only. The host builds transcript items from the current session entries, redacts host paths, bounds large fields, and returns items oldest-to-newest. The iOS app calls `get_transcript` after reconnect and after successful session switch.

## RPC Protocol

### Command

```json
{"type":"get_transcript","limit":100}
```

Optional pagination:

```json
{"type":"get_transcript","limit":100,"beforeEntryId":"entry-id"}
```

Rules:

- `limit` defaults to 100.
- Server caps `limit` at 200.
- `beforeEntryId` requests entries older than the specified transcript/session entry ID.
- The response is ordered oldest-to-newest for direct UI append.

### Response

```json
{
  "type": "response",
  "command": "get_transcript",
  "success": true,
  "data": {
    "sessionId": "abc123",
    "items": [
      {
        "id": "entry-id-1",
        "role": "user",
        "text": "User prompt",
        "timestamp": "2026-06-22T15:00:00.000Z"
      },
      {
        "id": "entry-id-2",
        "role": "assistant",
        "text": "Assistant response",
        "timestamp": "2026-06-22T15:01:00.000Z"
      },
      {
        "id": "entry-id-3",
        "role": "tool",
        "toolName": "read",
        "status": "completed",
        "path": "/workspace/src/file.ts",
        "summary": "Read /workspace/src/file.ts",
        "timestamp": "2026-06-22T15:01:30.000Z"
      },
      {
        "id": "entry-id-4",
        "role": "summary",
        "title": "Conversation compacted",
        "text": "Earlier conversation summary...",
        "timestamp": "2026-06-22T15:02:00.000Z"
      }
    ],
    "hasMore": false,
    "nextBeforeEntryId": null
  }
}
```

## Transcript Item Shape

Common fields:

- `id`: stable session entry ID.
- `role`: `user`, `assistant`, `tool`, or `summary`.
- `timestamp`: ISO timestamp from the session entry.

User/assistant items:

- `text`: rendered text content only.
- Image references and non-text payloads are omitted in this phase.

Tool items:

- `toolName`: tool name.
- `status`: `started`, `completed`, or `failed` when known.
- `path`: redacted workspace-relative path when available.
- `summary`: bounded display summary.
- `diffPreview` or `patchPreview`: optional bounded previews for code mutation tools.

Summary items:

- Created from compaction summary entries.
- Rendered as collapsed/collapsible system-style items in iOS.
- Title should be `Conversation compacted`.
- Summary text should be bounded.

## Security and Privacy

- Keep `get_messages` blocked over Iroh.
- `get_transcript` returns only the active session selected by the host runtime.
- Session file paths are never returned.
- Path values must pass through the same remote outbound redaction used for Iroh state/events.
- Tool output is summarized and bounded.
- Full bash output, raw file contents, provider payloads, thinking blocks, and extension-private custom data are not returned.
- `switch_session` remains blocked remotely; session selection continues through `switch_session_by_id`.

## Host Implementation Plan

1. Add RPC types:
   - `get_transcript` command with optional `limit` and `beforeEntryId`.
   - `RpcTranscriptItem` and `RpcTranscriptResponse` types.
2. Add a transcript projection helper over current `SessionManager` entries.
3. Add `get_transcript` handling in `rpc-mode.ts`.
4. Allow `get_transcript` in the Iroh remote command filter.
5. Add `get_transcript` to remote response-completion tracking.
6. Apply existing Iroh outbound sanitizer/decorator to transcript responses.
7. Document in `docs/rpc.md` and `docs/iroh-remote-protocol.md`.

## iOS Implementation Plan

1. Add `VoltRPCCommand.getTranscript(limit:beforeEntryID:)`.
2. Add response parsing for transcript items.
3. Add transcript loading state.
4. On connect/reconnect success:
   - Send `get_state`.
   - Send `get_transcript`.
5. On `switch_session_by_id` success:
   - Clear visible transcript to a loading placeholder.
   - Send `get_state`.
   - Send `get_transcript`.
6. On `new_session` success:
   - Keep the fresh empty transcript behavior.
   - Refresh state only.
7. Render summary items collapsed or visually distinct from normal assistant messages.
8. Add a top-of-list load-older control using `beforeEntryId`.

## Testing Plan

Host tests:

- `get_transcript` returns current-session transcript items oldest-to-newest.
- `limit` is capped and pagination with `beforeEntryId` works.
- Compaction summaries become `summary` items.
- Tool items include bounded summaries and mutation previews.
- Raw `get_messages` remains blocked over Iroh.
- `get_transcript` is allowed over Iroh.
- Path-based `switch_session` remains blocked over Iroh.
- Switching by session ID then calling `get_transcript` returns the switched session.
- Transcript response does not expose session file paths.

IOS tests:

- Connect flow requests state and transcript.
- Session switch success clears current UI, refreshes state, and requests transcript.
- New session success does not request prior transcript.
- Transcript response maps user, assistant, tool, and summary items into `TranscriptItem`.
- Pagination state stores `nextBeforeEntryId`.

## Implementation Notes

- Resolved 2026-06-22: Host `get_transcript` RPC projection, Iroh exposure, protocol docs, and coding-agent tests are implemented while keeping raw `get_messages` and path-based `switch_session` blocked.
- Resolved 2026-06-22: iOS B.1 client support is implemented: `VoltRPCCommand.getTranscript(limit:beforeEntryID:)`, transcript response parsing into `TranscriptItem`, loading/pagination state, mock transport support, and Swift package tests for command encoding plus invalid-item-safe response mapping.
- Resolved 2026-06-22: iOS B.2 resume behavior is implemented: connect/reconnect sends `get_state` then `get_transcript`, session switch shows a loading transcript placeholder then refreshes state/transcript, and new-session handling keeps the fresh conversation path without requesting old transcript.
- Resolved 2026-06-22: iOS B.3 pagination is implemented: `loadOlderTranscript` requests older pages with `beforeEntryId`, response handling prepends older items without duplicate transcript entry IDs, and the chat view exposes a top-of-list load-older control when more transcript is available.
- Resolved 2026-06-22: C.1 documentation is updated across RPC docs, Iroh remote protocol docs, this design ledger, and the iOS app README to describe `get_transcript`, reconnect/session-switch loading, fresh-session behavior, pagination limits, and the remote security boundary.
- Resolved 2026-06-22: C.2/C.3 final validation passed: targeted coding-agent transcript/RPC/Iroh tests, Iroh POC scenario tests, `npm run check`, Swift package tests, iOS simulator tests, and doc diff checks all completed successfully. No separate manual smoke was run beyond automated connect/reconnect, session switch, transcript mapping, and pagination coverage.

## Decisions

- Include compaction summaries as summary/system-style transcript items.
- Include safe tool summaries, plus bounded diff/patch previews for code mutation tools.
- Use latest 100 transcript items by default.
- Cap server responses at 200 items.
- Return items oldest-to-newest.
- Keep `get_messages` blocked remotely.
- Keep `switch_session` blocked remotely.
