---
"@hansjm10/volt-coding-agent": minor
---

breaking(extensions): Volt no longer loads Pi extension packages: the `pi` package.json manifest key and the `@earendil-works/pi-*` and `@mariozechner/pi-*` import aliases are removed.

To migrate a Pi extension package, rename its `pi` manifest key to `volt` and import from `@hansjm10/volt-ai`, `@hansjm10/volt-agent-core`, `@hansjm10/volt-coding-agent`, and `@hansjm10/volt-tui` instead of the Pi package names. The extension API itself is unchanged.
