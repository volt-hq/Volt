import assert from "node:assert";
import { describe, it } from "node:test";
import { Form, type FormField, type FormValues } from "../src/components/form.ts";
import { FocusGroup } from "../src/focus.ts";
import { PLAIN_SEMANTIC_THEME } from "../src/styled-text.ts";
import { CURSOR_MARKER } from "../src/tui.ts";
import { visibleWidth } from "../src/utils.ts";
import { KEYS, showTags, tagTheme } from "./semantic-test-theme.ts";

const fields: FormField[] = [
	{ kind: "string", id: "name", label: "Name", required: true, placeholder: "your name" },
	{ kind: "boolean", id: "notify", label: "Notify" },
	{
		kind: "enum",
		id: "level",
		label: "Level",
		options: [
			{ value: "low", label: "Low" },
			{ value: "high", label: "High" },
		],
		value: "low",
	},
	{ kind: "integer", id: "retries", label: "Retries", min: 0, max: 5, description: "Attempts before failing" },
];

const stripAnsi = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "").replaceAll(CURSOR_MARKER, "");

function type(form: Form, text: string): void {
	for (const char of text) form.handleInput(char);
}

describe("Form", () => {
	it("renders labels, values, and actions within the width", () => {
		const form = new Form(PLAIN_SEMANTIC_THEME, { fields });
		assert.deepStrictEqual(form.render(40).lines, [
			"  Name*    your name",
			"  Notify   [ ]",
			"  Level    Low",
			"  Retries  ",
			"",
			"[ Submit ] [ Cancel ]",
		]);
		for (const width of [40, 16, 8]) {
			for (const line of form.render(width).lines) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
		}
	});

	it("edits every field kind and submits typed values", () => {
		const form = new Form(PLAIN_SEMANTIC_THEME, { fields });
		const submitted: FormValues[] = [];
		form.onSubmit = (values) => submitted.push(values);
		form.focused = true;

		type(form, "Ada");
		form.handleInput(KEYS.tab);
		form.handleInput(KEYS.space);
		form.handleInput(KEYS.down);
		form.handleInput(KEYS.right);
		form.handleInput(KEYS.tab);
		type(form, "3");
		assert.ok(form.render(60).lines.some((line) => stripAnsi(line).includes("Attempts before failing")));
		form.handleInput(KEYS.enter);

		assert.deepStrictEqual(submitted, [{ name: "Ada", notify: true, level: "high", retries: 3 }]);
	});

	it("shows validation errors after a submit attempt and focuses the first invalid field", () => {
		const form = new Form(tagTheme, { fields });
		const submitted: FormValues[] = [];
		form.onSubmit = (values) => submitted.push(values);
		form.focused = true;
		form.focusField("retries");
		type(form, "9");
		assert.strictEqual(form.submit(), false);

		const lines = form.render(40).lines.map(showTags);
		assert.ok(lines.includes("           <error>Required</error>"), lines.join("\n"));
		assert.ok(lines.includes("           <error>Must be at most 5</error>"), lines.join("\n"));
		assert.ok(lines[0]!.startsWith("<accent>› </accent><b><accent>Name*"), lines[0]);
		assert.deepStrictEqual(form.validate(), { name: "Required", retries: "Must be at most 5" });

		type(form, "Ada");
		form.focusField("retries");
		form.handleInput(KEYS.backspace);
		type(form, "x");
		assert.deepStrictEqual(form.validate(), { retries: "Must be a whole number" });
		form.handleInput(KEYS.backspace);
		form.handleInput(KEYS.enter);
		assert.deepStrictEqual(submitted, [{ name: "Ada", notify: false, level: "low", retries: undefined }]);
	});

	it("validates string length and pattern", () => {
		const form = new Form(PLAIN_SEMANTIC_THEME, {
			fields: [{ kind: "string", id: "code", label: "Code", minLength: 2, maxLength: 4, pattern: "^[a-z]+$" }],
		});
		form.focused = true;
		assert.deepStrictEqual(form.validate(), {});
		type(form, "a");
		assert.deepStrictEqual(form.validate(), { code: "Must be at least 2 characters" });
		type(form, "bcde");
		assert.deepStrictEqual(form.validate(), { code: "Must be at most 4 characters" });
		form.handleInput(KEYS.backspace);
		form.handleInput(KEYS.backspace);
		type(form, "1");
		assert.deepStrictEqual(form.validate(), { code: "Invalid format" });
	});

	it("submits and cancels from the action bar and cancels from any field", () => {
		const form = new Form(PLAIN_SEMANTIC_THEME, { fields: [{ kind: "string", id: "q", label: "Query" }] });
		const events: string[] = [];
		form.onSubmit = () => events.push("submit");
		form.onCancel = () => events.push("cancel");
		form.focused = true;

		form.handleInput(KEYS.escape);
		form.handleInput(KEYS.shiftTab);
		form.handleInput(KEYS.enter);
		form.handleInput(KEYS.right);
		form.handleInput(KEYS.enter);
		form.handleInput(KEYS.tab);
		type(form, "z");

		assert.deepStrictEqual(events, ["cancel", "submit", "cancel"]);
		assert.deepStrictEqual(form.getValues(), { q: "z" });
	});

	it("emits the cursor marker only for the focused text field", () => {
		const form = new Form(PLAIN_SEMANTIC_THEME, { fields });
		assert.ok(!form.render(40).lines.some((line) => line.includes(CURSOR_MARKER)));
		form.focused = true;
		type(form, "Al");
		const nameLine = form.render(40).lines[0]!;
		assert.ok(nameLine.includes(CURSOR_MARKER), nameLine);
		assert.strictEqual(stripAnsi(nameLine).trimEnd(), "› Name*    Al");
	});

	it("shows external errors until the field is edited", () => {
		const form = new Form(PLAIN_SEMANTIC_THEME, { fields: [{ kind: "string", id: "name", label: "Name" }] });
		form.focused = true;
		form.setErrors({ name: "Already taken" });
		assert.ok(form.render(40).lines.includes("        Already taken"));
		assert.strictEqual(form.submit(), false);
		type(form, "b");
		assert.ok(!form.render(40).lines.includes("        Already taken"));
		assert.strictEqual(form.submit(), true);
	});

	it("keeps edited values across updates unless a field's value prop changes", () => {
		const form = new Form(PLAIN_SEMANTIC_THEME, { fields });
		form.focused = true;
		type(form, "Ada");
		form.focusField("level");
		form.handleInput(KEYS.right);

		form.setProps({ fields: [{ kind: "string", id: "title", label: "Title" }, ...fields] });
		assert.deepStrictEqual(form.getValues(), {
			title: "",
			name: "Ada",
			notify: false,
			level: "high",
			retries: undefined,
		});
		form.handleInput(KEYS.left);
		const { level } = form.getValues();
		assert.strictEqual(level, "low");

		form.setProps({
			fields: fields.map((field) =>
				field.kind === "string" && field.id === "name" ? { ...field, value: "Grace" } : field,
			),
		});
		const { name } = form.getValues();
		assert.strictEqual(name, "Grace");
	});

	it("is traversed field by field inside a focus group", () => {
		const form = new Form(PLAIN_SEMANTIC_THEME, { fields: fields.slice(0, 2) });
		const group = new FocusGroup([form]);
		group.focused = true;
		group.handleInput(KEYS.tab);
		group.handleInput(KEYS.space);
		group.handleInput(KEYS.tab);
		group.handleInput(KEYS.tab);
		type(form, "x");
		assert.deepStrictEqual(form.getValues(), { name: "x", notify: true });
	});
});
