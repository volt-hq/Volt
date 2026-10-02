# Source and adaptation

- Original work: **TypeScript Pro**, by **Jeffallan**.
- Source: [Jeffallan/claude-skills, typescript-pro](https://github.com/Jeffallan/claude-skills/tree/882ef55e377dbf9a4dbe496bb41ac6ccd0e555cf/skills/typescript-pro).
- Pinned commit: `882ef55e377dbf9a4dbe496bb41ac6ccd0e555cf`.
- Material adapted: `SKILL.md`, `references/advanced-types.md`, `references/type-guards.md`, and `references/configuration.md`.
- License: **MIT**; full upstream copyright, permission notice, and warranty disclaimer in [LICENSE](LICENSE). The adapted documentation in this directory remains MIT-licensed.

## Changes for Volt

Rewrote the workflow and references around Volt's erasable TypeScript, top-level imports, existing npm/Biome tooling, runtime boundaries, correlated unions, inference, module resolution, and measured compiler cost. Removed blanket requirements to adopt brands, compiler flags, tRPC, type-coverage, or declaration/build changes. Replaced unsound or overly broad upstream examples with narrower examples and explicit limitations, including guard completeness and variance. No external tooling is installed.

This is a curated adaptation, not a complete upstream mirror. To update, review the pinned upstream diff against current Volt instructions and installed declarations, retain the license, update the recorded commit, and validate discovery, references, and examples. Do not blindly replace the local skill with upstream head.
