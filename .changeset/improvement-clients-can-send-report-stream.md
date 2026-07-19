---
"@hansjm10/volt-coding-agent": patch
---

improvement(remote): Clients can send report_stream_discontinuity to request an assistant-stream recovery snapshot after client-side frame loss (for example a mid-turn attach), unfreezing the live transcript instead of waiting for the message boundary.
