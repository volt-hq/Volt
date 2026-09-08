# Compact review output

Status: Proposed. Implementation requires user approval.

## Objective and boundaries

Make the default `/review` completion useful without exposing internal analysis or overwhelming the transcript. Verify the implementation with synthetic review fixtures, rendered TUI assertions, existing privacy tests, and targeted workflow tests.

Preserve review policy, finding acceptance, completeness gates, durable finding IDs, snapshot identity, current session handoff, and retained public evidence. Preserve the model-facing evidence and fix guidance, with the explicit selection/status corrections below. Do not start additional inference to summarize a result.

This task currently produces only this plan in the separate worktree:

- Worktree: `C:/Users/Jordan/source/repos/Volt-review-output`
- Branch: `docs/review-output-plan`
- Base: `670f8f6f203b50b60c71fb673eb4d013b2a18a9e` (local `main`, also the observed `origin/main`)
- The original worktree and its unrelated test modification remain untouched.

The proposed implementation covers the built-in TUI review message, its host-generated presentation data, and redundant local completion notices. RPC-opened review sessions must produce the same presentation data, but this does not redesign the remote client's UI.

Non-goals:

- No new slash command, setting, keybinding, viewer, dependency, or model pass.
- No review engine redesign, execution-capability framework, test runner, or automated test execution during review.
- No RPC command/schema, `ParsedReview` schema, durable run schema, or publication format changes.
- No rewriting of historical session entries, compatibility protocol, or private diagnostic viewer.
- No general custom-message, transcript, HTML export, or mobile UI redesign.
- Do not remove existing confirmations, disclosures, lifecycle events, or extension renderer support.

## Evidence and current behavior

Paths in this document are relative to the worktree unless stated otherwise.

1. `packages/coding-agent/src/core/review.ts:613-675`: `formatReviewForNewSession()` produces the long process introduction, repeated conclusion, exhaustive coverage arrays, findings, and fix instructions.
2. `packages/coding-agent/src/core/review.ts:1732-1774`: `createReviewSeedMessage()` places that text in a displayed custom message. `promoteCompletedReview()` copies the durable run into the replacement session, or adds the message to the current session when switching is cancelled.
3. `packages/coding-agent/src/core/messages.ts:173-203`: `convertToLlm()` sends custom-message content to the model, but not its `details`. A display change must not accidentally remove fix guidance from model context.
4. `packages/coding-agent/src/modes/interactive/components/custom-message.ts`: custom renderers have precedence. Generic rendering currently ignores expansion and displays the whole content.
5. `packages/coding-agent/src/modes/interactive/interactive-mode.ts:4379-4387,9374-9381`: custom components receive expansion state. Completion also adds a redundant result and an unconditional request to select findings to fix.
6. `packages/coding-agent/src/core/review-report.ts:733-826`: completeness and correctness are host-derived. PR model limitations are replaced with counts; these counts do not explain the limitations or make the review incomplete.
7. `packages/coding-agent/src/core/review.ts:1387-1441`: Bash completion records do not record every attempted command or classify successful tests. All tool errors feed the existing failure list. `commandCapable` only checks the requested `bash` name.
8. `packages/coding-agent/src/core/review-state.ts:222-292`: durable coverage and inventory are bounded. Array lengths can represent retained evidence rather than original totals. Incremental review depends on this evidence.
9. `packages/coding-agent/docs/usage.md`, Code Review, and `docs/development.md`: public results exclude private PR analysis and discussion prose. Private diagnostics are a separate, optional host-local surface.

The sample PR #346 result retained 33 observed file paths and 56 hunk IDs. Its private diagnostics described static-only review, not a failed model run. These diagnostics motivate the presentation but must not become runtime input to the new formatter.

## Decision: concise display, preserved full handoff

Keep `message.content` as the complete, public, model-facing report. Apply the bounded full-report changes specified below at its structured formatter, not by parsing or rewriting rendered Markdown.

Add one built-in presentation property to the existing JSON `details` payload produced by `createReviewSeedMessage()`: a host-generated compact Markdown summary. Preserve the existing `target`, `completionStatus`, and `findings` properties.

The summary is a display artifact, not review authority. Generate it from the canonical run, the selected finding IDs, and the already-public result. Do not include raw private diagnostics, prompts, tool output, or free-form PR discovery/verifier text.

Use a built-in review rendering path after an extension renderer has declined or failed, before the existing generic custom-message rendering:

- Collapsed: render the compact summary and the configured expansion hint.
- Expanded: render the complete `message.content` and a collapse hint.
- Generic custom messages remain unchanged. Do not parse historical report text to synthesize missing presentation data.
- Existing stored messages without the new presentation data remain ordinary generic messages. This is not a migration or a promise to improve old report displays.
- Resolve the hint through `app.tools.expand`, as other expandable components do. Do not hardcode `Ctrl+O` in behavior or persisted text.
- Expansion remains the existing global expansion action. Do not imply a new clickable or independently selectable Details control.

The compact display must survive session persistence, reopening, and both regular/fullscreen transcript reconstruction. The metadata is public and may cross existing generic custom-message serialization. It is not a private storage channel.

This intentionally leaves the full report verbose when expanded, in model context, and in HTML exports. Cleaning those audiences is deferred. The default TUI is the first coherent improvement.

## Default output contract

### Header and outcome

Use a short target label and captured revision when available. PR headings use the PR number; the full title remains in the expanded report. For uncommitted reviews, use the captured head tree identity rather than implying the working tree equals a commit. Do not consult moving refs to format a retained result.

Show exactly one outcome statement:

- Complete, whole-run view: count open/accepted P0-P2 findings separately from open/accepted P3 suggestions.
- Incomplete: lead with `Review incomplete` and `No overall conclusion.` Show available findings without implying full coverage.
- Selected-finding view: label it `Selected findings: N of M retained entries`. Do not infer a whole-run clean result from an empty selection. Preserve the full run's completion state and disclose when its P0-P2 findings are outside the selection.
- Fixed/dismissed entries do not inflate active counts. Report their historical count and keep them in expanded evidence. If all original findings are now fixed/dismissed, say `No active P0-P2 findings; N fixed/dismissed entries retained`, not that the original review found nothing.
- Uncertain entries are visible and explicitly labelled uncertain, never currently verified.

Keep the canonical selected ordering. Do not re-sort findings in the TUI independently of model-facing numbered findings. Render the original display number and full durable finding ID for each visible finding.

Each open/accepted/uncertain finding shows priority, title, status, changed-side path and line range, trigger, and impact. Keep body, confidence, additional evidence, and verification rationale in the expanded report. Do not call the model to shorten finding prose or drop findings to satisfy a line budget.

The default view does not display `Overall: correct`, `safe to merge`, repeated no-findings sentences, exhaustive successful-coverage lists, hunk hashes, private model-limitation counts, empty command/failure rows, or internal fix instructions.

### Scope and completeness

Qualify the outcome when explicit path scope or incremental reuse applies. Use retained `options.scope`, `parentRunId`, `incrementalFallbackReason`, and exclusions; do not use the default requested `scopeMode` as proof that a run actually reused prior coverage.

- Explicit scope: `Limited to the selected paths; see details.` Full patterns remain available with the presentation context described below.
- Effective incremental run: `Includes evidence retained from a prior review.` Do not say every path was freshly inspected.
- Full fallback: show it in details, not as an incomplete review. Do not label the result incremental merely because incremental was requested.
- Focus is emphasis, not a path exclusion. Preserve it as context without claiming narrower path coverage.

For incomplete reports, use safe host explanations from structured coverage state: incomplete inventory, incomplete code-host capture, incomplete discovery/verification context inspection, uncertain retained findings. Any remaining incomplete reason gets `Independent verification or in-scope coverage is incomplete; see details.` Do not expose private challenges or reconstruct them from prose.

Do not claim full-file inspection from `filesInspected`. A successful page read records a path. Do not present bounded coverage-array lengths as complete coverage totals. The default clean view need not show successful coverage counts.

### Validation limits

Provide an independently established static-only explanation for new runs. Do not translate model limitation strings into reasons.

At each isolated analysis pass, inspect the effective registered tool surface after session setup. Establish `staticInspectionOnly` only if every active tool is the exact host-owned immutable snapshot/report tool supplied for that pass. Check implementation provenance, not merely names. Take the conjunction across discovery and verification; the optional presentation pass is already constrained to immutable tools.

If this proof cannot be established, keep validation unknown. In particular, no requested `bash` does not prove static-only when an arbitrary auxiliary tool exists. Do not alter tool grants or remove intentional auxiliary tools to make the proof easier.

For a confirmed static-only run, add one shared, fixed host statement to the existing public `coverage.residualRisk` array before persistence:

> Static review only. This review did not run tests or runtime checks.

Keep this distinct from completeness: a static review may be complete. The summary can recognize this exact host-defined statement in public residual risk; it must not parse private or arbitrary model text to classify limitations. Use one shared constant, not loosely matched or localized prose. This is informational presentation only and cannot authorize tools or change the verdict.

For other runs, including retained records without this host statement:

> Runtime validation is not established by this report.

Do not claim command unavailability, successful tests, or absent attempts from `commandsRun`. Do not classify a failed snapshot read as a failed test. If failure observations exist, add `Some review tool attempts failed; see details.` The existing detail count describes tool attempts, not unique tests.

When `modelReportedLimitations` is nonempty, also show `Model-reported limits are recorded in details.` Do not assume that the static-only statement explains every private limitation. Preserve per-phase public counts in the expanded report. Never tell a normal user that private diagnostic files necessarily exist.

### Example: clean PR review

Illustrative output for a newly generated report with the same target and confirmed static-only tools:

```text
Review · PR #346 · eec0db3c22ef
No verified P0-P2 findings in the selected change.

Static review only. This review did not run tests or runtime checks.
Model-reported limits are recorded in details.

Ctrl+O to expand review details
```

The key text is resolved at render time. This example does not retroactively classify old records.

With no extra scope or incompleteness notices, this synthetic case must use at most ten rendered lines at 80 columns, including component spacing. Findings and mandatory warnings are not subject to this ten-line budget.

## Detailed evidence and handoff data

Expansion shows the full public report, including file/hunk inventories, public limit counts, unchecked areas, and finding evidence. Preserve every currently retained item; do not discard arrays to reduce the default view.

The current full report omits some run context. Add a short public context preface when constructing a new seed: run ID, captured tree/revision identity, effective path scope/focus, incremental parent/fallback context, and selection count. Derive this from the canonical durable run. Keep all required fix-selection instructions in content.

Permit these additional bounded changes to the full report:

- Make empty-list wording selection-aware. For an empty selection, say `No findings were selected for this session`, never `The review found no verified issues worth flagging`. Show the full run's active finding count separately, including findings outside the selection.
- Label the finding section `Retained findings` and include each finding's status. Do not describe fixed, dismissed, or uncertain entries as currently verified active findings.
- Label the persisted summary, correctness, and explanation as `Original review conclusion`, with the run's completion timestamp. Canonical status updates do not recompute these fields. Show a separate host-derived `Finding status when this session opened` count from canonical findings. Preserve original conclusions as historical evidence, not an unqualified current verdict. Do not recompute or mutate the stored correctness verdict, including when the original review was incomplete.
- Render every retained `finding.evidenceLocations` entry with its path, side, and line range. These are currently stored but absent from the full report. Do not imply that bounded retained evidence is exhaustive.

Preserve existing finding bodies, triggers, impacts, confidence, verification rationale, coverage evidence, and fix instructions. The context preface and corrected full report must appear on expansion and reach model context.

For selected sessions, render selected entries from the selected result, but compute whole-run state from the canonical full result. The unselected findings remain in the copied durable run. Expansion must identify the selection and must not claim it displays every finding in the full run.

Do not change `get_review_result`, `list_review_workflows`, publication payloads, or finding lifecycle mutations. Canonical APIs remain the authority after outcomes change; the transcript summary is labelled as the state captured when the review session was opened, not a live review dashboard.

## Implementation sequence after approval

1. **Pin behavior with fixtures.** Add formatter fixtures for complete/empty, P0-P2, P3-only, mixed status, incomplete, selected subset/empty selection, explicit scope, effective incremental/full fallback, and bounded evidence.
2. **Record the safe static-only note.** Add the private pass observation in `core/review.ts`, verify actual effective tool provenance, and emit the fixed public residual-risk statement. Do not change public schemas or command telemetry semantics.
3. **Create the display projection.** Put compact formatting in a focused review-presentation module. Extend the built-in seed helper with canonical run/selection context and compact metadata. Apply the specified full-report selection/status corrections and retained evidence-location rendering. Preserve public evidence, instructions, and IDs.
4. **Update all seed call sites.** Cover `promoteCompletedReview()`, interactive review discussion opening, `modes/rpc/rpc-mode.ts` review discussion opening, and `modes/rpc/rpc-command-dispatcher.ts` `open_review_session`. Use fresh canonical records already obtained by those flows. Update direct test consumers of the helper.
5. **Render compactly by default.** Add the built-in fallback in `CustomMessageComponent`, retaining extension precedence and normal generic behavior. Reuse existing expansion state, themes, Markdown rendering, and key hint utilities.
6. **Remove duplicate local completion prose.** Successful handoff needs no second verdict or unconditional fix suggestion. Keep a short session-switch-cancelled notice where necessary. Preserve progress/terminal events used by RPC clients; do not redesign `ReviewWorkflowManager`. Failed/cancelled runs retain their current distinct safe notices and never render a clean result.
7. **Document and validate.** Update user-facing `docs/usage.md` with expansion and static-review meaning. Update keybinding help wording if needed without changing defaults. Add one user-visible changeset fragment. Keep this design repo-only.

Approval of this plan authorizes the built-in seed helper/details contract extension and the four seed call-site changes, not a general public protocol redesign. If inspection shows that schema changes or new execution-capability APIs are required, stop and ask before implementation expands.

## Verification plan

Use the existing faux-provider suite harness. No real provider APIs, keys, or paid tokens.

- `test/custom-message.test.ts`: rendered clean fixture at 80/40 columns; expanded evidence; re-collapse; no line overflow; configured expansion hint; extension precedence; generic custom messages unchanged; regular/fullscreen reconstruction seams.
- A focused `test/review-presentation.test.ts`: all outcome/scope/selection cases; stable selected numbering and IDs; a complete run with a retained P2 finding and `findingIds: []` remains non-clean in both compact and full handoffs; explicit uncertain/fixed/dismissed status in expansion; every retained evidence location appears in expansion; private marker exclusion; retained-only count wording; no repeated trigger/body/verification blocks by default.
- `test/suite/review.test.ts`: host static-only proof, arbitrary auxiliary tools, overridden tool names, tool failures, optional presentation; full model handoff preservation through `convertToLlm`; cancelled/skipped replacement; all handoff callers; no extra inference.
- `test/review-state.test.ts`: static note and display data survive supported persistence/reopening; full coverage remains available; selected sessions retain the canonical run; explicit retention limits remain truthful.
- Existing PR privacy suites: private markers in limitation/challenge/analysis/tool-output fields must remain absent from summary, full seed, durable result, RPC, exports, and publication. Use currently covered serialization seams; do not create a new export architecture.
- RPC review/session tests: selected and empty `findingIds`, canonical status refresh at opening, unchanged response schemas and detached lifecycle. Mark the sole retained P2 finding fixed and, in a separate fixture, dismissed; reopen the report and assert zero active findings, retained historical counts, and an explicitly historical original conclusion in compact/expanded display and model content.
- Confirm distinct notices for incomplete, failed, cancelled, and session-switch-cancelled cases. Do not suppress failed diagnostic-retention warnings.

Run each created/modified test from `packages/coding-agent` with:

```bash
node ../../node_modules/vitest/dist/cli.js --run test/<specific-file>.test.ts
```

Run `npm run check` from the worktree root after code changes, with full output. Run `git diff --check`. Do not run `npm run build`, `npm test`, or the full Vitest suite. Do not install dependencies merely to finish planning; use `npm install --ignore-scripts` only if implementation validation needs a worktree installation, without intentional metadata changes.

For actual terminal observation during implementation, read the `view-cli` skill and use a controlled synthetic/faux-provider review fixture. Do not run a live paid `/review` smoke test without user authorization. Report unavailable terminal or dependency validation rather than treating it as passed.

## Risks and alternatives

- **Shared text for display and model:** retaining full content avoids losing guidance. Compact metadata must never become an authorization source.
- **Historical metadata:** do not recover execution facts from private prose or moving refs. Old entries remain unchanged.
- **Selected findings:** full-run state and selected list must remain separate. Preserve displayed numbering across the compact and full reports.
- **Stale statuses:** reopening consults canonical records; old transcript text is historical.
- **Untrusted presentation fields:** reuse safe terminal/Markdown utilities for paths and titles. Escape data at new formatting seams. Do not create executable links or actions from diagnostic strings.
- **Protocol scope:** metadata already travels through generic JSON channels, but remote UI adoption is not part of this work. No dependent-client behavior is required for correctness.

Rejected alternatives: deleting coverage; replacing the report with `No issues found`; revealing raw model limitations; generating a new model summary; adding a new `/review details` command; silently claiming static-only from missing Bash completions.

## Planning review policy

Three independent discovery consultations covered implementation surfaces, output design, and trust boundaries. The parent verified the key source claims before drafting this plan.

Review each substantive revision with a new subagent. Reviewers inspect this document and relevant source, not an implementation diff. They must report concrete inconsistencies, unsafe claims, missing state cases, and scope problems. They must not edit files or implement the plan.

Revise confirmed issues in this document, then request another fresh review. Stop on an explicit reviewer verdict that no material issues or inconsistencies remain. If reviewers expose irreconcilable requirements, require broader unapproved work, or cannot produce usable evidence, stop with the blocker and ask the user. A clean plan review is not evidence that unimplemented code passes tests.
