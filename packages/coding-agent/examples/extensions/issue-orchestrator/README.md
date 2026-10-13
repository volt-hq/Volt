# Issue orchestrator

Works a repository's GitHub issues with agents, as the repository's `.volt/WORKFLOW.md` says: an implementer opens a pull request, a reviewer (an agent, or one of `/review`'s review engines) posts a verdict on each head commit, a fixer addresses changes and failing checks, an updater merges the base branch in when the pull request conflicts with it, and the loop repeats until the review is clean and CI is green. Then the orchestrator merges the pull request, or labels the issue for a human to merge (the default).

The shape of the loop and of the workflow file follow the Symphony service specification. The difference is the review loop: each role runs its own agent, and the orchestrator reads what an issue needs next from GitHub alone.

## Running it

```bash
volt -e packages/coding-agent/examples/extensions/issue-orchestrator
```

In that conversation:

```
/orchestrate start            # .volt/WORKFLOW.md
/orchestrate start path.md    # another workflow file
/orchestrate status
/orchestrate refresh          # tick now
/orchestrate stop             # cancel the agents and stop
```

The loop is work of the conversation: it shows in `/work`, and every agent it starts is a subagent under it, which you can open and watch. The conversation is named `Issue orchestrator · <repo>` (unless you named it) and gets a note when the loop starts and stops, so `/resume` lists it after you quit. It also gets a note with a link to GitHub whenever the orchestrator picks an issue up (the issue, or the pull request it works on), an issue it implemented gets its pull request, and it hands an issue to you, ready to merge or stuck. The link is clickable where the terminal shows links, and printed as the address elsewhere. A panel lists each issue and what it is doing (running, needing you, ready to merge, retrying, or waiting), the issues that need someone first, with buttons to open a running agent, refresh, and stop. It shows as many as fit in a few rows; for the full view, open the orchestrator's item in `/work` (Alt+J): it fills the screen with every issue, above a timestamped log of what the loop did (agents started and finished, merges, handoffs, errors), with the same GitHub links as the notes. The loop itself is deterministic code, so the conversation's model is free for questions about it.

Requirements:

- interactive Volt, whose conversations the daemon hosts: each issue gets a [managed worktree](../../../docs/daemon.md#git-worktrees) (`issue-<n>` on branch `volt/issue-<n>`);
- a trusted project, since the workflow's hooks run commands;
- GitHub CLI signed in, for the orchestrator and for the agents;
- the agent definitions the roles name (`general` by default).

## How an issue moves

Each tick (every `polling.interval_ms`, and whenever an agent finishes) the orchestrator re-reads the workflow, stops runs of issues that closed or lost their label, and works each open issue that carries every `tracker.labels` label and no excluded one, oldest first:

| GitHub state | Next |
|---|---|
| No pull request from the issue's branch (`volt/issue-<n>`, or a restart's) | `implement` agent, unless another issue's work changes the code this one names |
| Open pull request that conflicts with its base branch | `update` agent, before anything else |
| A triage decided `restart` or `handoff` for the head commit | carry it out |
| Open pull request, no verdict on its head commit | `update` agent when the base branch changed files the pull request changes, else `review` agent or a review on `review.engine` |
| Verdict `changes` | `fix` agent (after an update, as above), while fewer than `review.max_rounds` heads were reviewed and the last fix introduced no new defects; else `triage` agent while `triage.max_runs` allows; else a human |
| Verdict `clean`, checks running | wait |
| Verdict `clean`, checks failing | `fix` agent, under the same limits |
| Verdict `clean`, checks passing, GitHub still checking mergeability | wait |
| Verdict `clean`, checks passing, mergeable | merge (`merge.mode: auto`), or the `merge.ready_label` for a human |
| Pull request merged, or issue closed | done |

The updater merges the base branch into the pull request's branch (never a rebase or force push) and pushes the merge, which the reviewer then reviews like any head commit. It runs when the pull request conflicts, and before a review or a fix when the base branch changed a file the pull request changes since it branched, so neither works on code the base has moved past. Such a review is not a round toward `review.max_rounds`, since the base moving is not the pull request's fault. When the base branch already has the change, the updater closes the pull request and the issue instead. An issue labeled `merge.ready_label` stays watched: when its pull request comes to conflict with the base branch (say, after another one merged), the orchestrator removes the label with a comment and updates the pull request.

A verdict is the last line of a pull request comment or review by `tracker.review_author`: `<!-- volt-orchestrator review head=<sha> verdict=clean|changes -->`, which a review engine's review ends with ` run=<id>`, and ` waived=<n>` or ` regressed=<n>` as below. A triage's decision is a comment's last line, `<!-- volt-orchestrator triage head=<sha> decision=continue|restart|handoff -->`, and a restart is recorded on the issue as `<!-- volt-orchestrator restart branch=<branch> pr=<n> -->`. Comments and reviews by anyone else do not count, so a stranger cannot approve a pull request or steer one.

Same code: an issue's implementation waits while another issue's work changes a file this issue names (a `path:line` in its text): an implementation of that issue running now, or its open pull request. Oldest issues go first, so two issues about one function do not race each other into conflicting pull requests. An issue that names no file is never held.

When the orchestrator stops working an issue it comments why and adds `handoff_label` (`agent-needs-human`). Removing the label hands the issue back. Create the labels in the repository first (yours, `agent-filed`, `agent-needs-human`, and `agent-approved`): `gh issue create` refuses a label the repository does not have, and a handoff without its label is only the comment.

Scope: what an issue's agents find in scope is fixed in its pull request: anything with the issue's root cause, and any defect on lines the change touches, even one that predates it. What they find outside it (tech debt, unrelated bugs, wrong docs) gets worked too, through one deterministic check the orchestrator makes:

- Agents never file issues. Each ends its final reply with the problems it found outside its work, as a JSON array (title, body, file, lines, priority) between `<out-of-scope>` tags (`{{ out_of_scope }}` in a prompt says how). The orchestrator reads it once the run ends; a report it cannot read is logged.
- The orchestrator records each of these problems, and each follow-up a review collects, once:
  1. one whose fingerprint an issue or comment names already is skipped;
  2. one at the code of an open issue the workflow works (the same file, within 3 lines of a `path:line` the issue names), other than the issue being worked, is added to that issue as a comment, which its agents read;
  3. anything else is filed as an issue with the `tracker.labels` labels, so the orchestrator works it, plus `tracker.filed_label` (`agent-filed`), and a `Location:` line the next check reads.

  Recording is one run's at a time, so two runs that end together do not file the same site twice. The check compares places in the code, not wording: the same defect reported in another file is not caught, and two defects within a few lines go to one issue, the second as a comment.
- A problem found while working an issue an agent filed is filed with `tracker.filed_label` only, without `tracker.labels`: the orchestrator does not work it until a human adds them. A chain of agent-filed issues is one link deep unless a human extends it.
- To have a human vet filed issues first instead, add `agent-filed` to `tracker.exclude_labels`.

Checkouts: a workspace holds at most 16 managed worktrees, so the orchestrator releases an issue's worktree (keeping its branch) once it hands the issue off, approved or not, finishes it, or the issue closes or loses its label. It deletes the checkout's ignored files first (dependencies and build output: the daemon never removes a checkout that holds any), unless the checkout has changes to tracked or untracked files, in which case it stays for the human. A release the daemon refuses for another reason is tried again each tick, its error logged once. If the issue comes back, its worktree is created again on its branch, and the setup hook runs again. A checkout that cannot be set up, such as while the workspace is full, is retried with backoff and does not count as an attempt. When it starts, and whenever the workspace is full, the orchestrator also releases the checkout of every issue GitHub shows it is done with (closed, approved, handed off, or out of the workflow), including issues an earlier run worked.

Limits: `agent.max_concurrent` agents at once (and a role's `max_concurrent`), `agent.max_attempts` started agent runs per phase of one head commit (of one branch, for an implementation), exponential backoff after a failed run (10 s doubling, at most `agent.max_retry_backoff_ms`), each role's `max_turns`, `max_tokens`, `max_cost_usd`, and `max_duration_ms`, `triage.max_runs` triages per pull request, and `triage.max_restarts` restarts per issue.

## When a pull request does not converge

A review engine's finding says whether the change introduced it (`introduced`), or the defect predates the change on a line the change touches. The orchestrator uses that in two ways:

- Pre-existing findings: in round 1 they block like any other, since a defect on a changed line is the change's own and the fixer gets one chance at it. From round 2 on, a review whose open findings (P0 to P2) all predate the change is posted `clean`, with ` waived=<n>` on its verdict and a line saying so. The fixer's list marks them, and the human the pull request goes to gets them listed in the approval comment (or, with `merge.mode: auto`, in a comment on the issue once it merges).
- Regressions: a review that asks for changes counts its findings that are new this round (not open in the previous round's review), introduced by the change, and on lines the last fix changed (the diff from the previous reviewed head). Those are defects the fix made, so ` regressed=<n>` goes on its verdict.

A pull request whose last fix regressed, or that ran out of `review.max_rounds`, gets a `triage` agent, while `triage.max_runs` triages of it ran (2 by default; 0 turns triage off, and such a pull request goes to a human). The triage reads the issue, the pull request, and each round's verdict and findings (`{{ triage.history }}`), and ends its reply with a decision, which the orchestrator posts on the pull request:

- `continue`: this head gets one more fix, past the round limit. A later head that does not converge is triaged again.
- `restart`: the approach is wrong. The orchestrator records the restart on the issue, with the triage's diagnosis and guidance, closes the pull request, and releases its checkout. The issue is implemented again from the base branch on `volt/issue-<n>-<count>` (worktree `issue-<n>-<count>`), and the implementer's prompt gets the guidance as `{{ restart.guidance }}`. Past `triage.max_restarts` restarts (1 by default), the issue goes to a human instead.
- `handoff`: a human decides, with the triage's diagnosis in the handoff comment.

A triage whose reply has no decision failed, and is tried again like any run. Every decision is read back from GitHub, so a restarted orchestrator carries out one it posted before. The agent review engine (`review.engine: agent`) gives no findings, so it neither waives nor finds regressions; its pull requests are triaged once they run out of rounds.

State lives in memory. After a restart, `/orchestrate start` again: the next tick finds each issue's phase on GitHub, and releases the checkouts of the issues done with.

## Reviewing on a review engine

`review.engine` picks who reviews. `agent` (the default) runs the `review` role's agent with its prompt, which posts the verdict comment itself. `standard`, or an extension's engine such as `ext:swarm-review/swarm`, runs the review as `/review` does, as review work under the orchestrator's work item, which `/work` opens:

- The review, on whichever engine, may run the project's checks and tests (`bash`) in disposable checkouts of the pull request's head, each of which `workspace.hooks.after_create` sets up first (for at most `hooks.timeout_ms`, and an hour at most). It never works in the issue's worktree.
- A complete review is posted to the pull request as one review, each finding on its line where GitHub accepts it, through `github.command`, so `tracker.review_author` must be the account that command signs in as. Its verdict is `clean` when the review found the change correct (no open P0 to P2 finding), else `changes`. An incomplete review gives no verdict: it counts as a failed run of the phase and is tried again.
- Each round's review follows the previous one: it decides each finding the previous round left open, and closes the ones the fix resolved. That holds on any engine, since the host decides what an engine leaves undecided, so a loop cannot stall on an engine that decides none. A run the conversation no longer holds (after `/orchestrate start` in another conversation) is not followed; the review is full either way.
- The fixer's prompt gets the open findings of the review that asked for changes as `{{ review.findings }}`, since the ones posted on their lines are not in the pull request's comments.
- A review takes an agent slot (`agent.max_concurrent` and the `review` role's `max_concurrent`); the role's agent, limits, and prompt do not apply. A conversation runs at most 3 reviews at once: one refused for that is tried again with backoff.
- The review also collects follow-ups, defects it verified outside the change, which the orchestrator records as above. A defect on a line the pull request changes is never a follow-up, even one that predates the change: the host refuses it as one, and the review reports it as a finding the fixer addresses in the pull request. A follow-up never blocks the pull request.

## Safety

- Only issues carrying every `tracker.labels` label are worked. Use a label only maintainers and the orchestrator's agents apply.
- Agent-filed issues are worked without a human looking at them first, and each can lead to more. The scope rule and the check above keep a chain from repeating itself; if one still runs away, exclude `agent-filed` (or stop the orchestrator): every one of them carries it.
- Issue text reaches the agents as data inside the prompt, but agents run the conversation's tools, and a prompt injection in an issue is still an injection. Keep the label gate strict, and keep `merge.mode: handoff` until you trust the setup.
- `merge.mode: auto` merges only a pull request whose head commit the review author reviewed clean and whose checks pass; with `merge.require_checks` (the default), a pull request without checks goes to a human. Branch protection still applies to the merge.
- Agents use the same GitHub credentials as you unless `github.command` and the prompts route them elsewhere (for example a bot wrapper). The agents can read `gh`'s stored token like any process you run.

## Workflow file

The front matter configures the orchestrator; `## implement`, `## review`, `## fix`, `## update`, and `## triage` sections of the body replace the built-in prompt of that role. Templates take `{{ issue.number }}`, `issue.identifier`, `issue.title`, `issue.body`, `issue.url`, `issue.labels`, `repo`, `gh`, `tracker.labels`, `out_of_scope` (how an agent reports problems outside its work), `worktree.path`, `worktree.branch`, `attempt`, `round`, `reason`, `pr.number`, `pr.url`, `pr.head_sha`, `pr.base_ref`, `review.max_rounds`, `review.clean_marker`, `review.changes_marker`, `review.findings` (the open findings of the review engine's review that asked for changes, empty otherwise), `ci.failing`, `restart.guidance` and `restart.previous_pr` (for a restarted issue's implementer, empty otherwise), and `triage.reason`, `triage.history`, `triage.output` (how a triage reports its decision; a `## triage` prompt must include it), and `triage.restarts_left`. An unknown variable fails the run.

```markdown
---
tracker:
  repo: volt-hq/Volt                # default: the repository gh sees here
  labels: [agent-ready]             # required: every issue worked has all of them
  exclude_labels: [blocked]         # plus handoff_label and merge.ready_label
  review_author: volt-agent[bot]    # default: the gh user; volt-agent and app/volt-agent match too
  filed_label: agent-filed          # the orchestrator adds it, with labels, to the issues it files
github:
  command: [volt-agent, gh]         # default: [gh]
polling:
  interval_ms: 60000
workspace:
  base_ref: main                    # default: the checkout's current branch
  hooks:
    after_create: npm ci --ignore-scripts
    timeout_ms: 600000
agent:
  max_concurrent: 2
  max_attempts: 3
  max_retry_backoff_ms: 300000
roles:
  implement: { agent: general, max_turns: 120, max_cost_usd: 10 }
  review:    { agent: reviewer, max_concurrent: 1 }
  fix:       { agent: general }
  update:    { agent: general }
  triage:    { agent: reviewer }
review:
  max_rounds: 3
  engine: agent                     # or standard, or ext:<extension id>/<engine name>
triage:
  max_runs: 2                       # per pull request; 0 hands a pull request that does not converge to a human
  max_restarts: 1                   # per issue
merge:
  mode: handoff                     # or auto
  method: squash                    # merge, rebase
  require_checks: true
  ready_label: agent-approved
handoff_label: agent-needs-human
---

## review

Review pull request #{{ pr.number }} against this repository's AGENTS.md ...
End your comment with {{ review.clean_marker }} or {{ review.changes_marker }}.
```

With `review.engine: agent`, use a different agent definition (with its own `model`) for `review`, so the model that wrote a change is not the only one judging it.
