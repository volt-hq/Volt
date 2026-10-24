---
"@hansjm10/volt-coding-agent": patch
---

fix(extensions): The project-local goal POC now refreshes paused and blocked guidance on background-job wakes while permitting authorized result collection and unrelated work.

Explicit blocker calls retain their latest reason, and failed goal settlements reference the session checkpoint without guessing a cause or copying error text.
