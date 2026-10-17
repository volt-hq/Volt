---
"@hansjm10/volt-coding-agent": patch
"@hansjm10/volt-protocol": patch
---

feature(tui): `/voice` lets you talk to the conversation from the terminal, with the microphone and speaker of an installed audio tool (PulseAudio or PipeWire, SoX, or ALSA).

Experimental and off until enabled under Voice in `/settings` (the `voice.enabled` setting, which `set_settings` now changes as `voiceEnabled`). Spoken turns are sent as your messages, and the footer shows whether voice is listening, muted, or speaking. `alt+m` mutes the microphone and `alt+s` stops what voice is saying without stopping the agent. Because these tools do not cancel echo, the microphone is silent while voice speaks unless `voice.duplex` is `"full"` (for headphones). `voice.audio` picks the tool.
