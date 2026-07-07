# Volt site (volt-cli.dev)

Marketing landing page, documentation, and install scripts for Volt, built with Astro + Starlight.

- `src/pages/index.astro` — marketing landing page.
- `packages/coding-agent/docs/` — the documentation source of truth. `scripts/sync-docs.mjs` copies it into the Starlight content collection at build time, deriving the sidebar and redirects from `docs.json`. Do not edit `src/content/docs/docs/` or `src/generated/`; both are generated and gitignored.
- The sync step also rewrites the npm package name `@earendil-works/volt-coding-agent` (upstream-derived, still used in the repo) to the publish name `@hansjm10/volt-cli`. Drop that rewrite from `sync-docs.mjs` once the repo package is renamed.
- `public/install.sh`, `public/install.ps1` — served at `https://volt-cli.dev/install.sh` and `/install.ps1`. The shell installer defaults to `npm install -g --ignore-scripts`; `VOLT_INSTALL_METHOD=binary` fetches a standalone binary from GitHub Releases instead (binary builds do not support `volt daemon`).
- `public/_headers`, `public/_redirects` — Cloudflare Pages config (`/install` → `/install.sh`, `/github` → repo).

## Development

```bash
npm install --ignore-scripts
npm run dev        # syncs docs, then serves at localhost:4321
npm run build      # syncs docs, then builds to dist/
```

Docs edits go in `packages/coding-agent/docs/`; re-run `npm run sync-docs` (or restart dev) to pick them up. New pages must be added to `docs.json` to appear in the sidebar.

## Deploying to Cloudflare Pages

One-time setup in the Cloudflare dashboard (Workers & Pages → Create → Pages → Connect to Git):

1. Select the `hansjm10/Volt` repository.
2. Build configuration:
   - Build command: `cd site && npm install --ignore-scripts && npm run build`
   - Build output directory: `site/dist`
3. Set the production branch to `main`. Optionally restrict builds to the `site/` and `packages/coding-agent/docs/` paths (Settings → Builds → Build watch paths) so unrelated commits don't redeploy.
4. Custom domain: add `volt-cli.dev` under the project's Custom domains tab and follow the DNS instructions (the domain must be on Cloudflare DNS or delegated there).

Every push to `main` that touches the site or docs then deploys automatically; PRs get preview URLs.

## Beta launch checklist

The install paths reference artifacts that must exist before the site goes live:

- [ ] Publish the CLI to npm as `@hansjm10/volt-cli` (`install.sh` default path and the documented npm install). The repo package is still named `@earendil-works/volt-coding-agent`; rename it (package.json, publish scripts, shrinkwrap regen) or publish under the new name deliberately.
- [ ] Push a `v*` tag so `build-binaries.yml` creates a GitHub Release with platform tarballs (`VOLT_INSTALL_METHOD=binary` path).
- [ ] After both exist, smoke-test: `curl -fsSL https://volt-cli.dev/install.sh | sh` on macOS/Linux and `irm https://volt-cli.dev/install.ps1 | iex` on Windows.
