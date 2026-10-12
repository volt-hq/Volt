---
"@hansjm10/volt-tui": patch
---

fix(tui): Fixed text after a non-SGR terminal escape sequence, such as a cursor movement, being measured as part of the escape, which let lines overflow the terminal width. ([#751](https://github.com/volt-hq/Volt/issues/751))
