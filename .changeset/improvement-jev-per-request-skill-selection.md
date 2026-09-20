---
"@hansjm10/volt-coding-agent": patch
---

improvement(extensions): Enabled Jev now considers all available loaded skills for each new user request without requiring keyword matches, and can choose no skill.

Constraints such as “without changing the API” no longer prevent skill evaluation. Explicit skill invocations, read permissions, request-size limits, and the one-evaluation-per-request bound remain unchanged; deterministic fallback still avoids speculative reads for negated requests.
