# Goal extension POC

Project-local adaptation of **pi-goal-x 0.32.3** (MIT, copyright 2026 Lucas; see [LICENSE](LICENSE)). It implements the basic confirmed-goal workflow using Volt's native extension, UI-data, session-entry, and SDK APIs. It is not upstream feature parity and is not shipped as a built-in command.

## Use

Trust this repository and `/reload` with a Volt checkout that supports the `agent_settled` extension hook. No installation or new dependencies are needed. The extension is discovered at `.volt/extensions/goal/index.ts`; it can also be loaded explicitly with `-e .volt/extensions/goal`.

Do not load another extension with the manifest ID `goal` at the same time (for example, `Volt-store-goal`). Remove its package registration or exclude its extension resources before loading this POC; changing enablement by ID cannot distinguish duplicate packages.

1. Run `/goal` for a guided objective/constraints form, or `/goal <request>`.
2. The main model drafts measurable requirements and tasks with `goal_propose`.
3. Review the complete proposal. **Only an affirmative UI confirmation activates it.** Dismissal, an unavailable client, or cancellation never approves it. Headless goal drafting is deliberately unavailable.
4. The main model executes within the confirmed scope and records task evidence with `goal_task`. Successful settled runs continue automatically through fresh extension-source prompts; ordinary `before_agent_start` context preparation still runs.
5. `goal_complete` runs an independent audit. Only the auditor's approval completes the goal and requests one tool-free final response. Rejection returns its report to the executor for further work; errors block execution until explicitly resumed.

There is **no automatic run-count, time, token, or cost cap**. A stalled model can keep spending indefinitely. Pause it when it is not making progress. Existing host tool, authorization, and admission policies still apply.

| Command | Behavior |
| --- | --- |
| `/goal [request]` | Draft a new goal; an existing goal is paused until a replacement is approved. |
| `/sisyphus [request]` | Draft an ordered goal. Preceding steps must be complete; skipping is prohibited. |
| `/goal-status` | Show the objective, requirements, progress, evidence, and latest audit. |
| `/goal-pause` | Pause execution, cancel an outstanding confirmation/audit, and stop the current run. |
| `/goal-resume` | Explicitly resume the previously confirmed paused/blocked goal. |
| `/goal-tweak [changes]` | Pause and draft a revised goal. A new affirmative confirmation is required; rejecting it preserves the previous goal. |

Any new input pauses active goal execution: a prompt, steering or follow-up messages, a slash command (including `/goal-status`), an extension intent, or another extension's message sent during a run. Escape/abort pauses it; terminal foreground failure blocks it. Plan mode, review discussions, and a session operation or extension command still running when a continuation would start refuse it, which pauses the goal; a continuation that fails to start blocks it. The model can call `goal_block` when it needs user input or authorization rather than looping. An explicit `goal_block` also replaces the reason on an already paused/blocked goal without reactivating it; later generic stop notifications preserve that reason. Commands are local-only: a paired remote client cannot draft or resume a goal. A resume whose prompt cannot start (no model or credentials, the agent busy, a stop, or another extension's `input` hook handling it) blocks the goal with the cause; a draft that cannot start is discarded. A confirmation, like other Volt dialogs, can be answered by an attached authorized UI client.

Goal guidance is injected in the request-local `context` hook, including native background-job wakes and tool follow-ups, without rewriting session history or other extensions' context. Each request carries exactly one `volt-goal.context` snapshot. The snapshot stays where a request first carried it until the goal's control state changes (draft, goal identity, status, note, or a persistence failure), so consecutive requests extend the provider's cached prompt. Task progress alone does not move it, because `goal_task` calls and results already carry that progress and `goal_status` reads the current state. A control-state change, compaction, or another rewrite of earlier history replaces the snapshot with a current one at the end of the request, which costs one uncached request. Re-sending the snapshot at the end of every request instead makes every call rewrite the whole conversation into the prompt cache. A paused/blocked goal does not disable unrelated user-authorized work or cancel existing jobs: collecting/reporting their results is permitted, but a job wake never authorizes resuming goal implementation or updating its tasks. Explicit resume/reconfirmation gates still apply. Failed settlement notes point to the current session and branch-entry checkpoint for investigation; `agent_settled` supplies no failure cause, so the extension does not infer one or copy sensitive error text into those notes.

`goal_status` reads state without changing it; pass `taskId` for one task's full evidence. Summaries are limited to 24 KB/500 lines, status dialogs to 16 KB. Proposals must fit within 16 KB so confirmation shows the complete scope. The POC supports up to 50 flat tasks; these data bounds are **not** continuation limits. Reopening an ordered step clears later completion evidence. Revising the goal creates a new task list; previous snapshots remain in session history.

## Persistence and lifecycle

Each instance owns its own state. Transitions serialize the entire read/modify/write transaction and await `volt.appendEntry("volt-goal.state", ...)` before publishing success. State is reconstructed from the current branch, not from other branches' newer entries. Compaction does not discard these custom entries.

An interrupted active/auditing goal is restored as paused; no inference starts merely because a session is opened, forked, reloaded, or enabled. Interrupted drafts are discarded. Branch navigation and session switch/fork pause the source goal. Retiring the extension cancels and drains its auditor, drops stale results, saves a paused snapshot when the log is writable, and clears UI. A failed append stops autonomous continuation in memory; if nothing more can be saved, the last durable active snapshot is paused when reopened. Inspect the persistence error and reload before resuming.

The settlement hook only returns a prompt; it never sends messages, polls, creates fake background work, or wakes itself. The host owns admission and revokes stale or refused proposals on abort, newer input, host policy, branch changes, reload, and disable; the extension pauses on every revocation, so an active goal always has a run or a pending continuation. Handled commands are not goal execution runs. This extension does not replace native Plan mode or authorize bypassing it.

## Completion audit: independence, not a sandbox

The default audit uses a **fresh, in-memory SDK session on the current model and thinking level**, with its own audit instructions and the parent's loaded project context files. It receives the confirmed goal, recorded evidence, and executor claim as data, **not** the executor's conversation. It loads no extensions, skills, prompt templates, subagents, or MCP servers. Only a normally finished final response ending with a standalone `<approved/>` is approval; missing/malformed markers or any interruption fail closed.

The audit tool set intersects the parent's **currently active, native built-in `read` and `bash`** tools. It does not re-enable excluded tools or substitute native tools for parent overrides. With neither available, auditing blocks. Production auditing also requires trusted project context.

Important limitations:

- This is **context isolation, not process, filesystem, network, credential, or operating-system isolation**. The auditor sees the same mutable working directory, including uncommitted changes, not an atomic snapshot. Finish background work before requesting completion. It uses the configured provider credentials. The audit incurs additional inference cost.
- Bash is unrestricted at the tool level. Its inspection/verification-only guidance is **prompt-only**, not an enforced command allowlist. Verification can generate artifacts; malicious or mistaken shell commands could change files or access the network. Use an external sandbox if that risk is unacceptable.
- The independent SDK session does **not inherit arbitrary parent tool-call/result hooks, host turn policies, command approval handlers, or argument-level restrictions**. Name/provenance intersection is checked when the audit starts, not continuously after every parent policy change. Do not use this POC where those controls are required security boundaries.
- Inherited project instructions are model instructions, not enforcement. Auditor output and an approval marker are model judgments, not proof or protection against prompt injection. Audit reports are stored up to 16,000 characters; the audit transcript itself is ephemeral.
- The audit has no recursive extension/MCP execution, but Bash still has full host authority. Disabling extension tools or declaring permissions does not sandbox trusted extension code.

`registerGoal(volt, auditRunner)` exposes a typed runner seam for deterministic tests. The production entry always uses `runAudit`.

## Validation

From `packages/coding-agent`:

```bash
node ../../node_modules/vitest/dist/cli.js --run test/goal-state.test.ts test/suite/goal-extension.test.ts
```

Tests use the suite harness and faux provider only, including a real independent SDK session. They cover approval, concurrent durable progress, ordered-step rules, more than 120 consecutive runs, rejection/error/cancellation, pausing on steering, follow-ups, commands, and Plan-mode refusal, resumes and drafts that cannot start, remote resume refusal, instance isolation, restoration, branch navigation, and retirement. Hardening regressions cover native job completion/failure waking a blocked goal, current nonduplicated inference guidance, guidance that keeps each request's prompt a prefix of the next across task progress, inactive progress rejection alongside permitted result collection/maintenance, explicit blocker-reason replacement, and failure checkpoint references. No real provider calls are used.

API references: [Extensions](../../../packages/coding-agent/docs/extensions.md), [UI data](../../../packages/coding-agent/docs/ui-nodes.md), [SDK](../../../packages/coding-agent/docs/sdk.md).
