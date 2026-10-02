import assert from "node:assert";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { NotificationStack } from "../src/components/notification-stack.ts";
import { PLAIN_SEMANTIC_THEME } from "../src/styled-text.ts";
import { visibleWidth } from "../src/utils.ts";
import { showTags, tagTheme } from "./semantic-test-theme.ts";

describe("NotificationStack", () => {
	it("shows the newest notifications last with level icons and wrapped messages", () => {
		const stack = new NotificationStack(PLAIN_SEMANTIC_THEME, { maxVisible: 2 });
		stack.push({ id: "a", message: "Saved", level: "success" });
		stack.push({ id: "b", message: "Disk almost full on the build host", level: "warning", title: "Storage" });
		stack.push({ id: "c", message: "Sync failed", level: "error" });

		assert.deepStrictEqual(stack.render(24).lines, [
			"+1 more",
			"! Storage",
			"  Disk almost full on",
			"  the build host",
			"✗ Sync failed",
		]);
		for (const width of [24, 6]) {
			for (const line of stack.render(width).lines) assert.ok(visibleWidth(line) <= width, line);
		}
	});

	it("replaces notifications by id and dismisses them", () => {
		const stack = new NotificationStack(tagTheme);
		const dismissed: string[] = [];
		stack.onDismiss = (id) => dismissed.push(id);
		stack.push({ id: "x", message: "first" });
		stack.push({ id: "y", message: "other" });
		stack.push({ id: "x", message: "second", level: "info" });

		assert.deepStrictEqual(stack.getIds(), ["x", "y"]);
		assert.strictEqual(showTags(stack.render(30).lines[0]!), "<b><info>i</info></b> second");
		assert.strictEqual(stack.dismiss("x"), true);
		assert.strictEqual(stack.dismiss("x"), false);
		assert.deepStrictEqual(stack.getIds(), ["y"]);
		assert.deepStrictEqual(dismissed, ["x"]);
	});

	it("dismisses timed notifications and requests a render", async () => {
		let renders = 0;
		const stack = new NotificationStack(PLAIN_SEMANTIC_THEME, {}, { requestRender: () => renders++ });
		stack.push({ id: "t", message: "brief", durationMs: 5 });
		stack.push({ id: "p", message: "pinned" });
		await delay(30);
		assert.deepStrictEqual(stack.getIds(), ["p"]);
		assert.strictEqual(renders, 1);

		stack.push({ id: "u", message: "cancelled timer", durationMs: 5 });
		stack.dispose();
		await delay(30);
		assert.deepStrictEqual(stack.getIds(), []);
		assert.strictEqual(renders, 1);
	});

	it("syncs with declarative props without resurrecting dismissed notifications", () => {
		const a = { id: "a", message: "A" };
		const b = { id: "b", message: "B" };
		const stack = new NotificationStack(PLAIN_SEMANTIC_THEME, { notifications: [a, b] });
		stack.dismiss("a");
		stack.setProps({ notifications: [a, b, { id: "c", message: "C" }] });
		assert.deepStrictEqual(stack.getIds(), ["b", "c"]);

		stack.setProps({ notifications: [{ id: "c", message: "C2" }] });
		assert.deepStrictEqual(stack.render(20).lines, ["i C2"]);
		stack.setProps({ notifications: [a] });
		assert.deepStrictEqual(stack.getIds(), ["a"]);
	});
});
