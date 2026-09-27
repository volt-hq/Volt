---
"@hansjm10/volt-coding-agent": patch
---

fix(standalone): Windows standalone executables no longer carry a broken signature entry inherited from Node.js, so Windows treats them as unsigned instead of as having an invalid signature. ([#510](https://github.com/volt-hq/Volt/issues/510))
