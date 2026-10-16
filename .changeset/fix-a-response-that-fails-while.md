---
"@hansjm10/volt-agent-core": patch
"@hansjm10/volt-coding-agent": patch
---

fix: A response that fails while a steer or a background job's notice is queued now retries as any failed response does, with a rejected tool call explained to the model, instead of ending the turn and leaving the queued input undelivered.
