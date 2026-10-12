# Issue orchestrator

Works a repository's GitHub issues with agents, as the repository's `.volt/WORKFLOW.md` says: an implementer opens a pull request, a reviewer posts a verdict on each head commit, a fixer addresses changes and failing checks, an updater merges the base branch in when the pull request conflicts with it, and the loop repeats until the review is clean and CI is green. Then the orchestrator merges the pull request, or labels the issue for a human to merge (the default).

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

The loop is work of the conversation: it shows in `/work`, and every agent it starts is a subagent under it, which you can open and watch. The conversation is named `Issue orchestrator · <repo>` (unless you named it) and gets a note when the loop starts and stops, so `/resume` lists it after you quit. It also gets a note with a link to GitHub whenever the orchestrator picks an issue up (the issue, or the pull request it works on), an issue it implemented gets its pull request, and it hands an issue to you, ready to merge or stuck. The link is clickable where the terminal shows links, and printed as the address elsewhere. A panel lists each issue and what it is doing (running, needing you, ready to merge, retrying, or waiting), the issues that need someone first, with buttons to open a running agent, refresh, and stop. It shows as many as fit in a few rows; for the full view, open the orchestrator's item in `/work` (Alt+J): it fills the screen with every issue, above a timestamped log of what the loop did (agents started and finished, merges, handoffs, errors). The loop itself is deterministic code, so the conversation's model is free for questions about it.

Requirements:

- interactive Volt, whose conversations the daemon hosts: each issue gets a [managed worktree](../../../docs/daemon.md#git-worktrees) (`issue-<n>` on branch `volt/issue-<n>`);
- a trusted project, since the workflow's hooks run commands;
- GitHub CLI signed in, for the orchestrator and for the agents;
- the agent definitions the roles name (`general` by default).

## How an issue moves

Each tick (every `polling.interval_ms`, and whenever an agent finishes) the orchestrator re-reads the workflow, stops runs of issues that closed or lost their label, and works each open issue that carries every `tracker.labels` label and no excluded one, oldest first:

| GitHub state | Next |
|---|---|
| No pull request from `volt/issue-<n>` | `implement` agent |
| Open pull request that conflicts with its base branch | `update` agent, before anything else |
| Open pull request, no verdict on its head commit | `review` agent |
| Verdict `changes` | `fix` agent, while fewer than `review.max_rounds` heads were reviewed; else a human |
| Verdict `clean`, checks running | wait |
| Verdict `clean`, checks failing | `fix` agent, under the same round limit |
| Verdict `clean`, checks passing, GitHub still checking mergeability | wait |
| Verdict `clean`, checks passing, mergeable | merge (`merge.mode: auto`), or the `merge.ready_label` for a human |
| Pull request merged, or issue closed | done |

The updater merges the base branch into the pull request's branch (never a rebase or force push) and pushes the merge, which the reviewer then reviews like any head commit. Such a review is not a round toward `review.max_rounds`, since a conflict is not the pull request's fault. When the base branch already has the change, the updater closes the pull request and the issue instead. An issue labeled `merge.ready_label` stays watched: when its pull request comes to conflict with the base branch (say, after another one merged), the orchestrator removes the label with a comment and updates the pull request.

A verdict is the last line of a pull request comment by `tracker.review_author`: `<!-- volt-orchestrator review head=<sha> verdict=clean|changes -->`. Comments by anyone else do not count, so a stranger cannot approve a pull request.

When the orchestrator stops working an issue it comments why and adds `handoff_label` (`agent-needs-human`). Removing the label hands the issue back. Create the labels in the repository first (yours, `agent-filed`, `agent-needs-human`, and `agent-approved`): `gh issue create` refuses a label the repository does not have, and a handoff without its label is only the comment.

Issues the agents file along the way (tech debt, out-of-scope bugs) get the `tracker.labels` labels too, so the orchestrator works them as well, plus `tracker.filed_label` (`agent-filed`) to tell them apart. Their bodies name the issue or pull request the agent found them in. To have a human vet them first instead, add `agent-filed` to `tracker.exclude_labels`.

Checkouts: a workspace holds at most 16 managed worktrees, so the orchestrator releases an issue's worktree (keeping its branch) once it hands the issue off, approved or not, finishes it, or the issue closes or loses its label. It deletes the checkout's ignored files first (dependencies and build output: the daemon never removes a checkout that holds any), unless the checkout has changes to tracked or untracked files, in which case it stays for the human. If the issue comes back, its worktree is created again on its branch. A checkout that cannot be set up, such as while the workspace is full, is retried with backoff and does not count as an attempt.

Limits: `agent.max_concurrent` agents at once (and a role's `max_concurrent`), `agent.max_attempts` started agent runs per phase of one head commit, exponential backoff after a failed run (10 s doubling, at most `agent.max_retry_backoff_ms`), and each role's `max_turns`, `max_tokens`, `max_cost_usd`, and `max_duration_ms`.

State lives in memory. After a restart, `/orchestrate start` again: the next tick finds each issue's phase on GitHub.

## Safety

- Only issues carrying every `tracker.labels` label are worked. Use a label only maintainers and the orchestrator's agents apply.
- Agent-filed issues are worked without a human looking at them first, and each can lead to more. If a chain of them runs away, exclude `agent-filed` (or stop the orchestrator); every one of them carries it.
- Issue text reaches the agents as data inside the prompt, but agents run the conversation's tools, and a prompt injection in an issue is still an injection. Keep the label gate strict, and keep `merge.mode: handoff` until you trust the setup.
- `merge.mode: auto` merges only a pull request whose head commit the review author reviewed clean and whose checks pass; with `merge.require_checks` (the default), a pull request without checks goes to a human. Branch protection still applies to the merge.
- Agents use the same GitHub credentials as you unless `github.command` and the prompts route them elsewhere (for example a bot wrapper). The agents can read `gh`'s stored token like any process you run.

## Workflow file

The front matter configures the orchestrator; `## implement`, `## review`, `## fix`, and `## update` sections of the body replace the built-in prompt of that role. Templates take `{{ issue.number }}`, `issue.identifier`, `issue.title`, `issue.body`, `issue.url`, `issue.labels`, `repo`, `gh`, `tracker.labels`, `tracker.filed_labels` (the labels agents give the issues they file), `worktree.path`, `worktree.branch`, `attempt`, `round`, `reason`, `pr.number`, `pr.url`, `pr.head_sha`, `pr.base_ref`, `review.max_rounds`, `review.clean_marker`, `review.changes_marker`, and `ci.failing`. An unknown variable fails the run.

```markdown
---
tracker:
  repo: volt-hq/Volt                # default: the repository gh sees here
  labels: [agent-ready]             # required: every issue worked has all of them
  exclude_labels: [blocked]         # plus handoff_label and merge.ready_label
  review_author: volt-agent[bot]    # default: the gh user; volt-agent and app/volt-agent match too
  filed_label: agent-filed          # agents add it, with labels, to the issues they file
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
review:
  max_rounds: 3
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

Use a different agent definition (with its own `model`) for `review`, so the model that wrote a change is not the only one judging it.
