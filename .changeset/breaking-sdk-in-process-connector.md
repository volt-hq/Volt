---
"@hansjm10/volt-coding-agent": minor
---

breaking(sdk): `InteractiveMode` connects through a `ConversationConnector`; SDK apps start it with `InProcessConnector`. ([#585](https://github.com/volt-hq/Volt/issues/585))

The TUI's client follows its session changes by reconnecting: `/new`, `/resume`, `/fork`, `/clone`, `/import`, opening review results, and a plan executed in a new session open the new session in the host, end the client's connection, and the client connects to the new session, which shows from a snapshot. The session it left closes once the new one started, as before.

Migration: replace `new InteractiveMode(runtime, options)` with `new InteractiveMode(InProcessConnector.start({ host, conversation, modelScopePatterns }), options)`, where `host` is a `ConversationHost` and `conversation` the conversation it opened; `options.modelScopePatterns` moved to `InProcessConnector.start`. `ConversationConnector`, `ConnectorTarget`, `ConnectorOpenOptions`, `OpenedConversation`, `connectThrough()`, `InProcessConnector`, and `InProcessConnectorOptions` are exported. To drive a client yourself, `connectThrough(connector, options)` returns a `ProtocolClient` (option `followMoves: "reconnect"`) that follows the connector's moves. An in-process connector runs without the Volt daemon: it serves no phones, and `/remote` and `/worktree` report the daemon unavailable.
