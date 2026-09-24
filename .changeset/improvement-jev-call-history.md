---
"@hansjm10/volt-coding-agent": patch
---

improvement(extensions): Recorded metadata-only Jev call history with attempted, finished, and successful counts and the latest HTTP outcome in `/jev status`.

History stays outside model context and follows the session branch across reload and resume. Custom transports are labeled separately, and prompts, credentials, source contents, and raw responses are never recorded. Calls made before logging was loaded cannot be reconstructed.
