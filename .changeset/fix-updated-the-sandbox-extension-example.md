---
"@hansjm10/volt-coding-agent": patch
---

fix(examples): Updated the sandbox extension example's shell-quote dependency to 1.12.0 for GHSA-pqg4-j6r4-53mv, which also fixes sandboxed commands containing both `'` and `!` (for example `echo 'hi!'` printed `hi\!`). ([#844](https://github.com/volt-hq/Volt/issues/844))
