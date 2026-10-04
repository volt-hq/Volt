---
"@hansjm10/volt-coding-agent": minor
"@hansjm10/volt-protocol": minor
---

breaking(extensions): Managed context preparation moved from `ctx.work` to `ctx.services`, and the daemon's session-to-pull-request association is now called the change association, both on the wire and on disk. ([#585](https://github.com/volt-hq/Volt/issues/585))

Extension authors rename `ctx.work` to `ctx.services` (`ctx.services.tasks.start`, `ctx.services.context.requestWait`) and `volt.getWorkStatus()` to `volt.getServicesStatus()`. The exported `ExtensionWork*` types are now `ExtensionServices*` (for example `ExtensionServicesContext`, `ExtensionServicesTaskContext`, `ExtensionServicesReadResult`, `ExtensionServicesLimits`), and the SDK option `extensionWorkLimits` is now `extensionServicesLimits`.

Protocol clients read the session list's and `session_contexts` query's `changeContext` instead of `workContext`; its shape is unchanged. In `@hansjm10/volt-protocol`, `RpcSessionWorkContextSchema` and `RpcSessionWorkPullRequestSchema` are now `RpcSessionChangeContextSchema` and `RpcSessionChangePullRequestSchema`, the `RPC_WORK_*` limits are `RPC_CHANGE_*` (`RPC_WORK_CHANGE_ID_MAX_CHARS` is `RPC_CHANGE_ID_MAX_CHARS`), and the daemon control request `work_observe` is `change_observe`. The daemon stores associations in `changes.json`; it ignores an existing `work-state.json`, so sessions rediscover their pull requests the next time they are observed on their branch.
