---
"@hansjm10/volt-coding-agent": patch
---

feature(tui): `/voice` lets you talk to the conversation from the terminal, with the microphone and speaker of an installed audio tool (PulseAudio or PipeWire, SoX, or ALSA).

Experimental and off unless the `voice.enabled` setting is on. Spoken turns are sent as your messages, and the footer shows whether voice is listening, muted, or speaking. `alt+m` mutes the microphone and `alt+s` stops what voice is saying without stopping the agent. Because these tools do not cancel echo, the microphone is silent while voice speaks unless `voice.duplex` is `"full"` (for headphones). `voice.audio` picks the tool.
