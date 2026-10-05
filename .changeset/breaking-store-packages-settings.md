---
"@hansjm10/volt-coding-agent": minor
---

breaking(store): The azure-devops, build-ios-apps, review-loop, rtk, and terminal-bench-harbor store packages take their configuration from extension settings, which `/extensions` and `volt config` edit as a form. ([#585](https://github.com/volt-hq/Volt/issues/585))

Migration: after updating the packages, move `.volt/azure-devops.json` into the azure-devops project settings (`/ado-config save` writes the current values there), `VOLT_XCODEBUILDMCP_WORKFLOWS` into the build-ios-apps `workflows` setting, and `RTK_DISABLED=1` into the rtk `enabled` setting (off). Settings live in `settings.json` under `extensions.<id>.settings`. review-loop gains `maxLoops` and `baseBranch`, and terminal-bench-harbor `model`, `taskLimit`, and `concurrentTrials`. azure-devops no longer declares the `fs-write` permission.
