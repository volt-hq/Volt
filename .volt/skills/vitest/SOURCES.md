# Source and adaptation

- Original work: **Vitest**, by **Anthony Fu**, generated from Vitest documentation.
- Source: [antfu/skills, vitest](https://github.com/antfu/skills/tree/5cae97ca87e0dcfb5a192cd2cbf8b83a9f769e8f/skills/vitest).
- Pinned commit: `5cae97ca87e0dcfb5a192cd2cbf8b83a9f769e8f` (upstream skill identifies itself as Vitest 3.x).
- Material adapted: `SKILL.md`, mocking, test-context, concurrency, type-testing, and vi-utilities references.
- License: **MIT**; full upstream copyright, permission notice, and warranty disclaimer in [LICENSE](LICENSE). The adapted documentation in this directory remains MIT-licensed.

## Changes for Volt

Selected the older Vitest 3.x baseline instead of the current 5.x-beta skill. Rewrote examples and guidance for Volt's pinned Vitest 3.2.6, package-local CLI paths, faux-provider harness, and no-inline-import rule. Clarified mock reset/restore semantics, assertion-based waiting, fake-clock limits, fixture cleanup, and the separation between runtime tests and compiler checks. Removed unfiltered test commands, dependency installation instructions, dynamic imports, and broad configuration recipes. References are curated, not a complete API manual.

Installed declarations are authoritative: the upstream version label alone is not a compatibility guarantee. On update, review both upstream and Volt dependency changes, verify used APIs, retain the license, update the recorded commit, and validate discovery, local links, and examples. Updating the skill does not authorize a Vitest dependency upgrade.
