---
"@hansjm10/volt-coding-agent": patch
"@hansjm10/volt-protocol": patch
---

improvement(rpc): Pull request review now selects its code-host provider from the repository remote, and `resolve_pr_review` and `prepare_pr_review` report that provider's id in `pullRequest.provider`.

The value is `github` or `azure-devops`. Protocol clients should accept any provider id and treat `url` and `repository` as display values that provider owns; `@hansjm10/volt-protocol` types `provider` as a string.
