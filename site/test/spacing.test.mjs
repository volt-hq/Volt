import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function renderedText(path, pattern) {
  const html = readFileSync(new URL(`../dist/${path}`, import.meta.url), "utf8");
  const match = html.match(pattern);
  assert.ok(match, `Expected prose block in ${path}`);
  return match[1].replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

const footerParagraph = /<footer\b[^>]*>\s*<p\b[^>]*>([\s\S]*?)<\/p>/;

test("homepage install alternatives preserve spaces around commands and labels", () => {
  assert.equal(
    renderedText("index.html", /<p\b[^>]*class="[^"]*\binstall-alt\b[^"]*"[^>]*>([\s\S]*?)<\/p>/),
    "or npm install -g --ignore-scripts @hansjm10/volt-coding-agent · Windows: irm https://volt-cli.dev/install.ps1 | iex",
  );
});

test("homepage attribution preserves spaces around links", () => {
  assert.equal(
    renderedText("index.html", footerParagraph),
    "Maintained and distributed by Jordan Hans. Derived from Mario Zechner's Pi project under the MIT License. Built in the open at github.com/volt-hq/Volt.",
  );
});

for (const path of [
  "blog/index.html",
  "blog/why-i-forked-pi-to-build-volt/index.html",
  "privacy/index.html",
  "terms/index.html",
]) {
  test(`${path} attribution preserves spaces around links`, () => {
    assert.equal(
      renderedText(path, footerParagraph),
      "Maintained by Jordan Hans. Built in the open at volt-hq/Volt.",
    );
  });
}
