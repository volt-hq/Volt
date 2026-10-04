---
"@hansjm10/volt-protocol": patch
"@hansjm10/volt-coding-agent": patch
---

internal(daemon): The daemon control protocol and the Iroh handshake are now defined by schemas in the protocol contract, and validators compiled from those schemas replace the hand-written message checks.

The contract artifact adds `Control.*` (every control request, response, and event, plus hellos, acks, fatals, and the relay preamble), `RemoteHandshake.*`, and the remote access, push notification, and workspace catalog definitions. Messages on the wire are unchanged.
