---
"@hansjm10/volt-coding-agent": patch
---

fix(remote): Streamed message deltas can no longer bypass host path redaction on iroh remote connections.

Delta-only `message_update` frames are now derived from sanitized accumulated text, and the host replaces the client accumulator with a fully sanitized snapshot whenever redaction rewrites text that already streamed (including tool-call arguments), so remote clients never reconstruct unredacted host paths from deltas split across frames.
