---
"@hansjm10/volt-coding-agent": minor
---

breaking(themes): Custom themes must define the new `info` and `toolTarget` color tokens.

Add both [color tokens](https://volt-cli.dev/docs/themes/#color-tokens) to your theme's `colors` (for example `"info": "#61afef"` and `"toolTarget": "#61afef"`). `info` colors informational text and notifications, and `toolTarget` colors what a tool call acts on in its title, such as a file path or search pattern. A theme without them fails to load and Volt falls back to the built-in `dark` theme.
