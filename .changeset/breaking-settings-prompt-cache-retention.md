---
"@hansjm10/volt-coding-agent": minor
---

breaking(settings): Prompt cache retention is now the `promptCache.retention` setting, and Volt no longer reads `VOLT_CACHE_RETENTION`. ([#744](https://github.com/volt-hq/Volt/issues/744))

The setting is `"short"` (the default) or `"long"`. It applies to conversations that start afterwards and to open ones after `/reload`. An invalid value is reported when settings load and `"short"` applies.

Migration: replace `VOLT_CACHE_RETENTION=long` with `"promptCache": { "retention": "long" }` in `settings.json`, globally or in a profile.
