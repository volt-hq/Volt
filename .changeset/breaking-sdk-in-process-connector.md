---
"@hansjm10/volt-coding-agent": minor
---

breaking(sdk): `InteractiveMode` connects through a `ConversationConnector`; `InProcessConnector` replaces `TuiHost`. ([#585](https://github.com/volt-hq/Volt/issues/585))

The TUI's client follows its session changes by reconnecting: `/new`, `/resume`, `/fork`, `/clone`, `/import`, opening review results, and a plan executed in a new session open the new session in the host, end the client's connection, and the client connects to the new session, which shows from a snapshot. The session it left closes once the new one started, as before.

Migration: replace `new InteractiveMode(TuiHost.start({ host, conversation, modelScopePatterns }), options)` with `new InteractiveMode(InProcessConnector.start({ host, conversation, modelScopePatterns }), options)`. `TuiHost`, `TuiHostOptions`, `TuiConnection`, and `TuiConnectOptions` are removed; `ConversationConnector`, `ConnectorTarget`, `ConnectorOpenOptions`, `OpenedConversation`, `connectThrough()`, `InProcessConnector`, and `InProcessConnectorOptions` are exported. To drive a client yourself, `connectThrough(connector, options)` returns a `ProtocolClient` (option `followMoves: "reconnect"`) that follows the connector's moves. `TuiHost`'s `daemon` option and `relayCount()` have no counterpart: an in-process connector runs without the Volt daemon.
