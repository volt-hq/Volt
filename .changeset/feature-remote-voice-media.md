---
"@hansjm10/volt-coding-agent": patch
"@hansjm10/volt-protocol": patch
---

feature(remote): Paired devices granted `voice.stream.v1` can start voice on their conversation and carry its audio on a `voiceMedia` Iroh stream beside it, and voice heard on a device follows that device's transcript redaction.

Off by default and not yet a supported feature. Only the `full` access preset includes `voice.stream.v1`; an existing pairing gains it through `volt remote access <node-id> set full`. The media stream attaches only on the connection of the conversation stream that started voice, with a single-use offer, ends with that stream, the connection, or the device's access, and is refused with the new `voice_media_unavailable` handshake outcome otherwise. A host holds at most four voice media attachments at once across TUIs and devices.
