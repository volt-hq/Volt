---
"@hansjm10/volt-coding-agent": patch
"@hansjm10/volt-ai": patch
---

feature(tui): The footer now counts down to prompt-cache expiry and warns when the next message will resend the conversation uncached, and RPC clients receive the same status through get_state and prompt_cache_changed.
