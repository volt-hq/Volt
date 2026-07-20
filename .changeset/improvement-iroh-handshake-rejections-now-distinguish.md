---
"@hansjm10/volt-coding-agent": patch
---

improvement(remote): Iroh handshake rejections now distinguish a permanently missing registered workspace path (workspace_missing) from a transiently unavailable one (workspace_unavailable with a retryAfterMs pacing hint) so paired clients can stop or pace automatic redials. ([#88](https://github.com/volt-hq/Volt/issues/88))
