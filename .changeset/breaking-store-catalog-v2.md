---
"@hansjm10/volt-coding-agent": minor
---

breaking(store): The store reads catalog schema version 2, in which every package pins a reviewed commit and lists its manifest id, version, permissions, and review record; the `verified` flag is gone. ([#585](https://github.com/volt-hq/Volt/issues/585))

`volt store` and `/store` show each catalog package's permissions and review (commit, reviewer, date, and notes), and install and update a catalog package only at its reviewed commit: `--ref` and `--track` no longer apply to catalog ids, and `volt store update <id>` moves an install that tracks a branch to the catalog's pin. `volt store show` and install plans show the package's manifest (id, display name, entry, permissions, and settings) instead of the raw `volt` field.

Migration: a custom catalog (`VOLT_STORE_CATALOG_URL`) moves to `"schemaVersion": 2`. Drop `verified`; add `version`, `permissions`, and `review` (`{ "commit", "reviewer", "date": "YYYY-MM-DD", "notes" }`) to each entry, with `id`, `name`, `version`, and `permissions` equal to the package's manifest `id`, `displayName`, `version`, and `permissions`; `repo`, `author`, `license`, `categories`, and `resources` are now required. Each `source` must be `git:https://github.com/<owner>/<repo>@<40-character commit>` and `review.commit` must be that commit; npm and local catalog sources are refused. Packages drop `image` and `video` from the `volt` field of package.json, which now holds only the manifest and `skills`, `prompts`, and `themes`; previews belong in the catalog entry.
