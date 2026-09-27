// Inline copy of the Volt app icon (volt-app scripts/render-app-icon.swift, "halo" style) so the
// page stays self-contained: no external assets, and no xmlns URL since inline HTML SVG needs none.
const LOGO_SVG = `<svg viewBox="0 0 1024 1024" aria-hidden="true"><defs><linearGradient id="volt-logo-base" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a2537"/><stop offset=".55" stop-color="#191621"/><stop offset="1" stop-color="#0e0c12"/></linearGradient><radialGradient id="volt-logo-glow" cx="512" cy="512" r="740" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#a685ff" stop-opacity=".12"/><stop offset=".62" stop-color="#a685ff" stop-opacity=".04"/><stop offset="1" stop-color="#a685ff" stop-opacity="0"/></radialGradient></defs><rect width="1024" height="1024" rx="224" fill="url(#volt-logo-base)"/><rect width="1024" height="1024" rx="224" fill="url(#volt-logo-glow)"/><g transform="translate(512 512) scale(6.0413) translate(-50.2 -67.1)"><polygon fill="#6d4dc4" points="48.4,62.2 42.4,4.2 86.4,70.2 54.4,70.2"/><polygon fill="#a685ff" points="52,72 58,130 14,64 46,64"/></g></svg>`;

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function renderPage(options: { title: string; heading: string; message: string; details?: string }): string {
	const title = escapeHtml(options.title);
	const heading = escapeHtml(options.heading);
	const message = escapeHtml(options.message);
	const details = options.details ? escapeHtml(options.details) : undefined;

	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Volt · ${title}</title>
  <style>
    :root {
      --text: #fafafa;
      --text-dim: #a1a1aa;
      --page-bg: #09090b;
      --font-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    }
    * { box-sizing: border-box; }
    html { color-scheme: dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: var(--page-bg);
      color: var(--text);
      font-family: var(--font-sans);
      text-align: center;
    }
    main {
      width: 100%;
      max-width: 560px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }
    .logo {
      width: 72px;
      height: 72px;
      display: block;
      margin-bottom: 12px;
    }
    .logo svg {
      display: block;
      width: 100%;
      height: 100%;
    }
    .brand {
      margin-bottom: 24px;
      font-size: 14px;
      font-weight: 600;
      letter-spacing: 0.04em;
      color: var(--text-dim);
    }
    h1 {
      margin: 0 0 10px;
      font-size: 28px;
      line-height: 1.15;
      font-weight: 650;
      color: var(--text);
    }
    p {
      margin: 0;
      line-height: 1.7;
      color: var(--text-dim);
      font-size: 15px;
    }
    .details {
      margin-top: 16px;
      font-family: var(--font-mono);
      font-size: 13px;
      color: var(--text-dim);
      white-space: pre-wrap;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <main>
    <div class="logo">${LOGO_SVG}</div>
    <div class="brand">Volt</div>
    <h1>${heading}</h1>
    <p>${message}</p>
    ${details ? `<div class="details">${details}</div>` : ""}
  </main>
</body>
</html>`;
}

export function oauthSuccessHtml(message: string): string {
	return renderPage({
		title: "Authentication successful",
		heading: "Authentication successful",
		message,
	});
}

export function oauthErrorHtml(message: string, details?: string): string {
	return renderPage({
		title: "Authentication failed",
		heading: "Authentication failed",
		message,
		details,
	});
}
