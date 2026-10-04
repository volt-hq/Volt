---
"@hansjm10/volt-coding-agent": minor
---

breaking(sdk): Extension dialogs, notifications, status, string widgets, title, and approvals now belong to the conversation and reach every attached client that shows them; the first answer to a dialog or approval wins. ([#585](https://github.com/volt-hq/Volt/issues/585))

A pending dialog or approval stays pending when a client disconnects or the conversation's branch changes, and is shown again to a client that attaches; it ends when answered, when its timeout passes, when the extensions reload, or when the conversation closes. RPC clients that share a conversation all receive its `extension_ui_request` and `host_action_request` frames, and a `select` response that is not one of the request's options resolves like a cancellation. When a client that may answer host action requests drops `host_action_requests.v1`, the pending ones no other attached client takes end as `dismissed`.

Migration: `HostClient.surface.ui` (`ExtensionClient.ui`, now typed `ExtensionTerminalUI`) receives only the terminal-only calls: `custom()`, component widgets, header, footer, editor components, terminal input, working indicators, themes, and editor paste. To show the rest, give the client a `live` view (`acceptsHostRequest(kind)` and `apply(update)`; the host attaches it to `conversation.liveState` on every join) and answer requests with `conversation.liveState.answer(requestId, response, client.id)`. A session's approvals wait in its live state (`liveState.hostInteraction`) unless it was created with its own `hostInteraction`.
