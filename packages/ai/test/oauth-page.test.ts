import { describe, expect, it } from "vitest";
import { oauthErrorHtml, oauthSuccessHtml } from "../src/utils/oauth/oauth-page.ts";

const pages = [
	{ name: "success", render: (message: string) => oauthSuccessHtml(message) },
	{ name: "error", render: (message: string) => oauthErrorHtml(message, "Error: access_denied") },
];

describe("OAuth callback pages", () => {
	it.each(pages)("renders the Volt icon and name on the $name page", ({ render }) => {
		const html = render("Done.");

		expect(html).toMatch(/<div class="logo"><svg [^>]*aria-hidden="true"/);
		expect(html).toContain('fill="#6d4dc4"');
		expect(html).toContain('fill="#a685ff"');
		expect(html).toMatch(/<title>Volt · Authentication (successful|failed)<\/title>/);
		expect(html).toContain('<div class="brand">Volt</div>');
	});

	it.each(pages)("keeps the $name page self-contained", ({ render }) => {
		const html = render("Done.");

		for (const externalReference of ["<img", "<link", "<script", "@import", "src=", "http://", "https://"]) {
			expect(html).not.toContain(externalReference);
		}
	});

	it.each(pages)("escapes the message on the $name page", ({ render }) => {
		const html = render(`<script>alert("x")</script> & 'q'`);

		expect(html).toContain("<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;</p>");
		expect(html).not.toContain("<script");
	});

	it("escapes details on the error page", () => {
		const html = oauthErrorHtml("Login failed.", `Error: <b>"denied"</b> & 'retry'`);

		expect(html).toContain(
			'<div class="details">Error: &lt;b&gt;&quot;denied&quot;&lt;/b&gt; &amp; &#39;retry&#39;</div>',
		);
		expect(html).toContain("<h1>Authentication failed</h1>");
	});

	it("omits the details block on the success page", () => {
		const html = oauthSuccessHtml("You can close this window.");

		expect(html).toContain("<h1>Authentication successful</h1>");
		expect(html).toContain("<p>You can close this window.</p>");
		expect(html).not.toContain('class="details"');
	});
});
