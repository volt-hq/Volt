---
"@hansjm10/volt-coding-agent": minor
---

breaking(themes): Custom themes must define the new `planMode` color token.

Add a `planMode` color to your theme's `colors` (for example `"planMode": "#56b6c2"`); Volt uses it for the composer border in Plan mode, the transcript's mode divider, and the plan status marks. A theme without it fails to load and Volt falls back to the built-in `dark` theme.
