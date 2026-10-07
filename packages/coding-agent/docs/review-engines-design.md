# Review engines and the review launcher

- Status: Proposal. Nothing here is implemented.
- Date: 2026-10-07
- Audience: Volt maintainers and extension API implementers.
- Scope: How `/review` and review engines that extensions provide (today the project-local `/swarm-review`) share targets, coverage, launching, running, and results.
- Decision: `/review` becomes the one entry point, with an engine choice. The built-in pipeline is the `standard` engine; extensions register engines on the same primitives and submit results to the host's review records. Typed parameters, declared once, drive flag parsing, the launcher form, and completion. Delivery is a hardening step plus five independent steps, each its own pull request. Eight design choices still need a decision (section 7).

## 1. Objective

`/swarm-review` is a second review engine built beside `/review`. It resolves and freezes its own targets, ships its own repository tools, clusters and verifies on its own, keeps its own dismissal memory, and produces a markdown report outside the host's review records. It takes about fifteen flags and offers no guided launch. The host's review machinery (`review*.ts`, roughly 10,000 lines) already provides what the report lacks: finding ids and statuses, acknowledgment, fix-selected-findings, per-finding discussions, PR publishing, and a handoff into a new conversation.

Growing the extension API one review-shaped piece at a time (for example an `open` hook that seeds a conversation for finished work) would reinvent `review_open_session` piecemeal. The aim here is the reverse: extensions use the primitives `/review` uses, and `/review` itself improves where the extension showed its gaps.

### Non-goals

- Sandboxing extensions. An extension is trusted code the user chose to run (see [section 5](#5-trust-model)).
- Compatibility paths. Volt has no users yet: protocols, records, and APIs change in place.
- Changing PR publishing rules or the finding schema beyond additive provenance.
- Exposing the review internals (`review-snapshot.ts`, `review-tools.ts`) as public API. Extensions get narrow primitives, not the structures behind them.

## 2. Current state

Checked against the code at `403cffa2c`, once by the author and once by an independent read-only review.

| Surface | `/review` | `/swarm-review` (extension) |
| --- | --- | --- |
| Targets | `uncommitted` (HEAD to worktree), `branch [base]` (merge base to the HEAD commit's tree), `pr`, `commit` | worktree (optionally since a base, including uncommitted and untracked changes), `commit`, `pr` |
| Target resolution | `resolveReviewSnapshot` captures an exact Git snapshot with an identity (`baseTree`, `headTree`, commits) | `git.ts` freezes its own checkout (`baseRev`, `headTree`) |
| Repository tools | Host paged snapshot tools, observed by `ReviewCoverageTracker` | `tools.ts`: read, grep, find, ls, `read_base`, confined to the checkout and the original repository root |
| Passes | Discovery and independent verification in separate contexts, with one follow-up round; a context-blind presentation pass for PR runs and for unresolved verifier challenges | Many discovery workers in waves, clustering, two verifiers per cluster |
| Result | `ReviewRunRecord` with `ParsedReview`; host-assigned finding ids | Markdown report in the work's output and as its notice |
| Findings handoff | `review_open_session` seeds a new conversation with the run, the selected findings, and an acknowledgment | None |
| Publishing | `review_publish`: confirmed, complete PR runs only, head verified | None |
| Launch | TUI with no arguments: selectors for the target only. Controls are flags (`--focus`, `--scope`, `--effort`, `--include-optional`, `--incremental` or `--full`). Remote clients start reviews through typed `review_*` intents | About fifteen flags, hand-parsed; defaults are constants |
| Live view | `review` work, which also appears in `/work`. The TUI adds a loader that replaces the editor and draws the passes inline (`ReviewView`), then opens the findings | Work item in the job list only |

### Work and records

- **Work and run identity.** A review is `review` work whose work id is the run id of the `volt.review.run` record it ends with (`review-work.ts`). Finished review work opens by calling `openReviewFindings`.
- **Review records and who can write them.** Run, acknowledgment, finding-transition, and publication records are `custom` log entries typed `volt.review.run`, `volt.review.acknowledgment`, `volt.review.finding-transition`, and `volt.review.publication`, and the host reads them back by `customType` (`hydrateRuns`, last record per run id wins). Only the discussion and alias records are host-only entry types. Two extension paths write arbitrary custom entries with no permission and no type check: `volt.appendEntry`, and the writer given to `newSession` setup (`extensionSessionWriter`, which also exposes `appendCustomMessageEntry` without the host message-type check, and `recordPrReviewBinding`). Nothing reserves the `volt.review.` prefix, so an extension can write, or overwrite, a run record today. Later host reviews read prior runs (`planIncrementalReview` uses coverage, open findings, and dismissed fingerprints from the newest run), and publishing and `review_open_session` read them too. The only reserved-type precedent covers message types (`reservedCustomType` against `HOST_CUSTOM_MESSAGE_TYPES`), not entry types.
- **`/review` is built in.** It is not a registered command: the TUI dispatches it itself (`handleReviewCommand`, `parseReviewCommandArgs`), and remote clients use four typed intents (`review_uncommitted`, `review_branch`, `review_pr`, `review_commit`) that repeat the same options.
- **Run channel today.** A host executor gets `WorkContext`: `progress(p, detail?)`, `checkpoint`, `child`, `output`, `signal`. An executor-reported detail replaces a presented one. An extension executor gets a narrower `WorkRunContext` (progress without detail, checkpoint, output), its `child` is dropped, and its detail comes from a presenter normalized under the extension's action policy, where `open_work` and `cancel_work` are allowed only for work of that extension's own `ext:<id>/` kinds (`ExtensionKinds.owns`). The review usage shown in the TUI footer is read from a root `keyValue` detail node with key `review-usage` (`reviewUsageTotals`). Detail above 8 KiB is dropped first, then steps. `child` is single-valued, and each call is a durable checkpoint, capped at 256 per item.
- **Concurrency.** `WorkRegistry.reserve` counts open items of one kind against `maxActive`. The `review` kind allows 3 (`REVIEW_WORK_MAX_ACTIVE`), extension kinds default to 1. The TUI's `activeReview` flag is client-local. Review work survives an abort of the conversation's run (`cancelOnAbort: false`); swarm's kind does not set that, so aborting a run cancels it.
- **Delivery.** `delivery` is fixed per kind and copied into `work_started`. Only `message` and `wake` kinds queue a notice. `delivery: "none"` keeps the work's `result.output` regardless; `reviewWorkExecution` currently returns only a summary and data.

### Findings and validation

- **Anchor validation.** `validateReviewCandidates` requires a finding's `changeLocation` to name an existing, non-binary file on its side, span at most 10 lines, overlap a changed line, and lie in the effective scope. Priority 3 needs `includeOptional`. `category` and `rootCauseKey` must be kebab-case (at most 80 and 160 characters), and duplicate root-cause anchors and duplicate fingerprints are rejected. The fingerprint hashes the snapshot identity's kind and base tree, the path, the side, the category, the root-cause key, the side's blob id, and the hunk ids.
- **One result path.** `buildParsedReview` takes a candidate report, a verification report, and the snapshot. `validateReviewCandidates` and `declassifyReviewFindings` (which assigns finding ids) run first, then a presentation report (rendered from the private analysis, or by the context-blind pass for protected PR context). The host repairs a pass by re-prompting it, at most twice.
- **Publishing.** `publishReviewRun` posts a finding inline only if its file appears in `run.target.files` with a blob id for the finding's side and its range is at most 10 lines. It does not compare blob ids itself, so the anchor validation above is what keeps inline comments on changed lines. The confirmation on `review_publish` is the user's gate, and the finding text is posted as written. Publishing requires `completionStatus === "complete"` and a `pr` identity.
- **Caps.** A candidate report holds at most 50 candidates. Persisted results are truncated in UTF-8 bytes (`boundPublicReviewResult`): body 2,000, trigger and impact 500, verification method 500 and rationale 1,000, at most 4 evidence locations, and coverage lists 500 items (10 when the record exceeds 512 KB and is rebuilt without evidence). `target.files` has its own 5,000-file and 64 KB cap and is emptied when exceeded.

### Coverage and PR context

- **Coverage is observed.** `hunksInspected` is credited only when a file's whole diff has been paged through the `review_diff` tool (`recordDiffPage`); `review_file` and `review_search` credit nothing toward hunks. A run is `complete` only if the verifier's assessment is complete and there are no unchecked areas: every reviewable hunk must be in the verifier's observed set, and unsupported changed files outside the exclusions, an unpaged changed-file inventory, and unpaged PR context all count against it.
- **What persists.** Each round creates its own discovery and verification trackers. After a successful round they replace the previous ones; they are not merged. Only the verifier's coverage persists (`coverage.hunksInspected`); discovery coverage feeds only the context-paging flag. Incremental planning requires every hunk of an unchanged file to be in the previous run's `hunksInspected` and falls back to a full review beyond the cap.
- **Per-finding hunk check.** `validateReviewPresentations` with coverage runs only inside the PR and challenge presentation passes. `buildParsedReview` calls it without coverage, and per-finding verification is persisted nowhere.
- **Effort and rounds.** `--effort` sets the pass's thinking level and is passed to the model as a control. Nothing that depends on it changes the number of passes. The round loop is a fixed two.
- **Protected PR context.** The `pr` case always captures code-host context together with the PR identity, and there is no option to skip it. The provider resolves the PR's identity, checks, and fetch plan first and only then captures the discussion context (linked issues, comments, reviews, review threads), so the two are structurally separable. Swarm's own PR path (`gh pr view` and `refs/pull/N/head`) reads identity only. When a snapshot carries context, `buildParsedReview` throws unless a context-blind presentation report exists for any retained finding (zero-finding runs never need it), the review tools gain `review_context`, discovery and verification are hosted `localOnly`, and `complete` additionally requires both passes to have paged the context.
- **Snapshot lifetime.** A snapshot of the worktree writes its objects to a temporary object directory that `dispose()` deletes. Afterwards `readFile`, `search`, and `materializeHead` throw, so a snapshot is usable only until its run ends.

### Extension building blocks and the launcher

- **Intents.** The host exposes typed intents with descriptors carrying `input` (JSON Schema), `remote`, `requires`, `confirm`, `presentation`, `slash`, and `completions`. `registerIntent` gives an extension `label`, `description`, `input` (a TypeBox object), `remote`, `requires`, and a handler; extension intents have no `slash`, completion, or `confirm`. Extension commands are exposed as intents `extension.command.<id>.<name>` whose input is `{arguments?, streamingBehavior?}`: the handler receives a raw string. `localOnlyInput` on built-in intents refuses a field at invocation; it does not hide the field from descriptors.
- **Forms.** `ctx.ui.form` takes one-shot fields of four kinds: string (placeholder, `required`, length bounds, `pattern`, `multiline`), boolean, enum (options with labels and descriptions), and integer (`min`, `max`). There is no group, conditional field, optional or default keyword, list, or secret field. Every attached client that accepts the request kind is asked and the first valid answer wins. `settingsFormFields` converts a manifest's flat settings schema into form fields. Typed manifest `settings` have global and project scopes.
- **Flag grammars.** `/review` takes a leading target keyword (`uncommitted`, `unstaged`, `working`, `branch [base]`, `pr [number]`, `commit [ref]`, or `tools`), then flags with space-separated values; `--scope` repeats and splits on commas; `--incremental` and `--full` are a pair; a bare `commit` opens a picker. Swarm takes `--name value` or `--name=value` flags (`--exec=1` is rejected), joins every stray word into the focus text, allows at most one of `--base`, `--commit`, and `--pr`, and clamps and defaults across fields (`wave-size` to `workers`, `concurrency` to the wave size).
- **Defaults.** `/review` sends constant defaults explicitly (`DEFAULT_REVIEW_RUN_CONTROLS`). Swarm resolves a model from its flag, then a hard-coded default, then the host's `reviewModel` or `reviewVerifierModel`; it never falls back to the conversation's model, which a null host setting would mean.
- **Aliases.** There is no command alias mechanism. An extension command named `review` is skipped in the TUI menu on conflict, and because `/review` is not registered, `/swarm-review` cannot delegate to it.

## 3. Decisions

1. **Extensions use the primitives `/review` uses.** They submit results to the host's review machinery. They do not rebuild it, and the host does not grow a parallel result path for them.
2. **One `/review`, with an engine choice.** The built-in pipeline is the `standard` engine and the default. Extensions register further engines. Whether `/swarm-review` stays as shorthand for `/review --engine swarm` is a convenience question, not compatibility.
3. **One run experience.** Every engine's run is `review` work shown in the job list with its detail data. `/review` stops replacing the editor with a loader.
4. **Typed parameters, declared once.** The declaration drives flag parsing, the launcher form, and completion. Where it is declared is open (D1).
5. **The trust model of section 5.**

## 4. Design

The API shapes below are sketches. Names and signatures are not final.

### 4.0 Prerequisite: reserve host-owned log types

Before any provenance claim holds, extensions must not be able to write the host's review records. Refuse a `customType` starting with `volt.review.` at the two extension write paths (`volt.appendEntry` and the `newSession` setup writer), as `reservedCustomType` does for message types. The check must not sit in log admission or import: forks and imports legitimately copy these entries. Whether the setup writer should also stop exposing `recordPrReviewBinding` and an unchecked `appendCustomMessageEntry` is open (section 7.2). This step is small and independent of everything else.

### 4.1 Targets

`resolveReviewSnapshot` mixes two jobs: resolve a selector into an identity (trees, commits, PR identity), and build a snapshot from it. Split them. The identity step has to return the resources behind it (the Git source, its temporary directories, and a dispose handle), not just trees, because a worktree head tree exists only as objects in a temporary directory.

- **A combined target.** `/review` has no target for the common state of a feature branch with some uncommitted edits. A target that compares the merge base with the worktree tree (including untracked files) needs a single Git source that sees the base tree, the worktree tree, and both trees' blobs. With a local base this is easy: the uncommitted source already sees all local objects, so run `merge-base` there. A remote base lives only in an isolated bare repo, so its objects directory must be added to the alternates and the source's object directories, and its temporary directory to the dispose list. The `baseTree` argument of `captureWorktreeTree` stays the HEAD tree (it only seeds the index when none exists); the empty-diff check compares the captured tree with the merge-base tree. HEAD should be re-checked after the capture, as `branch` pins it.
- **Identity and rerun.** `reviewHeading` shows `tree <headTree>` only for kind `uncommitted`, so a worktree identity must not set `headCommit`. `reviewTargetForRerun` falls through to `commit` for any kind it does not name, which would review the wrong thing or fail, so a new kind needs an explicit branch there. Whether the combined target is a new kind or an option on `branch` is D2.
- **Tree pairs.** Every kind reduces to a base tree, a head tree, and metadata. A tree-pair identity lets the host review a state its kinds cannot express. It is not publishable: `publishReviewRun` requires a `pr` identity.

### 4.2 Coverage

Today `complete` requires the final verifier to have paged every reviewable hunk. That assumes one verifier over the whole diff, and it makes any multi-pass engine incomplete by construction (swarm's verifiers see cluster-scoped diffs). Today's coverage is also thin: only the last successful round's verifier coverage persists, and discovery coverage is unused.

Make completeness a policy of the engine, over observed coverage:

- **`standard` keeps today's rule.** The verifier's assessment is complete and its observed coverage leaves no unchecked areas. The publish gate (`completionStatus === "complete"`) is unchanged.
- **A multi-pass engine declares a policy.** `complete` means its verification stage reported no unresolved challenge, there are no other unchecked areas, every reviewable hunk was inspected by at least k independent discovery passes, and every accepted finding was verified over its own hunks. k follows effort.
- **Multiplicity is recorded in a bounded shape.** A histogram (hunks by number of passes that inspected them) plus a bounded list of hunks below k is cheap. Full per-hunk counts hit the 500-item cap, and counts packed into `target.files` risk that list's own cap. The shape also needs the closed coverage schema in `packages/protocol/src/projections.ts` and the contract JSON updated. The UI can then say "covered once" or "covered by 30 passes" and show uneven coverage.
- **Observed means through host calls.** Coverage is credited only through the host's paged tools. An engine that inlines diffs into its prompts, as swarm does, gets credit through a host call that returns the diff text for a set of hunks and records them as delivered to that pass. That proves the host delivered the bytes, not that a model read them or that passes were independent; the existing paging has the same limits but at least needs a model-issued tool call. For this to mean anything the snapshot context must not expose patch text directly, since direct reads are unobserved.

### 4.3 Typed parameters

The declaration is a flat schema in the vocabulary typed manifest settings already use (`type`, `enum`, `default`, `title`, `minimum`, `maximum`, `pattern`), mapped onto the wire form fields (`kind`, `value`, `label`, `min`, `max`, `required`):

```typescript
parameters: {
  target: { type: "string", enum: ["uncommitted", "branch", "pr", "commit"], default: "branch" },
  engine: { type: "string", enum: ["standard", "swarm"], default: "standard" },
  focus: { type: "string", title: "Focus" },
  effort: { type: "string", enum: ["low", "standard", "high"], default: "standard" },
  workers: { type: "integer", minimum: 1, maximum: 32, default: 30, group: "swarm", when: { engine: "swarm" } },
}
```

`group`, `when`, and a per-field `localOnly` are new keywords; the rest exists. Where the declaration lives (the intent's input schema, `registerCommand`, or a new concept) is D1.

- A client parses `--name value`, `--flag`, and positional text against the declaration and rejects unknown or inapplicable flags (a `when` field outside its condition) with a clear error. `engine` is resolved first (flag, then setting, then default), and the other parameters are then parsed against that engine's declaration.
- The same declaration renders the launcher form and feeds completion.
- `localOnly` fields are omitted from remote descriptors and refused on remote invocation. Descriptor omission is new behaviour (today `localOnlyInput` only refuses at invocation), and extensions have no per-field gate at all. It replaces the `invokedBy` check in swarm's `--exec` gate; the interactive confirmation stays in the extension, and `remoteSafe` still decides whether a command runs remotely at all.
- The existing grammars must stay expressible: a leading keyword with a conditional positional (`branch main`), aliases (`unstaged`, `working`), a `tools` subcommand, repeatable comma-split lists (`--scope`), a boolean pair that maps to one enum (`--incremental` or `--full`), trailing free text, `--name value` and `--name=value`, cross-field defaults and clamps, mutual exclusion (`--base`, `--commit`, `--pr`), dynamic enums (models), and kebab-case flags for camelCase keys. A declaration alone may not cover all of them; whether a custom parse hook is allowed is open (section 7.2).
- Defaults come from settings where a setting exists (host settings for `/review`, typed manifest settings for an extension), then the declaration. A flag overrides both for one run. Making settings win for swarm's models would change its behaviour (see section 2).
- Commands without parameters keep the raw argument string.

This was first proposed in section 4.3 of the superseded [remote-friendly extensions](extension-remote-ux-design.md) design.

### 4.4 The engine contract

```typescript
volt.registerReviewEngine({
  id: "swarm",
  label: "Swarm",
  description: "Many reviewers, clustered, each cluster verified twice.",
  cost: "Much slower and costlier than standard.",
  parameters: { /* grouped, shown only when this engine is selected */ },
  targets: ["uncommitted", "branch", "commit", "pr"],
  pullRequestContext: false,  // true: the host also captures PR discussion context and runs the context-blind presentation pass
  rerun: false,      // whether rerun and incremental runs may replay this engine
  maxActive: 1,
  run: async (ctx) => {
    // ctx.params, ctx.signal
    // ctx.progress(progress, detail?), ctx.checkpoint(progress, detail?), ctx.output(text)
    // ctx.snapshot: identity and changed-file metadata, no patch text
    // ctx.pass(): { tools(), diff(hunkIds), coverage() }, one per independent pass
    // ctx.validate(candidates): dry run of the host's anchor validation
    // ctx.submit({ candidates, verification })  // called inside run
  },
});
```

- **The host owns the work.** Starting a review of any engine starts `review` work: work id is the run id, `cancelOnAbort: false`, delivery none, cancellable. The engine supplies the executor. Opening finished work is the existing `openReviewFindings` path, whatever the engine; there is no per-kind `open` callback and no seed. This needs a host start path for engine runs, because `ExtensionKinds.start` starts only `ext:<id>/` kinds with a random id and `prepareReviewWorkflow` is specific to the standard pipeline (it throws when no model is available for review).
- **`standard` is the first engine.** It is registered on the same contract, initially as a thin adapter over the existing `runReview`, which needs a no-dispose option so the host can own the snapshot's lifetime.
- **The run channel.** The engine's context is an adapter over the host `WorkContext`. Needed changes: expose `detail` and `checkpoint` on it; make `ownsWork` accept review work started for that extension's engine, so its detail actions can target `cancel_work` and `open_work` on its own run; compose the engine's detail with the `review-usage` root node the footer reads, within the 8 KiB budget. `child` is single-valued and capped, and swarm's parallel sessions are not hosted conversations, so engines cannot link one conversation per pass (the standard engine keeps that).
- **One result path.** `ctx.submit` takes the host's own report shapes: a candidate report (title, body, trigger, impact, category, root-cause key, priority, confidence, anchors) and a verification report (a decision per candidate, the verifier assessment and challenge, limitations). The host runs `validateReviewCandidates`, `declassifyReviewFindings`, and `buildParsedReview`, so decision 1 holds. The engine supplies what only it knows: verification method and rationale, assessment and challenge, limitations, commands run and failed attempts, and the summary. The host derives ids, fingerprints, scope and exclusion handling, `completionStatus`, `overallCorrectness`, caps, `target.files` from git, and writes the record, including failed and cancelled records and the accounting message for runs without a result.
- **Repair.** The host repairs a pass by re-prompting it. A submit after the fact cannot, so rejected candidates would be dropped. `ctx.validate` exposes the same anchor validation as a dry run, so an engine's own report tools can repair in the loop, as swarm's `report_verdict` already does.
- **Usage accounting.** The host's `ReviewUsageCollector` is fed through `createAgentSession`'s inference accounting, with a phase limited to discovery, verification, and presentation and at most 1,024 attempts. Swarm passes none and sums messages itself, and its clustering pass fits no phase. How engine usage reaches `ReviewRunRecord.usage` is open (section 7.2).
- **Validated, bounded, attributed.** The host bounds sizes (the existing 512 KB record limit, the 50-candidate cap, and the persisted-field truncations, which cut a long body, plus stripped control characters). The record carries `source: ext:<extension id>/<engine id>`, shown in the UI, the publish confirmation, and the published body. With the step 0 reservation, no run can claim to be the `standard` engine.
- **PR runs.** PR review is the main use, so engines support the `pr` target. An engine that declares `pullRequestContext: false` (swarm reads no PR text today) gets a PR snapshot resolved at a capture level of identity only: the provider returns the identity and fetch plan and skips the discussion block, so `codeHostContext` is absent, `protectedContext` is false, no context-blind presentation pass is required, and completion has no context-paging clause. `standard` keeps the full capture and the protected path unchanged. An engine that wants the discussion context would need a host-run presentation pass, which this design does not include. Engine PR runs are publishable (`publishReviewRun` needs a complete run, a `pr` identity, a verified head, and the user's confirmation), so the confirmation and the posted body show the engine as the source. The published text is verifier prose that did not pass through the context-blind pass; it derives from the diff and code only, as on every other target, and the user confirms it before it is posted. The engine start path must apply the same PR review binding check as `runReview` (`readPrReviewBinding`) before a PR run.
- **Rerun and incremental runs.** `reviewTargetForRerun` replays the host engine, so rerun and incremental scope are unavailable for an engine that declares `rerun: false`. `planIncrementalReview` takes the newest run of any source, so it and `review_rerun` filter runs by engine. The run record gains `engine` and bounded `engineParams` (today `options` holds `ReviewRunControls` only), so a rerun can reproduce an engine run.
- **Delivery and what is lost.** The engine's report text stays as the work's `output`. Gone is the notice that rode the next turn in the invoking conversation, and Escape cancelling from the editor (cancel remains in the job list). The disputed, uncertain, rejected, and cost sections of swarm's report have no home in `ParsedReview`; they live only in the output. Gained: finding ids and statuses, acknowledgment, `review_open_session`, and discussions. Whether the findings conversation also carries engine-supplied extra sections is D5.
- **Concurrency.** One `review` kind with a cap of 3 cannot express per-engine limits. A per-engine limit needs a limit key checked inside `reserve` (D7).
- **Lifetime.** `submit` and `validate` need a live snapshot, so they happen inside `run`; the host disposes the snapshot after `run` returns.

#### Mapping swarm's results

A swarm finding maps onto a host candidate plus a verification decision:

| Host field | From swarm |
| --- | --- |
| `id`, `fingerprint` | assigned by the host |
| `changeLocation` | the verifier's `file`, `line`, `endLine`; always the head side. Must overlap a changed line and span at most 10 lines |
| `rootCauseKey` | a kebab-case slug of the cluster title, since cluster ids such as `K1` are neither kebab-case nor stable across runs. One cluster can yield several findings, so the slug takes a suffix to stay distinct |
| `trigger`, `impact`, `confidence` | the best worker claim in the cluster; these live on the claim, not on the verified finding |
| `body` | the verifier's explanation, plus the fix; the host truncates the persisted body to 2,000 bytes |
| `verification.method`, `rationale` | "N verifiers confirmed" (two, or one for a single-verifier cluster) plus the verdict reasons |
| `category` | a kebab-case constant such as `swarm` |
| `priority` | 0 to 2 as reported; P3 needs `includeOptional` |

Swarm anchors "overlapping a changed line where possible". The host rejects those that do not overlap. The engine keeps rejected findings in its own output, and its worker prompt changes to require overlap. More than 50 candidates in one report is also a rejection.

### 4.5 The run experience

Every engine's run is `review` work, so one flow serves all of them:

1. The command starts the work. The TUI opens the job list on it, with progress, steps, and the engine's `detail` data.
2. The user can close the list and keep working. The footer's work line stays.
3. When the work completes and the list still shows it, the TUI opens the findings conversation (`openReviewFindings`) and moves there, as `/review` does today. If the list was closed, a status line says how it ended and Open stays available in `/work`.

The TUI needs a start-and-follow watch for command-started work. The host does not say which client started work, so the TUI can only watch around the commands it sent itself, unless the command's result carries the started work ids. `/review` already links each pass as the work's `child`, and `ReviewView` and the review usage in the footer need a home in this flow (section 7.2).

### 4.6 The launcher

`/review` with no arguments opens a form rendered from the parameter declaration, instead of a chain of selectors:

```
Review
  What      Branch + uncommitted (vs main)
  Engine    Standard | Swarm   (the cost note of the selected engine shows)
  Focus     [                    ]
  Scope     [                    ]
  Effort    standard
  Advanced  (engine-specific: models, workers, wave size, ...)
  [ Start ]   /review branch main --include-uncommitted   (illustrative: the flag is undecided)
```

- The line under Start echoes the equivalent command, so flags stay learnable and scriptable.
- `standard` is the default engine; a setting changes it. A non-default engine shows its cost note before it starts.
- A form today is one-shot with no conditional fields, so the Engine row cannot swap the Advanced fields live. The default is a two-step launcher: engine first (`ctx.ui.select` takes plain strings, so the cost note goes in the labels or the form title; `ctx.ui.dialog`, which takes a body and action buttons, is an alternative), then that engine's form. That needs no protocol change and works in the TUI and, for `remoteSafe` commands, on a phone. When a TUI and a phone are both attached, their dialogs race and the first valid answer wins. A live dependent form needs a new client frame or intent (client frames today are only hello, subscribe, unsubscribe, and host response), a patchable host request, and changes in the TUI form, the protocol contract, and volt-app (D6).

### 4.7 Swarm as an engine

Stays in the extension: workers, waves, clustering, verification, and the report text. Changes: the prompts (they name read, grep, find, ls, `read_base`, and a frozen checkout), and the code that consumes `git.ts`'s `ReviewTarget`: `workers.ts` (shards, partial files, submodules, checkout), `verify.ts` (complete flag, per-file diffs, `createCheckout`, checkout), `prompts.ts` and `report.ts` (description, scope, stat), `session.ts` and `tools.ts` (checkout, repository root, base revision), and `memory.ts` (common directory and checkout). Its defaults (workers, wave size, models, thinking) become typed manifest settings, and its hand-written flag parser goes.

What the host snapshot gives today (`changedFiles` with hunk patches, `readFile` on either side up to 8 MiB, `listFiles`, a literal-substring `search`, `materializeHead`, `root`, `identity`) leaves real gaps:

1. `materializeHead` creates a fresh checkout but does not link `node_modules`, which swarm's `--exec` verifiers need. An engine can link them itself if it gets `root` and a checkout.
2. There is no diff-text API (`pathDiffText` is private). Concatenating hunk patches loses file headers, and the engine would redo its own sharding. Section 4.2 adds a host diff call that also credits coverage.
3. The six review tools have no regex or glob search, and live-workspace `read`, `grep`, `find`, and `ls` are excluded from reviews (`MUTABLE_WORKSPACE_REVIEW_TOOLS`), so the prompts change.
4. The review context files loader is private to the host.
5. The repository's common directory (swarm's memory key) is not in the snapshot; the engine can ask git.
6. Anchors must overlap changed lines (section 4.4).
7. `--pr` is supported through the identity-only PR snapshot (D3), and `--base` needs the combined target.

## 5. Trust model

Matches `/review`, because the user chose to run the extension.

- The extension is trusted code. Project-local extensions are gated by project trust, and the manifest permissions (`exec`, `network`, `fs-write`, `secrets`, `providers`) are unchanged. No review permission is added. An extension with `exec` can already post to GitHub as the user, so accepting review results grants it nothing. An extension with no permissions can already write `volt.review.*` custom entries (section 2); step 0 closes that, so a run record means "written by the host".
- Its findings get the same downstream treatment as the host engine's: model output over untrusted code, gated by the `review_publish` confirmation, head verification, and the complete-only rule, and seeded as ordinary context in a fix session. A forged "complete" prior run could make later host reviews skip files (incremental planning trusts it), which is another reason for step 0.
- The host still validates for integrity and attribution, not defense: schema, bounds, anchors validated against git, and provenance on every run. Run records are written by the host on submission.

## 6. Delivery

Each step is its own pull request, with an issue first. This is the baseline order; section 7.3 gives the order if the proposed resolutions are confirmed.

0. **Reserve host-owned log types.** Section 4.0. Independent and small.
1. **Targets.** Split resolution from snapshot construction and unify the Git source. Add the combined target. Valuable by itself.
2. **Coverage.** Per-pass observed coverage merged with multiplicity, the host diff call, per-engine completeness policy, and the bounded record shape.
3. **Typed parameters.** The declaration (D1), host or client parsing, the launcher form, and completion; `/review` adopts it first, which means giving today's hard-coded TUI dispatch (`handleReviewCommand`) and four typed intents a declaration (D8). Swarm follows with typed settings. Independent of steps 1, 2, and 4; the form picks up the combined target once step 1 lands.
4. **The engine contract.** The host start path, run channel, snapshot context, `ctx.validate` and `ctx.submit`, provenance, rerun filtering, and per-engine limits. `standard` as the first engine; swarm migrates and shrinks.
5. **One run experience and one entry point.** `/review` moves to the job-list flow, the Engine row appears in the form, and the default-engine setting and cost note ship.

## 7. Decisions and open questions

### 7.1 Decisions needed

Each lists the options the code permits and a lean. A delegate acting on the maintainer's stated positions then proposed a resolution for each. Those are proposals, not approvals: sections 4 and 6 still describe the options until the resolutions are confirmed, and section 7.3 lists what needs the maintainer's explicit approval regardless. Confirmed by the maintainer on 2026-10-07: D1, D2, D3 (the identity-only PR capture, with the confirmation naming the engine as the source), D4 (the minimal completeness rule, with the confirmation saying the coverage is reported by the engine), D5, D6, D7, D8, step 0, and that the combined target (step 1) is not deferred.

- **D1. Where parameters are declared.** (a) On the intent's input schema, adding `slash`, completion hooks, and field-level local-only to extension intents, with a client-side parser and form renderer; remote clients already send typed input and never parse text. (b) On `registerCommand`, parsed by the host before the handler; this also serves prompt-text clients but changes the prompt path and handler signature. (c) A separate concept beside both; it duplicates the intent schema. Lean (a), the cheapest and the one that matches the architecture's typed-input mechanism. Either way a generic flag parser and a schema-to-form renderer for intent inputs are new; the only existing schema-to-form path is for manifest settings. **Proposed resolution:** (a), narrowed. Declare on the host `/review` intent's input schema first; the descriptor's `input` is opaque JSON Schema, so `group`, `when`, and `localOnly` need no descriptor schema change. Do not add `slash` or completion hooks to extension `registerIntent` in this program, since that would rebuild `/review` piecemeal for swarm only for step 4 to replace it; engine `parameters` reuse the vocabulary in step 4. Confidence medium: the maintainer has not said where, and general extension commands may need typed parameters before engines ship.
- **D2. The combined target.** (a) A new target kind: clean identity, fingerprints, and incremental chains, but it touches the closed protocol enum (`projections.ts`) and the contract JSON, `provisionalReviewTarget` (an exhaustive switch), `reviewTargetForRerun`, `reviewHeading`, a new or extended intent, the TUI picker, docs, and a volt-app issue. (b) An option on `branch`: smaller, but `identity.kind` stays `branch`, so a persisted marker is needed or rerun reviews the committed HEAD only, and worktree runs share fingerprints and incremental compatibility with committed branch runs (equal kind and base tree). Lean (a). **Proposed resolution:** (a), a new kind. Confidence medium to high. Swarm's default target is already uncommitted against HEAD, so step 4 does not wait on it.
- **D3. PR targets for other engines.** Nothing skips context capture today, and an engine that never reads context cannot reach `complete` on a PR because completion requires context paging. Options: (a) unsupported in the first version; (b) an include-context flag with optional context; (c) derive `protectedContext` from "a pass was given context" instead of "context captured"; (d) a host-run presentation pass inside `submit`, which needs models and conflicts with synchronous accept and reject. Lean (a); (b) and (c) are medium cost. **Resolution (maintainer constraint):** PR review is the maintainer's main use, so engines must support PR targets and option (a) is rejected. Take (b) in its narrow form: a capture level of identity only for engines that declare `pullRequestContext: false` (section 4.4). The provider already resolves identity and fetch plan before the discussion block, and swarm's own PR path reads identity only, so this matches swarm's behaviour today. (c) is the fallback and (d) is deferred.
- **D4. The completeness policy.** Section 4.2 proposes engine-declared policies with `standard` unchanged. Needs agreement on k and effort, whether zero-finding runs are complete, and whether the follow-up round should merge coverage with the first round instead of replacing it. **Proposed resolution:** an engine-declared policy with `standard` unchanged, and a minimal first slice: `complete` means the engine's assessment is complete, there are no unchecked areas, and every reviewable hunk was delivered through the host diff call to at least one pass (a union). Multiplicity, the histogram, and the coverage-schema change come later; zero-finding runs follow `standard`'s rule; the follow-up round keeps replacing coverage. Complete for an engine run then proves delivery only, which attribution (`source`) mitigates. **Confirmed by the maintainer:** this minimal rule, with the publish confirmation saying the coverage is reported by the engine. Engine PR runs are publishable (D3), so the label gates publishing; a stricter rule (every hunk seen by several passes, k above 1) can follow later.
- **D5. Engine report extras.** Disputed, uncertain, and rejected clusters and cost have no home in `ParsedReview`. (a) Output only. (b) A bounded extra-report field the findings conversation also carries. Lean (a) first. **Proposed resolution:** (a); (b) would add a field to `ParsedReview` and the review schemas, which section 1 rules out. Confidence high.
- **D6. The launcher.** Two-step (no protocol change) or a live dependent form (a new frame, a patchable request, TUI and volt-app changes). Lean two-step. **Proposed resolution:** two-step. Confidence high.
- **D7. Concurrency.** Keep the shared `review` cap of 3, or add a limit key to `reserve` for per-engine limits. A launcher-side count only holds if it runs in the same tick as `start()`. **Proposed resolution:** keep the shared cap of 3 and drop `maxActive` from the engine sketch; a limit key adds a registry concept for one consumer. The cost is up to three concurrent swarms instead of one. Confidence medium: ask the maintainer about cost limits.
- **D8. `/review`'s declaration.** Keep the four typed intents and add a declaration the TUI parses, or collapse them into one intent with a `target` union (a slash name shared by several built-in intents is treated as a TUI command today). Collapsing removes the repeated options and makes `/review` an ordinary declared command. **Proposed resolution:** collapse into one `review` intent with a `target` union. The four intents share one `reviewStart` definition and the `/review` slash alias today, and `engine` and its parameters would otherwise repeat four times, with a fifth intent for the combined target. It renames intents and changes schemas in the protocol and the contract JSON, so it needs a volt-app issue. Confidence medium.

### 7.2 Smaller open questions

- **Setup writer exposure.** Should the `newSession` setup writer still expose `recordPrReviewBinding` and an unchecked `appendCustomMessageEntry`?
- **Parse hook.** Whether a declaration may carry a custom parse function for grammar it cannot express, and how collisions between engines' flags are reported (`--model`, `--verifier`, positional focus versus `--focus`, `--scope` and `--effort` versus `--thinking`).
- **`--exec` verifiers.** Link `node_modules` in `materializeHead`, or leave it to the engine.
- **Dismissal memory.** Swarm's per-repository file with a 90-day TTL keyed by snippet hash, versus the host's finding outcomes (`review_record_finding_outcome`) in the session log, used only through the previous run's incremental plan. Whether they merge.
- **Engine usage accounting.** A new accounting phase for clustering or engine passes, and the 1,024-attempt bound.
- **`ReviewView`.** Passes of the standard engine stay linked as `child`; whether Enter on a running review in the job list shows the current pass (finished review work opens its findings today), and where the review usage in the footer goes.
- **Remote presentation.** Non-standard runs on the phone use the same work value and host record; whether the app needs changes.
- **Context files.** Whether the host's review context files are exposed to engines.
- **Incremental effects.** How multiplicity and a worktree target interact with incremental planning, which today requires equal kind and base tree and falls back to a full review beyond the persisted caps.
- **PR binding and fix sessions.** Confirm that the PR review binding and checkout placement apply to engine PR runs and their findings conversation exactly as for `standard`.
- **Shorthand.** Whether `/swarm-review` stays, and the cost guard wording for a non-default engine.

### 7.3 If the resolutions are confirmed

- **Delivery order.** 0 (reserve host-owned log types), 3a (collapse the four intents into one, with no new API), 1 (targets, including the new kind), 2 reduced (the host diff call, union coverage, the engine policy flag), 3b (typed parameters, host `/review` only), 4 (the engine contract; swarm moves to typed settings here), 5. Step 4 does not need step 1, but the maintainer wants the full functionality, so step 1 (the combined target) keeps its place and is not deferred. Step 4 carries the identity-only PR capture level. Step 2 must land before step 4. In step 4, `maxActive` leaves the sketch, provenance appears in the publish confirmation and the posted body (engine PR runs are publishable), and `targets` is `uncommitted`, `branch`, `commit`, and `pr`.
- **Smaller questions by step.** Before step 1: setup writer exposure (step 0's scope), and kind and base-tree compatibility for the worktree target. Before step 3: the parse hook. Before step 4: engine flag collisions, engine usage accounting, `--exec` and `node_modules`, and context files. Can wait: dismissal memory, multiplicity effects on incremental runs, remote presentation (file the volt-app issue before step 5), `ReviewView` and footer placement, and shorthand and cost-guard wording.
- **Needs the maintainer's explicit approval regardless:** the intent rename and protocol change (D8) with its volt-app issue; the new target kind in the protocol and contract (D2); the new declaration keywords and `registerReviewEngine` with `ctx.pass`, `ctx.validate`, and `ctx.submit` as public extension API (D1); the identity-only PR capture level in the code-host provider interface and the `pullRequestContext` engine declaration (D3); step 0's refusal of `volt.review.*` entries and what happens to `recordPrReviewBinding`; the step 4 changes extension authors see (swarm runs as `review` work with `cancelOnAbort: false`, loses the notice and Escape cancel, goes from one concurrent run to three, has non-overlapping anchors rejected, has rerun off unless it declares support, and has the `localOnly` field replace the `invokedBy` check on `--exec`, which is a security gate that needs a careful review); and step 5, where `/review` stops replacing the editor with a loader.
- **Status of those approvals.** The maintainer confirmed D1, D2, D5, D6, D7, D8, and step 0 as proposed. The step 4 changes extension authors see, and the `localOnly` replacement of the `--exec` gate, still need a look when step 4 is built.

## 8. References

- [Architecture rewrite](architecture-rewrite-design.md): work kinds (section 7) and data-only extensions (section 8).
- [Session format](session-format.md#review-state-entries-host-only): review state entries.
- [Review finding discussions](review-discussions-design.md) (partly superseded).
- [Remote-friendly extensions](extension-remote-ux-design.md) (superseded): the original typed-parameters proposal.
- Code: `core/review.ts`, `core/review-snapshot.ts`, `core/review-report.ts`, `core/review-state.ts`, `core/review-tools.ts`, `core/review-work.ts`, `core/review-publish.ts`, `core/host/review-handoff.ts`, `core/work/registry.ts`, `core/work/extension-kinds.ts`, `core/session/extension-binding.ts`, `core/session-writer.ts`, `core/protocol/intents/`, `modes/interactive/interactive-mode.ts` (`runReview`, `promptForReviewTarget`, `handleReviewCommand`), and `.volt/extensions/swarm-review/`.
