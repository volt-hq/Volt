---
"@hansjm10/volt-coding-agent": minor
---

breaking(jobs): Background-job waits now suspend until selected jobs finish or steering arrives, without repeated polling turns.

Replace `jobs wait` arguments using `id` with `ids: [id]`. The default `mode` is `any`; use `all` to await every selected job. Waits no longer have a default deadline; supply `timeoutMs` (0–300000) when a bounded wait is required. Wait results use a `backgroundJobWait` envelope with terminal `results`, metadata-only `pending` jobs, and a `reason` rather than a single `backgroundJob` snapshot. `read` and `cancel` continue to use `id`.

Source launchers enable private, metadata-only background-job performance logs. Set `VOLT_BACKGROUND_JOB_DIAGNOSTICS=0` to disable them. Logs stay outside conversations and can be analyzed with the repository performance-report script.
