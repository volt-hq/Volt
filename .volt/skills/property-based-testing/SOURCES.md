# Source and adaptation

- Original work: **Property-Based Testing**, by **Trail of Bits**.
- Source: [trailofbits/skills, property-based-testing](https://github.com/trailofbits/skills/tree/123037ec8aed26f0d86327cc39137ee5043e5deb/plugins/property-based-testing/skills/property-based-testing).
- Pinned commit: `123037ec8aed26f0d86327cc39137ee5043e5deb`.
- Material adapted: `SKILL.md` and the generating, reviewing, interpreting-failures, libraries, and refactoring references.
- License: **Creative Commons Attribution-ShareAlike 4.0 International** ([CC-BY-SA-4.0](https://creativecommons.org/licenses/by-sa/4.0/)); full upstream text and warranty disclaimer in [LICENSE](LICENSE).

The skill and reference documentation in this directory are modified adaptations distributed under **CC-BY-SA-4.0**, not the repository's default MIT license. Trail of Bits has not endorsed this adaptation.

## Changes for Volt

Rewrote the workflow and examples around TypeScript, fast-check 4.9, Volt's faux-provider harness, bounded validation, and explicit scope. Replaced Python/Solidity examples and broad refactoring suggestions with domain construction, Unicode boundaries, per-example cleanup, replay, and lifecycle guidance. Qualified the relative strength of round-trip and idempotence properties. Omitted plugin metadata, agents, assets, evaluation fixtures, and scripts.

This is a curated adaptation, not a complete upstream mirror. To update, review the pinned upstream diff, reconcile it with current Volt instructions and installed APIs, retain attribution/license notices, update the recorded commit, and validate discovery and local reference links. Do not run upstream installers or auto-enable workflows.
