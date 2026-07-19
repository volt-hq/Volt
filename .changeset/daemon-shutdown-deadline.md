---
"@hansjm10/volt-coding-agent": patch
---

fix(daemon): Made daemon restarts recover promptly from stalled network teardown without interrupting admitted work.

Daemon startup state work now joins the same durable quiesce barrier, accepted Iroh streams and redeemed relays drain application ownership independently from native read/write/reset/stop settlement, native startup and physical disposal share a bounded process-teardown deadline, established control requests are fenced and drained before durable state closes, pending pairing tickets quiesce before late control disconnects, accepted control sockets that never finish their handshake are retired during shutdown, and stop escalation fails closed when the operating system refuses a signal.
