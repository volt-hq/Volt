import assert from "node:assert/strict";
import test from "node:test";
import { routingSupervisorTimeout } from "./run-code-routing.mjs";

test("routing supervisor bounds the selected run deadline plus cleanup", () => {
	assert.equal(routingSupervisorTimeout([]), 32 * 60_000);
	assert.equal(routingSupervisorTimeout(["--live", "--minutes", "45"]), 47 * 60_000);
	assert.equal(routingSupervisorTimeout(["--minutes", "1"]), 3 * 60_000);
	assert.equal(routingSupervisorTimeout(["--minutes", "60"]), 62 * 60_000);
});

test("routing supervisor rejects invalid or unbounded deadlines before spawning", () => {
	for (const value of ["0", "-1", "61", "Infinity", "NaN", "1.5", "1e2", "", undefined]) {
		assert.throws(() => routingSupervisorTimeout(["--minutes", value]), /integer/);
	}
});
