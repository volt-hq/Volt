import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadExtensions } from "../../../../packages/coding-agent/src/core/extensions/loader.ts";

test("Volt loads the project extension and its isolated SDK without starting network work", async (t) => {
	t.mock.method(globalThis, "fetch", async () => {
		assert.fail("Loading must not start network work");
	});
	const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
	const cwd = fileURLToPath(new URL("../../../../", import.meta.url));
	const loaded = await loadExtensions([entry], cwd);
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);
	const extension = loaded.extensions[0];
	assert.equal(extension.commands.get("jev")?.remoteSafe, false);
	assert.equal(loaded.runtime.flagValues.get("jev"), "off");
	assert.equal(extension.tools.size, 0);
	assert.ok(extension.handlers.has("context"));
	assert.equal(extension.handlers.has("tool_call"), false);
});
