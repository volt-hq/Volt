// Syncs packages/coding-agent/docs into the Starlight content collection.
//
// - Copies every top-level .md file to src/content/docs/docs/<name>.md,
//   adding Starlight frontmatter (title from docs.json, else the first H1).
// - Rewrites relative .md links to /docs/<slug>/ routes; links that escape
//   the docs directory point at the GitHub repo instead.
// - Copies the images/ directory to public/docs-images and rewrites image
//   references (markdown and raw <img> HTML) to that absolute path, since
//   relative paths break against trailing-slash routes.
// - Emits src/generated/sidebar.json and src/generated/redirects.json for
//   astro.config.mjs, derived from docs.json navigation and redirects.
//
// packages/coding-agent/docs/docs.json stays the single source of truth for
// navigation; this script has no nav configuration of its own.

import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const siteRoot = fileURLToPath(new URL("..", import.meta.url));
const docsSource = join(siteRoot, "..", "packages", "coding-agent", "docs");
const contentOut = join(siteRoot, "src", "content", "docs", "docs");
const generatedOut = join(siteRoot, "src", "generated");

const GITHUB_BLOB = "https://github.com/hansjm10/Volt/blob/main";

// The CLI publishes to npm as @hansjm10/volt-cli, but the repo still uses the
// upstream-derived name. Rewrite it in synced docs so the site shows the real
// install name; remove once the repo package is renamed.
const NPM_NAME_REWRITES = [["@earendil-works/volt-coding-agent", "@hansjm10/volt-cli"]];

const manifest = JSON.parse(readFileSync(join(docsSource, "docs.json"), "utf8"));

const titleByPath = new Map();
for (const section of manifest.navigation) {
  for (const item of section.items) {
    titleByPath.set(item.path, item.title);
  }
}

const mdFiles = readdirSync(docsSource).filter((f) => f.endsWith(".md"));
// index.md collapses to the folder route (/docs/), everything else is /docs/<name>.
const slugFor = (file) => (basename(file, ".md") === "index" ? "docs" : `docs/${basename(file, ".md")}`);
const knownSlugs = new Set(mdFiles.map((f) => basename(f, ".md")));

rmSync(contentOut, { recursive: true, force: true });
mkdirSync(contentOut, { recursive: true });
mkdirSync(generatedOut, { recursive: true });

const escapeYaml = (s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

function rewriteLink(target, sourceFile) {
  // Leave absolute URLs, anchors, and non-markdown assets alone.
  if (/^[a-z]+:/i.test(target) || target.startsWith("#")) return target;
  const [path, anchor = ""] = target.split("#");
  const suffix = anchor ? `#${anchor}` : "";
  if (!path.endsWith(".md")) return target;
  // Links that stay inside the docs directory become site routes.
  if (!path.includes("/") || path.startsWith("./")) {
    const name = basename(path, ".md");
    if (knownSlugs.has(name)) return name === "index" ? `/docs/${suffix}` : `/docs/${name}/${suffix}`;
  }
  // Everything else (../../README.md, tla/…, cross-package paths) goes to GitHub.
  const resolved = new URL(path, `${GITHUB_BLOB}/packages/coding-agent/docs/${sourceFile}`).href;
  return `${resolved}${suffix}`;
}

const sidebarEntries = new Map();

for (const file of mdFiles) {
  const raw = readFileSync(join(docsSource, file), "utf8");
  let body = raw;
  let title = titleByPath.get(file);

  const h1 = body.match(/^#\s+(.+?)\s*$/m);
  if (h1) {
    title ??= h1[1];
    // Starlight renders the frontmatter title as the page H1; drop the
    // markdown one so it does not appear twice.
    body = body.replace(h1[0], "").replace(/^\s+/, "");
  }
  title ??= basename(file, ".md");

  body = body.replace(/\]\(([^)\s]+)\)/g, (m, target) => `](${rewriteLink(target, file)})`);
  body = body.replace(/(\]\(|src=")(?:\.\/)?images\//g, "$1/docs-images/");
  for (const [from, to] of NPM_NAME_REWRITES) body = body.replaceAll(from, to);

  const frontmatter = `---\ntitle: ${escapeYaml(title)}\n---\n\n`;
  writeFileSync(join(contentOut, file), frontmatter + body);
  sidebarEntries.set(file, { label: title, slug: slugFor(file) });
}

cpSync(join(docsSource, "images"), join(siteRoot, "public", "docs-images"), { recursive: true });

const sidebar = manifest.navigation.map((section) => ({
  label: section.title,
  items: section.items.map((item) => sidebarEntries.get(item.path) ?? { label: item.title, slug: slugFor(item.path) }),
}));

const redirects = {};
for (const r of manifest.redirects ?? []) {
  redirects[`/docs/${basename(r.from, ".md")}`] = `/docs/${basename(r.to, ".md")}/`;
}

writeFileSync(join(generatedOut, "sidebar.json"), JSON.stringify(sidebar, null, 2));
writeFileSync(join(generatedOut, "redirects.json"), JSON.stringify(redirects, null, 2));

console.log(`Synced ${mdFiles.length} docs pages, ${sidebar.length} sidebar sections.`);
