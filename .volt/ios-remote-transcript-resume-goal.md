<goal name="ios-remote-transcript-resume">

<context>
This file is the operating manual and work ledger for a Volt /goal run that adds
remote-safe transcript loading to the iOS app after reconnect and session switch.
The paired design document is `.volt/ios-remote-transcript-resume-design.md`; treat
that file as the SPEC and this file as the TURN LEDGER. Update both files when a
queue item is resolved or when the implementation reveals a necessary design change.

Suggested goal prompt:
/goal Work through .volt/ios-remote-transcript-resume-goal.md, exactly one queue
item per goal turn, following the protocol in that file. Do not mark the goal
complete until every item in its work_queue has status="resolved". Commit only
files changed for the selected item, by explicit path, when committing is safe
under the repo rules; if commit ownership or target repo is unclear, stop before
committing and list the exact paths ready to stage.
</context>

<turn_definition>
A turn is one agent run from start until the final response is sent and the agent
becomes idle. Exactly ONE selectable work_queue item is worked per turn. If the
selected item finishes quickly, still stop after updating ledgers and committing
(or stopping before commit when commit safety is unclear). Do not start another
item in the same turn.
</turn_definition>

<protocol>
  <step n="1" name="preflight">
    Run `git status --short` in `/Users/jordan.hans/Projects/Volt` and
    `git -C ../volt-app status --short`. Confirm the only unrelated dirty files
    are the out-of-scope files named in working_tree_rules, plus any in-progress
    files from a prior partial turn on the item you are about to re-select. If
    any other surprise dirty file exists, do not select an item: report the
    unexpected state and stop the turn.
  </step>

  <step n="2" name="select">
    Read the work_queue below. Select the FIRST item with status="open" whose
    prereq items, if any, all have status="resolved". Treat status="blocked" as
    not selectable. Items with type="rollup" are never selected directly; see
    rollup_rule. Work only the selected item this turn.
  </step>

  <step n="3" name="read_spec">
    Read `.volt/ios-remote-transcript-resume-design.md` and the selected item's
    relevant sections in full. Also read current implementation files that own the
    behavior before editing them. Expected areas include:

    - `packages/coding-agent/src/core/rpc/types.ts`
    - `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
    - `packages/coding-agent/src/core/agent-session-runtime.ts`
    - `packages/coding-agent/src/core/session-manager.ts`
    - `packages/coding-agent/src/core/remote/iroh/`
    - `packages/coding-agent/src/modes/rpc/iroh-remote-rpc-mode.ts`
    - `packages/coding-agent/src/remote/iroh-host.mjs`
    - `packages/coding-agent/docs/rpc.md`
    - `packages/coding-agent/docs/iroh-remote-protocol.md`
    - `../volt-app/Packages/VoltClient/Sources/VoltClient/RPC/VoltRPC.swift`
    - `../volt-app/Packages/VoltClient/Sources/VoltCore/VoltSession.swift`
    - `../volt-app/Volt/ChatView.swift`
    - `../volt-app/Volt/SettingsView.swift`

    Use LSP tools per &lt;lsp_usage/&gt; for semantic TypeScript questions before
    changing shared symbols. For Swift files, read the owning files and run the
    Swift verification commands because Swift LSP may not be available.
  </step>

  <step n="4" name="implement">
    Implement the SPEC behavior faithfully for the selected item and add or extend
    tests that would have failed before the change and pass after it. Preserve the
    remote security boundary: do not expose raw `get_messages` over Iroh, do not
    return session file paths, keep transcript loading scoped to the active
    authorized workspace/session, and bound large transcript fields.
  </step>

  <step n="5" name="verify">
    After editing TypeScript files, run `lsp.diagnostics` on each changed TS/TSX
    file and fix reported diagnostics before launching slower verification. Then
    run the commands in &lt;verification/&gt;. All required checks for changed files
    must pass before the item may be marked resolved. If a required environment is
    unavailable, follow blocked_rule instead of pretending a proxy check covers it.
  </step>

  <step n="6" name="update_ledgers">
    All dates in both ledgers use YYYY-MM-DD format.

    `.volt/ios-remote-transcript-resume-design.md`: update the relevant section
    with `Resolved YYYY-MM-DD:` plus the concrete behavior when an item is
    resolved. Do not silently delete unresolved requirements; if the selected item
    reveals new scope, add a new open item instead.

    This file: set the selected item status="resolved" and fill its &lt;evidence&gt;
    with one concise line containing what changed, what verification ran, and the
    commit SHA when a commit was made. For partial progress, follow
    partial_progress_rule instead.
  </step>

  <step n="7" name="commit">
    If committing is safe under the repo rules, stage only files changed for the
    selected item, by explicit path. Never use `git add -A` or `git add .`.

    If the selected item changes both `/Users/jordan.hans/Projects/Volt` and
    `../volt-app`, commit them separately in their respective repositories unless
    the user requested otherwise. Ask before committing or pushing if scope,
    target branch, remote, or ownership is unclear.

    Suggested commit message formats:
    Volt code: `fix(coding-agent): add remote transcript loading &lt;ref&gt;`
    Volt docs: `docs(coding-agent): record remote transcript design &lt;ref&gt;`
    iOS app: `fix: add remote transcript loading &lt;ref&gt;`

    If not committing, leave the item status open unless the user explicitly
    accepts non-committed ledger updates; report the exact paths ready to stage
    and stop.
  </step>

  <step n="8" name="stop">
    Summarize what changed and what verification ran, then end the turn.
  </step>
</protocol>

<verification>
  <when_changed kind="volt_code">npm run check</when_changed>
  <when_changed path="packages/coding-agent/test packages/coding-agent/src">cd packages/coding-agent; node node_modules/vitest/dist/cli.js --run &lt;specific changed or affected test files&gt;</when_changed>
  <when_changed path="packages/coding-agent/src/core/remote/iroh packages/coding-agent/src/modes/rpc packages/coding-agent/src/remote/iroh-host.mjs">npm run iroh:poc:test</when_changed>
  <when_changed path="packages/coding-agent/docs .volt">git diff --check -- &lt;changed docs paths&gt;</when_changed>
  <when_changed path="../volt-app/Packages/VoltClient">cd ../volt-app/Packages/VoltClient &amp;&amp; swift test</when_changed>
  <when_changed path="../volt-app/Volt ../volt-app/VoltTests ../volt-app/Volt.xcodeproj">cd ../volt-app &amp;&amp; xcodebuild -scheme Volt -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0' test</when_changed>
  <notes>
    `npm run check` is required after Volt code changes and must be run from the
    Volt repo root. If a test file is created or modified, run the specific test
    file and iterate until it passes before broader checks. For the iOS app, if
    the named simulator is unavailable, choose an available iOS simulator and
    record the exact destination used.
  </notes>
</verification>

<lsp_usage>
Volt has LSP tools available through the `lsp` tool with actions such as
`definition`, `references`, `hover`, `symbols`, `diagnostics`, `rename`, and `fix`.
Prefer LSP over grep/read whenever the question is semantic: who calls this, where
is this symbol defined, what type is this, or what breaks if this signature changes.

Per-turn usage:

- Use `lsp.symbols` to locate relevant TypeScript symbols when the file is not
  obvious.
- Before changing a shared TS symbol's behavior or signature, call
  `lsp.references`; every caller is potentially a behavior or test surface that
  must be considered in the same turn.
- For renames, use `lsp.rename`, not find-and-replace.
- After editing, run `lsp.diagnostics` on each changed TS/TSX file.
- `.mjs`, `.cjs`, Markdown, shell scripts, and Swift files may not have semantic
  LSP coverage; read/search those files directly and mention that fallback in
  evidence when relevant.
</lsp_usage>

<working_tree_rules>
Expected out-of-scope dirty files during transcript-resume turns: none.

This setup turn may leave `.volt/ios-remote-transcript-resume-design.md` and
`.volt/ios-remote-transcript-resume-goal.md` uncommitted until the user decides
whether to commit planning documents. Future implementation turns should treat
these two files as in-scope only when updating ledgers for the selected item.

Multiple Volt sessions may share the same worktree. Never stage or commit files
you did not modify for the selected item. If either repository shows unrelated
dirty files, stop before selecting work.
</working_tree_rules>

<partial_progress_rule>
If the selected item is too large to finish in one turn but coherent progress is
possible, this is not a block. Work only that item, keep it status="open", add a
`&lt;progress date="YYYY-MM-DD"&gt;` child describing what changed and what remains,
run verification required for the files changed, and commit only coherent completed
progress if committing is safe. The next turn will re-select this same item because
it remains the first selectable open item.
</partial_progress_rule>

<rollup_rule>
Items with type="rollup" are never selected directly. When a turn resolves the
final prerequisite of a rollup item, mark the rollup resolved in this file and
update the design doc checklist during that same turn. Do not spend a separate
turn on a rollup item.
</rollup_rule>

<blocked_rule>
If the selected item cannot proceed at all, or its remaining portion cannot proceed
because required evidence, credentials, a supported platform, a simulator, native
Iroh support, or a human product decision is unavailable:

1. Do whatever portion is achievable without the blocker, following
   partial_progress_rule.
2. Add a `Blocked YYYY-MM-DD:` note to `.volt/ios-remote-transcript-resume-design.md`
   under the relevant section and set this file's item status="blocked" with a
   `&lt;blocker&gt;` child explaining what is needed.
3. Stop the turn. Later turns do not select blocked items unless the blocker is
   plausibly cleared.
4. Mark the overall goal blocked only when no selectable open item remains.
</blocked_rule>

<completion_rule>
Do not declare the goal complete until every work_queue item has status="resolved",
the rollup item is resolved, and the final turn's required verification passed.
</completion_rule>

<work_queue>

<group n="1" title="Host transcript protocol">
  <item ref="A.1" status="resolved" prereq="">
    <title>Add the `get_transcript` RPC contract and active-session transcript projection</title>
    <acceptance>RPC types include `get_transcript` with optional `limit` and `beforeEntryId`; response types include user, assistant, tool, and summary transcript items; the projection reads only the active session, returns items oldest-to-newest, defaults to the latest 100 items, caps at 200, supports pagination, includes compaction summaries as summary items, includes bounded safe tool summaries and mutation previews, omits session file paths and raw internal payloads, and standard RPC tests cover the behavior.</acceptance>
    <evidence>Resolved 2026-06-22: prior turn added host transcript RPC types/projection/handler/tests and verified targeted coding-agent transcript/RPC tests plus npm run check; no commit.</evidence>
  </item>

  <item ref="A.2" status="resolved" prereq="A.1">
    <title>Expose `get_transcript` over Iroh while preserving the remote security boundary</title>
    <acceptance>`get_transcript` is allowed by the Iroh remote command filter and response-completion tracking; `get_messages` and path-based `switch_session` remain blocked remotely; transcript responses pass through outbound redaction so workspace paths normalize and host-local paths are redacted; protocol docs list the command and its guarantees; tests cover allowed `get_transcript`, blocked raw commands, and no leaked session file paths.</acceptance>
    <evidence>Resolved 2026-06-22: prior turn allowed `get_transcript` over Iroh, kept raw/path commands blocked, updated protocol docs/tests, and verified npm run iroh:poc:test plus npm run check; no commit.</evidence>
  </item>
</group>

<group n="2" title="iOS transcript loading">
  <item ref="B.1" status="resolved" prereq="A.1,A.2">
    <title>Add iOS client parsing and state for transcript pages</title>
    <acceptance>`VoltRPCCommand` can send `get_transcript`; `VoltSession` parses transcript responses into existing `TranscriptItem` models, including user, assistant, tool, and summary/system-style items; transcript loading state and pagination metadata are stored; invalid or partial transcript items are skipped safely; package tests cover command encoding and response mapping.</acceptance>
    <evidence>Resolved 2026-06-22: added iOS `get_transcript` command, transcript page state/mapping, mock response support, and command/mapping tests; verified `cd ../volt-app/Packages/VoltClient &amp;&amp; swift test`; no commit.</evidence>
  </item>

  <item ref="B.2" status="resolved" prereq="B.1">
    <title>Load prior transcript after reconnect and session switch without changing fresh-session behavior</title>
    <acceptance>After successful connect/reconnect, iOS requests `get_state` and `get_transcript`; after successful `switch_session_by_id`, iOS clears the visible transcript to a loading placeholder, refreshes state, requests transcript, and renders the selected session's prior transcript; after `new_session`, iOS keeps the fresh empty transcript behavior and does not request old transcript; Swift package and iOS simulator tests cover these flows.</acceptance>
    <evidence>Resolved 2026-06-22: connected/reconnected sessions now request `get_state` then `get_transcript`, switched sessions show a loading placeholder then refresh state/transcript, and new sessions refresh state without transcript; verified `cd ../volt-app/Packages/VoltClient &amp;&amp; swift test` and `cd ../volt-app &amp;&amp; xcodebuild -scheme Volt -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0' test`; no commit.</evidence>
  </item>

  <item ref="B.3" status="resolved" prereq="B.2">
    <title>Add a bounded load-older transcript path for pagination</title>
    <acceptance>The iOS app stores `nextBeforeEntryId`/`hasMore`, can request older transcript pages using `beforeEntryId`, prepends older items without duplicating IDs, and exposes a simple top-of-list load control or refresh action; tests cover pagination state and duplicate avoidance. If product UI placement is unclear, implement state and tests, document the deferred UI decision, and leave this item open with partial progress.</acceptance>
    <evidence>Resolved 2026-06-22: added `loadOlderTranscript` pagination using `nextBeforeEntryId`, duplicate-safe prepend behavior, a top-of-chat load-older control, and pagination tests; verified `cd ../volt-app/Packages/VoltClient &amp;&amp; swift test` and `cd ../volt-app &amp;&amp; xcodebuild -scheme Volt -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0' test`; no commit.</evidence>
  </item>
</group>

<group n="3" title="Documentation and validation">
  <item ref="C.1" status="resolved" prereq="A.2,B.2">
    <title>Update docs and design ledgers for transcript resume behavior</title>
    <acceptance>`docs/rpc.md`, `docs/iroh-remote-protocol.md`, `.volt/ios-remote-transcript-resume-design.md`, and app README or user-facing notes describe `get_transcript`, transcript loading after reconnect/switch, fresh-session behavior, limits, pagination, and security constraints; changelog entries are added where appropriate.</acceptance>
    <evidence>Resolved 2026-06-22: updated RPC docs, Iroh protocol docs, design ledger, and iOS README for transcript resume, fresh-session behavior, limits, pagination, and security; coding-agent changelog already records `get_transcript`; verified doc diff checks; no commit.</evidence>
  </item>

  <item ref="C.2" status="resolved" prereq="B.3,C.1">
    <title>Run final cross-surface validation for remote transcript resume</title>
    <acceptance>Final evidence lists exact Volt checks, targeted coding-agent tests, Iroh scenario test when remote RPC changed, Swift package tests, iOS simulator tests, and any manual smoke used to verify connect, switch, and transcript load. Known unsupported cases or blocked evidence are documented without overclaiming.</acceptance>
    <evidence>Resolved 2026-06-22: verified `cd packages/coding-agent &amp;&amp; node node_modules/vitest/dist/cli.js --run test/rpc-transcript.test.ts test/rpc-mode-transport.test.ts test/remote-iroh-core.test.ts` (62 tests), `npm run iroh:poc:test`, `npm run check`, `cd ../volt-app/Packages/VoltClient &amp;&amp; swift test` (32 Swift Testing tests plus XCTest targets), `cd ../volt-app &amp;&amp; xcodebuild -scheme Volt -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0' test`, and doc diff checks; no separate manual smoke beyond automated connect/switch/transcript-load tests; no commit.</evidence>
  </item>

  <item ref="C.3" status="resolved" prereq="C.2" type="rollup">
    <title>Rollup: remote transcript resume is implemented, tested, documented, and ready for iOS use</title>
    <acceptance>All prior items resolved; design doc decisions are recorded; no open transcript-resume implementation decisions remain except explicitly deferred future work; final verification evidence is recorded.</acceptance>
    <evidence>Resolved 2026-06-22: all A/B/C prerequisite items are resolved, design decisions and final validation evidence are recorded, and no transcript-resume implementation decisions remain open; no commit.</evidence>
  </item>
</group>

</work_queue>

</goal>
