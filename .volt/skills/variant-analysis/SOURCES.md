# Source and adaptation

- Original work: **Variant Analysis**, by **Trail of Bits**.
- Source: [trailofbits/skills, variant-analysis](https://github.com/trailofbits/skills/tree/123037ec8aed26f0d86327cc39137ee5043e5deb/plugins/variant-analysis/skills/variant-analysis).
- Pinned commit: `123037ec8aed26f0d86327cc39137ee5043e5deb`.
- Material adapted: `SKILL.md` and the root-cause, searching, triage, and reporting references.
- License: **Creative Commons Attribution-ShareAlike 4.0 International** ([CC-BY-SA-4.0](https://creativecommons.org/licenses/by-sa/4.0/)); full upstream text and warranty disclaimer in [LICENSE](LICENSE).

The skill and reference documentation in this directory are modified adaptations distributed under **CC-BY-SA-4.0**, not the repository's default MIT license. Trail of Bits has not endorsed this adaptation.

## Changes for Volt

Rewrote the five-step workflow and references to respect the authorized search boundary, prefer supported LSP navigation, and distinguish confirmed reachable failures from latent concerns. Added Volt-specific search axes, historical-seed calibration, stopping criteria, and validation limits. Removed automatic parallel-agent orchestration, mandatory repository-wide expansion, issue-writer dependencies, and automatic CI-rule creation. Omitted scanner resources, report templates, plugin commands, evaluation fixtures, assets, and executable workflows; no links depend on omitted files.

This is a curated adaptation, not a complete upstream mirror. To update, review the pinned upstream diff, reconcile scope and tool assumptions with Volt, retain attribution/license notices, update the recorded commit, and validate discovery and local links.
