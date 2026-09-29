# Source and adaptation

- Original work: **Vitest**, by **Anthony Fu**, generated from Vitest documentation.
- Source: [antfu/skills, vitest](https://github.com/antfu/skills/tree/d02c48452d782231e4c32d7069cde731a4c7db42/skills/vitest).
- Pinned commit: `d02c48452d782231e4c32d7069cde731a4c7db42` (upstream skill identifies itself as generated from Vitest 5.0.1 docs). Originally adapted from `5cae97ca87e0dcfb5a192cd2cbf8b83a9f769e8f` (Vitest 3.x).
- Material adapted: `SKILL.md`, mocking, test-context, concurrency, type-testing, and vi-utilities references.
- License: **MIT**; full upstream copyright, permission notice, and warranty disclaimer in [LICENSE](LICENSE). The adapted documentation in this directory remains MIT-licensed.

## Changes for Volt

Rebased on the Vitest 5.x skill when Volt upgraded from Vitest 3.2.6 to 5.0.2; the Vitest 4 and 5 migration guides were reviewed for mocking, hoisting, concurrency, and assertion changes. Rewrote examples and guidance for Volt's pinned Vitest 5.0.2, root-hoisted CLI path, faux-provider harness, and no-inline-import rule. Clarified mock reset/restore semantics, assertion-based waiting, fake-clock limits, fixture cleanup, and the separation between runtime tests and compiler checks. Removed unfiltered test commands, dependency installation instructions, dynamic imports, and broad configuration recipes. References are curated, not a complete API manual.

Installed declarations are authoritative: the upstream version label alone is not a compatibility guarantee. On update, review both upstream and Volt dependency changes, verify used APIs, retain the license, update the recorded commit, and validate discovery, local links, and examples. Updating the skill does not authorize a Vitest dependency upgrade.
