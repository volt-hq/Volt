---
"@hansjm10/volt-coding-agent": minor
---

breaking(extensions): Volt no longer loads Pi extension packages: the `pi` package.json manifest key and the `@earendil-works/pi-*` and `@mariozechner/pi-*` import aliases are removed.

To migrate a Pi extension package, replace its `pi` key in package.json with a `volt` manifest (see the extension manifest entry), import from `@hansjm10/volt-ai`, `@hansjm10/volt-agent-core`, and `@hansjm10/volt-coding-agent` instead of the Pi package names, and depend on `@hansjm10/volt-tui` yourself if the extension imports it. Then apply the other extension API changes in this release.
