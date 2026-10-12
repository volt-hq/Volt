---
"@hansjm10/volt-coding-agent": patch
---

fix(review): Review run lists and results skip a stored run or acknowledgment whose timestamp is negative, fractional, or beyond the safe integer range instead of sending it to clients. ([#841](https://github.com/volt-hq/Volt/issues/841))
