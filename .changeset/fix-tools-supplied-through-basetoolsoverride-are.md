---
"@hansjm10/volt-coding-agent": patch
---

fix(sdk): Tools supplied through baseToolsOverride are now reported as SDK tools instead of built-ins, so the goal auditor no longer swaps a restricted read or bash for the native one.
