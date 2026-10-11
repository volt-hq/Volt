---
"@hansjm10/volt-coding-agent": minor
"@hansjm10/volt-ai": minor
"@hansjm10/volt-protocol": minor
---

breaking(sdk): Session event listeners now share one deeply frozen event typed `DeepReadonly<AgentSessionEvent>`, so streaming costs less CPU when several observers watch a conversation. ([#772](https://github.com/volt-hq/Volt/issues/772))

Migration: a listener that changed the event it received must build its own values from it instead; writing to an event now throws, and `AgentSessionEventListener`, `SubagentEvent`, and review `onSessionEvent` callbacks receive `DeepReadonly<AgentSessionEvent>` from `@hansjm10/volt-ai`. Replace `session.subscribeRuntimeEvents(listener)` with `session.paceRuntimeEvents(pace)`: the pace is awaited after each loop event and receives no event. Live items for the streaming assistant message are read-only types.
