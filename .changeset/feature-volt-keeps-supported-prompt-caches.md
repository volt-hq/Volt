---
"@hansjm10/volt-coding-agent": patch
"@hansjm10/volt-ai": patch
"@hansjm10/volt-agent-core": patch
---

feature(prompt-cache): Volt keeps supported prompt caches warm while work runs and for 15 minutes after it finishes, so long tool calls and short breaks no longer resend the whole conversation uncached.

Keepalive replays the previous request without output about a minute before the cache expires (Claude models on the Anthropic Messages API today, with adaptive thinking or thinking off; requests with a Claude 4.5 thinking budget are not refreshed or shown as warm). Extension commands count as work, including while they wait for your input. The footer shows `cache warm 12m` while the idle window runs, refresh costs count toward session totals, and `promptCache.keepAlive` / `promptCache.keepAliveIdleMinutes` or `/settings` control it. After each real request, refreshing stops once it would cost more than the cache miss it avoids (24 refreshes on Opus 5.5's 5-minute cache), and a late timer skips its refresh instead of risking a full-price cache write.
