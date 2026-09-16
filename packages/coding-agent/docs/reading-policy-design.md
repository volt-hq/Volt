# Evidence-driven reading policy

Development note, 2026-09-16.

## Decision

Use a default reading policy of locate, read a coherent region, and expand when
needed. This changes model guidance, not tool permissions or output limits.

- Locate unknown targets with search or code intelligence; read known targets
  directly rather than requiring a search ritual.
- Read complete relevant functions, classes, or document sections with enough
  surrounding context to understand the behavior before editing.
- Expand to dependencies, callers, tests, or whole files when evidence is
  incomplete or the requested change/audit requires broader coverage.
- Avoid tiny repeated slices and rereading unchanged material already in context.
  Search snippets and truncated output are not proof of full coverage.
- Stop gathering when the evidence supports the requested decision or change, not
  after a fixed number of lines, calls, or tokens.
- Preserve explicit full-file requests and required instruction/skill reading.
  Routine read-range choices belong to the agent, not the user.
- Consult relevant Volt documentation and examples, following links needed for the
  task rather than recursively ingesting the README and every linked document.

The default prompt in `src/core/system-prompt.ts` owns the general policy.
Repository `AGENTS.md` no longer contradicts it with blanket full-file inspection.
Custom system-prompt replacement remains a deliberate customization boundary:
this non-safety reading guidance is not forcibly appended to custom prompts.

## Research basis and limits

These are evidence-informed design choices, not measured savings for Volt. The
research review used publication abstracts, author summaries, and interface
examples; it is not a reproduction of the experiments or a systematic review.

- [SWE-agent (2024)](https://arxiv.org/abs/2405.15793): agent-computer interface
  design affects software-engineering performance. Bounded, navigable views are
  a useful precedent, not evidence for one universally optimal read-window size.
- [Sufficient Context (2025)](https://research.google/pubs/sufficient-context-a-new-lens-on-retrieval-augmented-generation-systems/):
  distinguishes insufficient retrieved evidence from failure to use available
  evidence. Supports expanding when necessary rather than minimizing input at
  all costs; its QA findings do not directly validate a coding policy.
- [Evaluating AGENTS.md (2026, v2)](https://arxiv.org/abs/2602.11988v2): reports
  that context-file requirements can increase cost without generally improving
  task success. Supports removing unnecessary procedural obligations, not
  removing project-specific constraints or safety rules.
- [SWE-Explore (June 2026 preprint)](https://arxiv.org/abs/2606.07297): evaluates
  ranked code-region retrieval under a line budget. Supports measuring region
  coverage and relevance rather than file-count or read-volume alone. Its gold
  regions come from successful agent trajectories, not exhaustive human audits.
- [Token Reduction Is Not Cost Reduction (2026, v5 preprint)](https://arxiv.org/abs/2607.12161v5):
  reports that lower tool-output volume can be offset by cache costs and extra
  retrieval or turns. Savings must be evaluated end to end, not inferred from
  the amount of text omitted.

## Validation and follow-up

Prompt tests verify the generated textual contract, including sufficient-context
expansion, full-file requests, instruction preservation, documentation scope, and
custom-prompt behavior. They do not establish that a model follows the policy.
Existing read-tool tests cover range selection and truncation; neither behavior
changes here.

A future paired evaluation should hold model, reasoning level, repository commit,
context settings, and task constant. Include known-file edits, cross-file bugs,
broad audits, documentation questions, and small files where direct full reads
are appropriate. Repeat trials to account for model variation.

Measure correct outcomes and missed dependencies first, then total cached and
uncached input, output, model-priced cost, elapsed time, read/search calls,
repeated retrieval, and unnecessary user questions. Reject apparent token wins
that increase failures, retries, or user effort. No fixed savings target or
optimal line budget is established by this change.

Log filtering, job-result deduplication, plan acknowledgements, cache-transition
changes, new retrieval infrastructure, and conversation compaction thresholds
are separate work. They are not changed by this reading policy.
