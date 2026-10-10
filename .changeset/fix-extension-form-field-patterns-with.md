---
"@hansjm10/volt-coding-agent": patch
---

fix(extensions): Extension form field patterns with two repeats that can trade characters, such as `a*a*` or `\w+.\w+`, are now refused when the form is asked, so an answer cannot make the host backtrack for polynomial time. ([#585](https://github.com/volt-hq/Volt/issues/585))
