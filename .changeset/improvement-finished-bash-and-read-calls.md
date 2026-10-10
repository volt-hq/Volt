---
"@hansjm10/volt-coding-agent": patch
---

improvement(tui): Bash, read, and write calls with long output collapse to a line count, such as 600 lines or exit 1 · 600 lines, instead of a few lines of the output.

A write counts its content up while the model generates it and shows short content whole once written; its diagnostics and errors stay visible collapsed.
