# Source and adaptation

- Original work: **Sharp Edges**, by **Trail of Bits**.
- Source: [trailofbits/skills, sharp-edges](https://github.com/trailofbits/skills/tree/123037ec8aed26f0d86327cc39137ee5043e5deb/plugins/sharp-edges/skills/sharp-edges).
- Pinned commit: `123037ec8aed26f0d86327cc39137ee5043e5deb`.
- Material adapted: `SKILL.md`, `references/auth-patterns.md`, `references/config-patterns.md`, and `references/lang-javascript.md`.
- License: **Creative Commons Attribution-ShareAlike 4.0 International** ([CC-BY-SA-4.0](https://creativecommons.org/licenses/by-sa/4.0/)); full upstream text and warranty disclaimer in [LICENSE](LICENSE).

The skill and reference documentation in this directory are modified adaptations distributed under **CC-BY-SA-4.0**, not the repository's default MIT license. Trail of Bits has not endorsed this adaptation.

## Changes for Volt

Rewrote the review around Volt's actual trust and capability boundaries, host-owned authority, configuration semantics, async lifetime, and evidence-based findings. Removed the Claude-specific tool allowlist and analyzer-agent dependency. Replaced categorical hardening/removal demands with scoped review and approval requirements. Corrected or qualified prototype-pollution effects, negative-timeout reasoning, numeric parsing, and the distinction between intentional authority and a bypass. Omitted other-language references, plugin metadata, assets, and workflows.

This is a curated adaptation, not a complete upstream mirror. To update, review upstream changes against the current threat model, preserve attribution/license notices, update the recorded commit, and validate discovery and local links. Do not import executable workflows or infer permissions from skill metadata.
