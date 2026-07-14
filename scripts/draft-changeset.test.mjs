import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDraftPrompt, extractDraftReply, packagesForChangedPaths } from "./draft-changeset.mjs";

test("draft prompt demands strict JSON with the changeset taxonomy", () => {
	const prompt = buildDraftPrompt();
	assert.match(prompt, /ONLY one JSON object/);
	for (const kind of ["feature", "improvement", "fix", "breaking", "internal"]) {
		assert.ok(prompt.includes(kind), `prompt must define kind ${kind}`);
	}
	assert.match(prompt, /Never mention file names/);
});

test("extractDraftReply parses plain, fenced, and prose-wrapped JSON replies", () => {
	const expected = { area: "daemon", details: "", kind: "fix", sentence: "Fixed lease cleanup." };
	assert.deepEqual(
		extractDraftReply('{"kind":"fix","area":"daemon","sentence":"Fixed lease cleanup.","details":""}'),
		expected,
	);
	assert.deepEqual(
		extractDraftReply('```json\n{"kind":"fix","area":"daemon","sentence":"Fixed lease cleanup.","details":""}\n```'),
		expected,
	);
	assert.deepEqual(
		extractDraftReply('Here is the fragment:\n{"kind":"fix","area":"daemon","sentence":"Fixed lease cleanup."}\nDone.'),
		expected,
	);
});

test("extractDraftReply rejects missing JSON, invalid kinds, and empty sentences", () => {
	assert.throws(() => extractDraftReply("I could not classify this change."), /no JSON object/);
	assert.throws(() => extractDraftReply('{"kind":"bugfix","sentence":"X."}'), /invalid kind/);
	assert.throws(() => extractDraftReply('{"kind":"fix","sentence":""}'), /empty sentence/);
	assert.throws(() => extractDraftReply('{"kind":"fix","sentence":"X." broken'), /not valid JSON|no JSON object/);
});

test("packagesForChangedPaths maps changed files to workspace packages with a default", () => {
	assert.deepEqual(packagesForChangedPaths(["packages/tui/src/tui.ts", "packages/tui/test/tui.test.ts"]), [
		"@hansjm10/volt-tui",
	]);
	assert.deepEqual(packagesForChangedPaths(["packages/ai/src/x.ts", "packages/coding-agent/src/y.ts"]), [
		"@hansjm10/volt-ai",
		"@hansjm10/volt-coding-agent",
	]);
	assert.deepEqual(packagesForChangedPaths(["scripts/release.mjs"]), ["@hansjm10/volt-coding-agent"]);
});
