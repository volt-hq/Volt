# Volt site (volt-cli.dev)

Marketing landing page, documentation, and install scripts for Volt, built with Astro + Starlight.

The public project and release repository is
[`hansjm10/Volt`](https://github.com/hansjm10/Volt). Volt is maintained and
distributed by Jordan Hans and derived from Mario Zechner's Pi project under
the MIT License.

- `src/pages/index.astro` — marketing landing page.
- `packages/coding-agent/docs/` — the documentation source of truth. `scripts/sync-docs.mjs` copies it into the Starlight content collection at build time, deriving the sidebar and redirects from `docs.json`. Do not edit `src/content/docs/docs/` or `src/generated/`; both are generated and gitignored.
- The sync step preserves the canonical package identities used by the source documentation, including `@hansjm10/volt-coding-agent`.
- `public/install.sh`, `public/install.ps1` — served at `https://volt-cli.dev/install.sh` and `/install.ps1`. The shell installer defaults to `npm install -g --ignore-scripts`; `VOLT_INSTALL_METHOD=binary` fetches a standalone binary from GitHub Releases instead (binary builds do not support `volt daemon`).
- `public/_headers`, `public/_redirects` — Cloudflare Pages config (`/install` → `/install.sh`, `/github` → repo).

## Development

```bash
npm install --ignore-scripts
npm run dev        # syncs docs, then serves at localhost:4321
npm run build      # syncs docs, then builds to dist/
```

Docs edits go in `packages/coding-agent/docs/`; re-run `npm run sync-docs` (or restart dev) to pick them up. New pages must be added to `docs.json` to appear in the sidebar.

## Deploying to Cloudflare (Workers Builds)

The site deploys as an assets-only Worker (`wrangler.jsonc`, no server code). One-time setup in the Cloudflare dashboard (Workers & Pages → Create → import the `hansjm10/Volt` repository):

1. Project name: `volt-site`.
2. Build configuration:
   - Root directory: `site`
   - Build command: `npm ci --ignore-scripts && npm run build`
   - Deploy command: `npx wrangler deploy`
3. Set the production branch to `main`. Optionally restrict builds to the `site/` and `packages/coding-agent/docs/` paths (Settings → Builds → Build watch paths) so unrelated commits don't redeploy.
4. Custom domain: after the first deploy, add `volt-cli.dev` under the Worker's Settings → Domains & Routes (the domain must be on Cloudflare DNS or delegated there).

Every push to `main` that touches the site or docs then deploys automatically; PRs get preview URLs. Manual deploys also work locally with `npm run deploy` (needs `wrangler login`).

## Beta launch checklist

The install paths reference artifacts that must exist before the site goes live:

- [ ] Bootstrap and publish `@hansjm10/volt-coding-agent@0.1.0` with the npm
  `beta` dist-tag (`install.sh` default path and the documented npm install).
- [ ] Push a `v*` tag so `build-binaries.yml` creates a GitHub Release with platform tarballs (`VOLT_INSTALL_METHOD=binary` path).
- [ ] After both exist, smoke-test: `curl -fsSL https://volt-cli.dev/install.sh | sh` on macOS/Linux and `irm https://volt-cli.dev/install.ps1 | iex` on Windows.
