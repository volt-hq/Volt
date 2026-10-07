# Review engines and the review launcher

- Status: Proposal. Nothing here is implemented.
- Date: 2026-10-07
- Audience: Volt maintainers and extension API implementers.
- Scope: How `/review` and review engines that extensions provide (today the project-local `/swarm-review`) share targets, coverage, launching, running, and results.
- Decision: `/review` becomes the one entry point, with an engine choice. The built-in pipeline is the `standard` engine; extensions register engines on the same primitives and submit results to the host's review records. Commands declare typed parameters that drive flag parsing, the launcher form, and completion. Delivery is five independent steps, each its own pull request.

## 1. Objective

`/swarm-review` is a second review engine built beside `/review`. It resolves and freezes its own targets, ships its own repository tools, clusters and verifies on its own, keeps its own dismissal memory, and produces a markdown report outside the host's review records. It takes about fifteen flags and offers no guided launch. The host's review machinery (`review*.ts`, roughly 10,000 lines) already provides what the report lacks: finding ids and statuses, acknowledgment, fix-selected-findings, per-finding discussions, PR publishing, and a handoff into a new conversation.

The extension API has started to grow review-shaped pieces one at a time (an `open` hook that seeds a conversation, a TUI watch for work that opens a conversation). Continued, that reinvents `review_open_session` piecemeal. The aim here is the reverse: extensions use the primitives `/review` uses, and `/review` itself improves where the extension showed its gaps.

### Non-goals

- Sandboxing extensions. An extension is trusted code the user chose to run (see [section 5](#5-trust-model)).
- Compatibility paths. Volt has no users yet: protocols, records, and APIs change in place.
- Changing PR publishing rules or the finding schema beyond additive provenance.
- Exposing the review internals (`review-snapshot.ts`, `review-tools.ts`) as public API. Extensions get narrow primitives, not the structures behind them.

## 2. Current state

Everything in this section was read in the code.

| Surface | `/review` | `/swarm-review` (extension) |
| --- | --- | --- |
| Targets | `uncommitted` (HEAD to worktree), `branch [base]` (merge base to the HEAD commit's tree), `pr`, `commit` | worktree (optionally since a base, including uncommitted and untracked changes), `commit`, `pr` |
| Target resolution | `resolveReviewSnapshot` captures an exact Git snapshot with an identity (`baseTree`, `headTree`, commits) | `git.ts` freezes its own checkout (`baseRev`, `headTree`) |
| Repository tools | Host paged snapshot tools, observed by `ReviewCoverageTracker` | `tools.ts`: read, grep, find, ls, `read_base`, confined to the checkout |
| Passes | Discovery and independent verification in separate contexts; PR runs add a context-blind presentation pass | Many discovery workers in waves, clustering, two verifiers per cluster |
| Result | `ReviewRunRecord` with `ParsedReview`; host-assigned finding ids | Markdown report in the work's output |
| Findings handoff | `review_open_session` seeds a new conversation with the run, the selected findings, and an acknowledgment | None |
| Publishing | `review_publish`: confirmed, complete PR runs only, head verified | None |
| Launch | No arguments: selectors for the target only (TUI-only code). Controls are flags | About fifteen flags, hand-parsed; defaults are constants |
| Live view | Loader replaces the editor, passes draw inline (`ReviewView`), findings open at the end | Work item in the job list |

Facts the design rests on:

- **Work and run identity.** A review is `review` work whose work id is the run id of the `volt.review.run` record it ends with (`review-work.ts`). Finished review work opens by calling `openReviewFindings`.
- **Host-only records.** Review records are written only by the host. The writer an extension gets (`extensionSessionWriter`) has no `recordReviewState`.
- **Anchor validation.** `validateReviewCandidates` requires a finding's `changeLocation` to name an existing, non-binary file on its side, span at most 10 lines, overlap a changed line, and lie in the effective scope. Priority 3 needs `includeOptional`. The fingerprint is derived from the snapshot identity, path, side, category, root-cause key, blob id, and hunk ids.
- **Publishing depends on that validation.** `publishReviewRun` posts a finding inline only if its file appears in `run.target.files` with the matching blob id and its range is at most 10 lines; the confirmation on `review_publish` is the user's gate. It posts the finding text as written.
- **Coverage is observed.** A run is `complete` only if the verifier's assessment is complete, every reviewable hunk is in the verifier's observed hunk set, the changed-file inventory was paged to completion, and PR context was paged. `--effort` sets the pass's thinking level and is passed to the model as a control. I found no use of it that changes the number of passes.
- **Protected PR context.** When a snapshot carries code-host context, `buildParsedReview` throws unless a context-blind presentation report exists for any finding.
- **Extension building blocks that exist.** Work kinds with `delivery`, `detail`, progress, and checkpoints; `ctx.ui.form` (string, boolean, enum, integer fields, rendered by every client); typed manifest `settings` with global and project scopes. `registerCommand` takes a raw argument string.

## 3. Decisions

1. **Extensions use the primitives `/review` uses.** They submit results to the host's review machinery. They do not rebuild it, and the host does not grow a parallel result path for them.
2. **One `/review`, with an engine choice.** The built-in pipeline is the `standard` engine and the default. Extensions register further engines. Whether `/swarm-review` stays as shorthand for `/review --engine swarm` is a convenience question, not compatibility.
3. **One run experience.** Every engine's run is `review` work shown in the job list with its detail data. `/review` stops replacing the editor with a loader.
4. **Typed command parameters.** A command declares its parameters once; the host parses flags, renders the launcher form, and offers completion from that declaration.
5. **The trust model of section 5.**

## 4. Design

The API shapes below are sketches. Names and signatures are not final.

### 4.1 Targets

`resolveReviewSnapshot` mixes two jobs: resolve a selector into an identity (trees, commits, PR identity), and build a snapshot from it. Split them. After the split:

- **A combined target.** `/review` has no target for the common state of a feature branch with some uncommitted edits. `branch` compares the merge base with the HEAD commit's tree, and `uncommitted` compares HEAD with the worktree. A target that compares the merge base with the worktree tree (including untracked files) is the composition of the two existing cases. Whether it is a new kind or an option on `branch` is open (section 7).
- **Tree pairs.** Every kind reduces to a base tree, a head tree, and metadata. A tree-pair identity lets an engine review a state the host kinds cannot express, and is not publishable unless it carries a PR identity.

### 4.2 Coverage

Today `complete` means the final verifier read every hunk. That assumes one verifier over the whole diff, and it makes any multi-pass engine incomplete by construction (swarm's verifiers see cluster-scoped diffs).

Make coverage a property of the run, with multiplicity:

- Each pass has its own observed coverage. The host merges them into a per-hunk count of independent discovery passes that inspected the hunk.
- Each accepted finding must still be verified over its own hunks (the presentation check already enforces this).
- `complete` means every reviewable hunk was inspected by at least k discovery passes and every accepted finding was verified. k follows effort and is 1 for `standard` today.

The run record gains the counts, so the UI can say "covered once" or "covered by 30 passes" and show uneven coverage.

### 4.3 Typed command parameters

```typescript
volt.registerCommand("example", {
  description: "...",
  parameters: {
    target: { type: "string", enum: ["current-pr", "branch", "uncommitted", "commit"], default: "branch" },
    focus: { type: "string", title: "Focus", optional: true },
    effort: { type: "string", enum: ["low", "standard", "high"], default: "standard" },
    workers: { type: "integer", minimum: 1, maximum: 32, default: 30, group: "swarm", when: { engine: "swarm" } },
  },
  handler: async (params, ctx) => {},
});
```

- The field types are the form field types clients already render and validate. Integer bounds and enums come from the declaration.
- The host parses `--name value`, `--flag`, and positional text against the declaration, rejecting unknown or inapplicable flags (a `when` field outside its condition) with a clear error.
- The same declaration renders the launcher form in the TUI and on remote clients, and feeds completion.
- Parameters marked `localOnly` are omitted from remote descriptors and refused on remote invocation. That replaces hand-rolled gates such as swarm's `--exec` check.
- Commands without `parameters` keep the raw argument string.
- Defaults come from settings first (host settings for `/review`, typed manifest settings for an extension), then the declaration. A flag overrides both for one run.

This was first proposed in section 4.3 of the superseded [remote-friendly extensions](extension-remote-ux-design.md) design.

### 4.4 The engine contract

```typescript
volt.registerReviewEngine({
  id: "swarm",
  label: "Swarm",
  description: "Many reviewers, clustered, each cluster verified twice.",
  cost: "Much slower and costlier than standard.",
  parameters: { /* grouped, shown only when this engine is selected */ },
  targets: ["uncommitted", "branch", "commit"],
  run: async (ctx) => {
    // ctx.params, ctx.signal, ctx.progress(...)
    // ctx.snapshot: identity, changed files, hunks (read-only)
    // ctx.tools(options): host snapshot tools for one pass, with coverage()
    // ctx.submit(report)
  },
});
```

- **The host owns the work.** Starting a review of any engine starts `review` work. The work id is the run id, delivery is none, and the work is cancellable. The engine supplies the executor. Opening finished work is the existing `openReviewFindings` path, whatever the engine. There is no per-kind `open` callback and no seed.
- **`standard` is the first engine.** It is registered on the same contract, initially as a thin adapter over the existing `runReview` rather than a rewrite.
- **Observed tools.** `ctx.tools()` returns the host's read-only snapshot tools for one pass and a `coverage()` that the host merges (section 4.2). Coverage is observed, not claimed.
- **Validated submission.** `ctx.submit(report)` takes a summary and findings (`title`, `body`, `trigger`, `impact`, `priority`, `confidence`, `rootCauseKey`, `category`, anchors, and the verification method and rationale). The host re-derives `target.files` from git, validates anchors as in section 2, assigns ids and fingerprints, bounds sizes (the existing 512 KB record limit, plus a new finding-count cap and stripped control characters), and returns accepted findings plus a per-finding rejection reason. It writes the run record.
- **Provenance.** The record carries `source: ext:<extension id>/<engine id>`. The UI, the publish confirmation, and the published body show it, and no run can claim to be the `standard` engine.
- **Rerun and incremental runs.** `reviewTargetForRerun` replays the host engine, so rerun and incremental scope are unavailable for an engine that does not declare support.

#### Mapping swarm's results

| Host field | From swarm |
| --- | --- |
| `id`, `fingerprint` | assigned by the host |
| `changeLocation` | the verifier's `file`, `line`, `endLine`; always the head side |
| `rootCauseKey` | the cluster (a root-cause group by construction) |
| `trigger`, `impact`, `confidence` | the best worker claim in the cluster; these live on the claim, not on the verified finding |
| `body` | the verifier's explanation, plus the fix |
| `verification.method`, `rationale` | "2 verifiers confirmed (N of M workers found it)" plus the verdict reasons |
| `category` | a constant such as `swarm` |
| `priority` | 0 to 2 as reported; P3 needs `includeOptional` |

Swarm anchors "overlapping a changed line where possible". The host rejects those that do not overlap. The engine keeps rejected findings in its own markdown output, and its worker prompt changes to require overlap.

### 4.5 The run experience

Every engine's run is `review` work, so one flow serves all of them:

1. The command starts the work. The TUI opens the job list on it, with progress, steps, and the engine's `detail` data.
2. The user can close the list and keep working. The footer's work line stays.
3. When the work completes and the list still shows it, the TUI opens the findings conversation (`openReviewFindings`) and moves there, as `/review` does today. If the list was closed, a status line says how it ended and Open stays available in `/work`.

The generic start-and-follow watch this needs already exists as a prototype for extension work. `ReviewView` (passes drawn inline) and the review usage in the footer need a home in this flow (section 7).

### 4.6 The launcher

`/review` with no arguments opens one form, rendered from the parameter declaration, instead of a chain of selectors:

```
Review
  What      Branch + uncommitted (vs main)
  Engine    Standard | Swarm   (the cost note of the selected engine shows)
  Focus     [                    ]
  Scope     [                    ]
  Effort    standard
  Advanced  (engine-specific: models, workers, wave size, ...)
  [ Start ]   /review branch main --include-uncommitted
```

- The line under Start echoes the equivalent command, so flags stay learnable and scriptable.
- `standard` is the default engine; a setting changes it. A non-default engine shows its cost note before it starts.
- The form is data, so remote clients render it too.

### 4.7 Swarm as an engine

Stays in the extension: prompts, workers, waves, clustering, verification, and the report text. Goes: target freezing (`git.ts`) and the confined repository tools (`tools.ts`), replaced by the host snapshot and observed tools. Its defaults (workers, wave size, models, thinking) become typed manifest settings. Its hand-written flag parser goes. Dismissal memory (`memory.ts`) stays for now (section 7).

## 5. Trust model

Matches `/review`, because the user chose to run the extension.

- The extension is trusted code. Project-local extensions are gated by project trust, and the manifest permissions (`exec`, `network`, `fs-write`, `secrets`, `providers`) are unchanged. No review permission is added: an extension with `exec` can already post to GitHub as the user, so accepting review results grants no capability.
- Its findings get the same downstream treatment as the host engine's: model output over untrusted code, gated by the `review_publish` confirmation, head verification, and the complete-only rule, and seeded as ordinary context in a fix session.
- The host still validates for integrity and attribution, not defense: schema, bounds, anchors derived from git, and provenance on every run. Review records stay host-written.

## 6. Delivery

Each step is its own pull request, with an issue first.

1. **Targets.** Split resolution from snapshot construction. Add the combined target. Valuable by itself.
2. **Coverage.** Per-pass observed coverage merged with multiplicity; the new completion rule; counts in the record.
3. **Typed command parameters.** The declaration, host parsing, the launcher form, and completion; `/review` adopts it first. Swarm follows with typed settings. Independent of steps 1, 2, and 4. The form picks up the combined target once step 1 lands.
4. **The engine contract.** Snapshot, observed tools, validated submission, provenance, and work ownership. `standard` as the first engine; swarm migrates and shrinks.
5. **One run experience and one entry point.** `/review` moves to the job-list flow, the Engine row appears in the form, and the default-engine setting and cost note ship.

## 7. Open questions

- **PR targets for other engines.** The host requires a context-blind presentation report when a snapshot carries code-host context. Can context capture be skipped for an engine that does not read PR text, or must the host run the presentation pass for it? Until answered, other engines support `uncommitted`, `branch`, and `commit`.
- **Kind or option.** Is the combined target a new target kind or an option on `branch`? What do incremental scope and rerun mean for a worktree target?
- **Coverage thresholds.** The mapping from effort to k, and whether multiplicity changes `complete` for `standard`, which today runs one discovery pass.
- **Merging coverage.** How per-pass trackers merge (set union with counts) and how verification coverage of individual findings is recorded.
- **`--exec` verifiers.** They need a real checkout with a shell. `/review`'s disposable checkout for auxiliary tools may fit; unchecked.
- **Fate of `ReviewView`.** Whether Enter on a running review in the job list shows its current pass conversation (as subagent child conversations open from the inspector), and where the review usage in the footer goes.
- **Dismissal memory.** Swarm remembers rejected clusters in `memory.ts`; the host records finding outcomes (`review_record_finding_outcome`). Whether they merge.
- **Tree-pair snapshots.** Whether the first step adds the tree-pair identity or leaves it for engines that need it.
- **Parameter naming.** Flags valid for one engine only (`--workers`) and collisions between engines' parameters.
- **Shorthand and defaults.** Whether `/swarm-review` stays, and what cost guard a non-default engine needs.
- **Remote presentation.** How phone clients present a run from a non-standard engine (the job list data is the same; the findings views come from the host record).
- **Snapshot lifetime.** The tree objects a worktree capture writes are unreferenced until used; how long the host must keep them for a late submission.

## 8. References

- [Architecture rewrite](architecture-rewrite-design.md): work kinds (section 7) and data-only extensions (section 8).
- [Session format](session-format.md#review-state-entries-host-only): review state entries.
- [Review finding discussions](review-discussions-design.md) (partly superseded).
- [Remote-friendly extensions](extension-remote-ux-design.md) (superseded): the original typed-parameters proposal.
- Code: `core/review.ts`, `core/review-snapshot.ts`, `core/review-report.ts`, `core/review-work.ts`, `core/review-publish.ts`, `core/host/review-handoff.ts`, `core/work/extension-kinds.ts`, `modes/interactive/interactive-mode.ts` (`runReview`, `promptForReviewTarget`), and `.volt/extensions/swarm-review/`.
