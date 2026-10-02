# Source and adaptation

- Original work: **Systematic Debugging**, from **Superpowers**, by **Jesse Vincent**.
- Source: [obra/superpowers, systematic-debugging](https://github.com/obra/superpowers/tree/5bf4e78011075bcfc0dc295f0724994cd123ee71/skills/systematic-debugging).
- Pinned commit: `5bf4e78011075bcfc0dc295f0724994cd123ee71`.
- Material adapted: `SKILL.md`, `root-cause-tracing.md`, `condition-based-waiting.md`, and `defense-in-depth.md`.
- License: **MIT**; full upstream copyright, permission notice, and warranty disclaimer in [LICENSE](LICENSE). The adapted documentation in this directory remains MIT-licensed.

## Changes for Volt

Rewrote the process around phase-aware investigation, minimal experiments, safe event tracing, async ownership, and Volt's test and job tools. Removed mandatory cross-skill Superpowers invocations and automatic architectural escalation. Replaced environment/payload dumps with secret-safe instrumentation, general polling recipes with completion signals and correct Vitest assertion waiting, and blanket multi-layer hardening with invariant-specific fixes. Omitted pressure-test prompts, creation logs, polluter scripts, and executable examples.

This is a curated adaptation, not a complete upstream mirror. To update, review the pinned upstream diff, preserve Volt's scope and secret-handling rules, retain the license, update the recorded commit, and validate discovery, references, and examples. Do not install the wider Superpowers orchestration framework as part of an update.
