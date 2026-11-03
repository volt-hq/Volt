---
"@hansjm10/volt-coding-agent": patch
---

feature(review): Added [pull request review](https://volt-cli.dev/docs/usage/#code-review) for Azure DevOps Services repositories, including publishing a review as one comment thread per inline finding and one for the summary. ([#985](https://github.com/volt-hq/Volt/issues/985))

Volt authenticates with a personal access token from `VOLT_ADO_PAT` or `AZURE_DEVOPS_EXT_PAT`, or with the Azure CLI account, which it also uses when Azure DevOps refuses the token. Publishing again after a failure posts only the missing threads. Pull requests from forks and daemon review worktrees are not supported yet.
