---
"@hansjm10/volt-ai": patch
"@hansjm10/volt-coding-agent": patch
---

fix(streaming): Retry transient provider failures during tool-call responses without restarting the task or executing incomplete calls.

Preserve the original provider error in retry and failure messages. Malformed completed arguments, cancellation, and local resource safeguards remain non-retryable.
