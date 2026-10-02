import type { FocusDirection, FocusScope } from "../focus.ts";
import { getKeybindings } from "../keybindings.ts";
import { concatRenderFrames, createRenderFrame, type RenderFrame } from "../render-frame.ts";
import { type SemanticTheme, type StyledText, sanitizeText, wrapStyledText } from "../styled-text.ts";
import type { Component, Focusable } from "../tui.ts";
import { sliceByColumn, truncateToWidth, visibleWidth } from "../utils.ts";
import { ActionBar, type ActionItem } from "./action-bar.ts";
import { Input } from "./input.ts";
import { selectionMarker } from "./view-utils.ts";

interface FormFieldBase {
	id: string;
	label: string;
	/** Help text shown below the field while it has focus. */
	description?: StyledText;
}

export interface StringFormField extends FormFieldBase {
	kind: "string";
	value?: string;
	placeholder?: string;
	required?: boolean;
	minLength?: number;
	maxLength?: number;
	/** Regular expression (unanchored, Unicode mode) the value must match. */
	pattern?: string;
}

export interface BooleanFormField extends FormFieldBase {
	kind: "boolean";
	value?: boolean;
}

export interface EnumFormOption {
	value: string;
	label?: string;
}

export interface EnumFormField extends FormFieldBase {
	kind: "enum";
	options: readonly EnumFormOption[];
	value?: string;
	required?: boolean;
}

export interface IntegerFormField extends FormFieldBase {
	kind: "integer";
	value?: number;
	min?: number;
	max?: number;
	required?: boolean;
}

export type FormField = StringFormField | BooleanFormField | EnumFormField | IntegerFormField;
export type FormValue = string | boolean | number | undefined;
export type FormValues = Record<string, FormValue>;
/** Validation messages keyed by field id. */
export type FormErrors = Record<string, string>;

export interface FormProps {
	fields: readonly FormField[];
	/** Defaults to "Submit". */
	submitLabel?: string;
	/** Defaults to "Cancel". */
	cancelLabel?: string;
}

interface FieldState {
	field: FormField;
	input: Input;
	checked: boolean;
	selected: string | undefined;
}

const SUBMIT_ACTION = "submit";
const CANCEL_ACTION = "cancel";

function createFieldState(field: FormField): FieldState {
	const input = new Input();
	if (field.kind === "string") input.setValue(field.value ?? "");
	if (field.kind === "integer") input.setValue(field.value === undefined ? "" : String(field.value));
	return {
		field,
		input,
		checked: field.kind === "boolean" ? (field.value ?? false) : false,
		selected: field.kind === "enum" ? field.value : undefined,
	};
}

function validateField(state: FieldState): string | undefined {
	const { field } = state;
	if (field.kind === "boolean") return undefined;
	if (field.kind === "enum") return field.required && state.selected === undefined ? "Required" : undefined;
	const text = state.input.getValue();
	if (text.trim() === "") return field.required ? "Required" : undefined;
	if (field.kind === "integer") {
		if (!/^\s*-?\d+\s*$/.test(text)) return "Must be a whole number";
		const value = Number.parseInt(text, 10);
		if (field.min !== undefined && value < field.min) return `Must be at least ${field.min}`;
		if (field.max !== undefined && value > field.max) return `Must be at most ${field.max}`;
		return undefined;
	}
	if (field.minLength !== undefined && text.length < field.minLength) {
		return `Must be at least ${field.minLength} characters`;
	}
	if (field.maxLength !== undefined && text.length > field.maxLength) {
		return `Must be at most ${field.maxLength} characters`;
	}
	if (field.pattern !== undefined) {
		let pattern: RegExp | undefined;
		try {
			pattern = new RegExp(field.pattern, "u");
		} catch {
			pattern = undefined;
		}
		if (pattern && !pattern.test(text)) return "Invalid format";
	}
	return undefined;
}

/**
 * Typed form with string, boolean, enum, and integer fields, validation, and submit/cancel actions.
 * Tab and up/down move between fields; confirm submits; cancel cancels; toggle and left/right change
 * boolean and enum values.
 */
export class Form implements Component, Focusable, FocusScope {
	onSubmit?: (values: FormValues) => void;
	onCancel?: () => void;
	private readonly theme: SemanticTheme;
	private props: FormProps;
	private states: FieldState[];
	private readonly actionBar: ActionBar;
	private activeIndex = 0;
	private hasFocus = false;
	private showValidation = false;
	private externalErrors: FormErrors = {};

	constructor(theme: SemanticTheme, props: FormProps) {
		this.theme = theme;
		this.props = props;
		this.states = props.fields.map(createFieldState);
		this.actionBar = new ActionBar(theme, { actions: this.actions() });
		this.actionBar.onAction = (id) => {
			if (id === SUBMIT_ACTION) this.submit();
			else this.onCancel?.();
		};
		this.actionBar.onCancel = () => this.onCancel?.();
	}

	get focused(): boolean {
		return this.hasFocus;
	}

	set focused(focused: boolean) {
		this.hasFocus = focused;
		this.syncFocus();
	}

	/** Apply new fields. Edited values survive unless a field's `value` prop changed or its kind changed. */
	setProps(props: FormProps): void {
		const previousIndex = this.activeIndex;
		const activeId = this.states[previousIndex]?.field.id;
		const previous = new Map(this.states.map((state) => [state.field.id, state]));
		this.props = props;
		this.states = props.fields.map((field) => {
			const state = previous.get(field.id);
			if (!state || state.field.kind !== field.kind || state.field.value !== field.value) {
				return createFieldState(field);
			}
			state.field = field;
			return state;
		});
		this.actionBar.setProps({ actions: this.actions() });
		const nextIndex = this.states.findIndex((state) => state.field.id === activeId);
		if (activeId === undefined) this.activeIndex = this.states.length;
		else this.activeIndex = nextIndex === -1 ? Math.min(previousIndex, this.states.length) : nextIndex;
		this.syncFocus();
	}

	/** Current values: strings, booleans, enum values, and parsed integers (undefined when empty or invalid). */
	getValues(): FormValues {
		const values: FormValues = {};
		for (const state of this.states) {
			const { field } = state;
			if (field.kind === "string") values[field.id] = state.input.getValue();
			else if (field.kind === "boolean") values[field.id] = state.checked;
			else if (field.kind === "enum") values[field.id] = state.selected;
			else {
				const text = state.input.getValue().trim();
				values[field.id] = /^-?\d+$/.test(text) ? Number.parseInt(text, 10) : undefined;
			}
		}
		return values;
	}

	/** Validate every field without showing the result. */
	validate(): FormErrors {
		const errors: FormErrors = {};
		for (const state of this.states) {
			const error = validateField(state);
			if (error !== undefined) errors[state.field.id] = error;
		}
		return errors;
	}

	/** Show errors reported from outside the form, e.g. host-side validation. Editing a field clears its error. */
	setErrors(errors: FormErrors): void {
		this.externalErrors = { ...errors };
	}

	/** Validate and call `onSubmit` when valid. Otherwise show errors and focus the first invalid field. */
	submit(): boolean {
		this.showValidation = true;
		const errors = { ...this.externalErrors, ...this.validate() };
		const firstInvalid = this.states.findIndex((state) => errors[state.field.id] !== undefined);
		if (firstInvalid !== -1) {
			this.setActive(firstInvalid);
			return false;
		}
		this.onSubmit?.(this.getValues());
		return true;
	}

	/** Focus a field by id. */
	focusField(id: string): boolean {
		const index = this.states.findIndex((state) => state.field.id === id);
		if (index === -1) return false;
		this.setActive(index);
		return true;
	}

	moveFocus(direction: FocusDirection): boolean {
		const next = this.activeIndex + direction;
		if (next < 0 || next > this.states.length) return false;
		this.setActive(next);
		return true;
	}

	enterFocus(direction: FocusDirection): boolean {
		this.setActive(direction === 1 ? 0 : this.states.length);
		return true;
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.focus.next") || keybindings.matches(data, "tui.focus.previous")) {
			const direction = keybindings.matches(data, "tui.focus.next") ? 1 : -1;
			if (!this.moveFocus(direction)) this.enterFocus(direction);
			return;
		}
		if (keybindings.matches(data, "tui.select.cancel")) {
			this.onCancel?.();
			return;
		}
		const state = this.states[this.activeIndex];
		if (!state) {
			this.actionBar.handleInput(data);
			return;
		}
		if (keybindings.matches(data, "tui.input.submit") || keybindings.matches(data, "tui.select.confirm")) {
			this.submit();
		} else if (keybindings.matches(data, "tui.select.up")) {
			this.moveFocus(-1);
		} else if (keybindings.matches(data, "tui.select.down")) {
			this.moveFocus(1);
		} else {
			this.editField(state, data);
		}
	}

	invalidate(): void {
		this.actionBar.invalidate();
	}

	render(width: number): RenderFrame {
		const errors = { ...this.externalErrors, ...(this.showValidation ? this.validate() : {}) };
		const labelWidth = Math.min(
			Math.max(0, ...this.states.map((state) => visibleWidth(this.labelText(state.field)))) + 2,
			Math.max(2, Math.floor(width * 0.4)),
		);
		const valueWidth = Math.max(1, width - 2 - labelWidth);
		const indent = " ".repeat(Math.min(width - 1, 2 + labelWidth));
		const lines: string[] = [];
		for (const [index, state] of this.states.entries()) {
			const active = this.hasFocus && index === this.activeIndex;
			const label = truncateToWidth(this.labelText(state.field), labelWidth - 2, "…");
			const paddedLabel = label + " ".repeat(Math.max(0, labelWidth - visibleWidth(label)));
			const styledLabel = active ? this.theme.bold(this.theme.accent(paddedLabel)) : paddedLabel;
			lines.push(
				truncateToWidth(
					`${selectionMarker(this.theme, active)}${styledLabel}${this.renderValue(state, active, valueWidth)}`,
					width,
					"",
				),
			);
			const error = errors[state.field.id];
			if (error !== undefined) {
				lines.push(truncateToWidth(indent + this.theme.error(sanitizeText(error)), width, "…"));
			}
			if (active && state.field.description !== undefined) {
				for (const line of wrapStyledText(state.field.description, valueWidth, this.theme, "muted")) {
					lines.push(truncateToWidth(indent + line, width, ""));
				}
			}
		}
		return concatRenderFrames([createRenderFrame(lines), createRenderFrame([""]), this.actionBar.render(width)]);
	}

	private actions(): ActionItem[] {
		return [
			{ id: SUBMIT_ACTION, label: this.props.submitLabel ?? "Submit", token: "accent" },
			{ id: CANCEL_ACTION, label: this.props.cancelLabel ?? "Cancel" },
		];
	}

	private labelText(field: FormField): string {
		const required = field.kind !== "boolean" && field.required === true;
		return sanitizeText(field.label).replace(/\n/g, " ") + (required ? "*" : "");
	}

	private renderValue(state: FieldState, active: boolean, width: number): string {
		const { field } = state;
		if (field.kind === "boolean") {
			const box = state.checked ? "[x]" : "[ ]";
			return active ? this.theme.accent(box) : box;
		}
		if (field.kind === "enum") {
			const option = field.options.find((candidate) => candidate.value === state.selected);
			const text = option ? sanitizeText(option.label ?? option.value) : "—";
			const display = active ? `‹ ${text} ›` : text;
			const truncated = truncateToWidth(display, width, "…");
			return option ? (active ? this.theme.accent(truncated) : truncated) : this.theme.muted(truncated);
		}
		if (active) {
			// Input renders a two-column prompt before its text; drop it to align with the other values.
			const line = state.input.render(width + 2).lines[0] ?? "";
			return sliceByColumn(line, 2, width, true);
		}
		const value = state.input.getValue();
		if (value.length > 0) return truncateToWidth(sanitizeText(value), width, "…");
		const placeholder = field.kind === "string" ? (field.placeholder ?? "") : "";
		return this.theme.muted(truncateToWidth(sanitizeText(placeholder), width, "…"));
	}

	private editField(state: FieldState, data: string): void {
		const keybindings = getKeybindings();
		const { field } = state;
		const before = this.valueKey(state);
		if (field.kind === "string" || field.kind === "integer") {
			state.input.handleInput(data);
		} else if (field.kind === "boolean") {
			if (
				keybindings.matches(data, "tui.select.toggle") ||
				keybindings.matches(data, "tui.select.left") ||
				keybindings.matches(data, "tui.select.right")
			) {
				state.checked = !state.checked;
			}
		} else if (field.options.length > 0) {
			const index = field.options.findIndex((option) => option.value === state.selected);
			let direction = 0;
			if (keybindings.matches(data, "tui.select.left")) direction = -1;
			else if (keybindings.matches(data, "tui.select.right") || keybindings.matches(data, "tui.select.toggle")) {
				direction = 1;
			}
			if (direction !== 0) {
				const start = index === -1 ? (direction === 1 ? -1 : 0) : index;
				const next = (start + direction + field.options.length) % field.options.length;
				state.selected = field.options[next]!.value;
			}
		}
		if (this.valueKey(state) !== before) {
			this.externalErrors = Object.fromEntries(
				Object.entries(this.externalErrors).filter(([id]) => id !== field.id),
			);
		}
	}

	private valueKey(state: FieldState): string {
		return `${state.input.getValue()}\u0000${state.checked}\u0000${state.selected ?? ""}`;
	}

	private setActive(index: number): void {
		this.activeIndex = Math.max(0, Math.min(index, this.states.length));
		this.syncFocus();
	}

	private syncFocus(): void {
		for (const [index, state] of this.states.entries()) {
			state.input.focused = this.hasFocus && index === this.activeIndex;
		}
		this.actionBar.focused = this.hasFocus && this.activeIndex === this.states.length;
	}
}
