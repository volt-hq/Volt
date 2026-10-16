---
"@hansjm10/volt-coding-agent": patch
"@hansjm10/volt-protocol": patch
---

feature(daemon): Conversation workers can host a voice session: with `voice.enabled` set, a client starts voice on its conversation (`voice_start`, `voice_stop`, `voice_interrupt`; the live `voice` value), attaches a media stream through the daemon, and completed spoken turns are sent as literal user messages while committed assistant text is spoken back through the `openai-codex` Live provider.

Off by default, and not yet a supported feature: no terminal or app captures a microphone yet, and paired devices cannot use it. The Live engine (`werift`, `opusscript`) ships as optional dependencies; without them voice reports `native_media_unavailable`. Extension `input` events from spoken turns carry `source: "voice"`.
