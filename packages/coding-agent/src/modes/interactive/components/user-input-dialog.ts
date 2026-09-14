import {
	type Component,
	CURSOR_MARKER,
	concatRenderFrames,
	createRenderFrame,
	decodePrintableKey,
	Editor,
	type Focusable,
	type Keybinding,
	mapRenderFrameLines,
	prefixRenderFrame,
	type RenderFrame,
	sliceRenderFrame,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@hansjm10/volt-tui";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import type { Theme } from "../../../core/theme/theme.ts";
import type { UserInputRequest, UserInputResponse } from "../../../core/user-input.ts";
import { formatKeyText } from "./keybinding-hints.ts";

interface QuestionDraft {
	selected: number;
	custom: Editor;
	notes: Editor[];
	answer?: string[];
}

/** Preference collection only: highlighting an option never commits an answer. */
export class UserInputDialog implements Component, Focusable {
	private tui: TUI;
	private theme: Theme;
	private keybindings: KeybindingsManager;
	private request: UserInputRequest;
	private done: (response: UserInputResponse) => void;
	private drafts: QuestionDraft[];
	private questionIndex = 0;
	private review = false;
	private reviewIndex = 0;
	private editing: "custom" | "notes" | undefined;
	private completed = false;
	private pasting = false;
	private error = "";
	private scrollOffset = 0;
	private followSelection = true;
	private bodyHeight = 10;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		for (const draft of this.drafts) {
			draft.custom.focused = false;
			for (const editor of draft.notes) editor.focused = false;
		}
		const editor = this.activeEditor;
		if (editor) editor.focused = value;
	}

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		request: UserInputRequest,
		done: (response: UserInputResponse) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.request = request;
		this.done = done;
		this.drafts = request.questions.map((question) => ({
			selected: 0,
			custom: this.createEditor("Your answer"),
			notes: question.options.map(() => this.createEditor("Optional notes")),
		}));
	}

	private createEditor(label: string): Editor {
		const editor = new Editor(
			this.tui,
			{
				borderColor: (text) => this.theme.fg("borderAccent", text),
				placeholder: (text) => this.theme.fg("muted", text),
				selectList: {
					selectedPrefix: (text) => this.theme.fg("accent", text),
					selectedText: (text) => this.theme.fg("accent", text),
					description: (text) => this.theme.fg("muted", text),
					scrollInfo: (text) => this.theme.fg("dim", text),
					noMatch: (text) => this.theme.fg("warning", text),
				},
			},
			{ paddingX: 1, topBorderLabel: label, placeholder: "Write your answer…" },
		);
		// Keep the draft (including paste expansions and cursor) intact on submission.
		editor.disableSubmit = true;
		return editor;
	}

	private get draft(): QuestionDraft {
		return this.drafts[this.questionIndex];
	}

	private get activeEditor(): Editor | undefined {
		if (this.review || !this.editing) return undefined;
		return this.editing === "custom" ? this.draft.custom : this.draft.notes[this.draft.selected];
	}

	private finish(status: UserInputResponse["status"]): void {
		if (this.completed) return;
		this.completed = true;
		this.done({
			status,
			answers:
				status === "answered"
					? Object.fromEntries(
							this.request.questions.map((question, index) => [
								question.id,
								{ answers: this.drafts[index].answer! },
							]),
						)
					: {},
		});
	}

	private commit(): void {
		const question = this.request.questions[this.questionIndex];
		const custom = this.draft.selected === question.options.length;
		const text = (custom ? this.draft.custom : this.draft.notes[this.draft.selected]).getExpandedText().trim();
		if (custom && !text) {
			this.error = "Write an answer, choose an option, or skip.";
			return;
		}
		this.draft.answer = custom ? [text] : [question.options[this.draft.selected].label, ...(text ? [text] : [])];
		this.editing = undefined;
		if (this.request.questions.length === 1) {
			this.finish("answered");
		} else if (this.drafts.every((draft) => draft.answer)) {
			this.review = true;
			this.reviewIndex = this.drafts.length;
		} else {
			this.questionIndex++;
		}
		this.scrollOffset = 0;
	}

	handleInput(data: string): void {
		if (this.completed) return;
		const kb = this.keybindings;
		this.error = "";
		this.followSelection = true;
		// Paste payloads are text, never dialog actions (even across input chunks).
		if (this.pasting || data.includes("\x1b[200~")) {
			this.pasting = !data.includes("\x1b[201~");
			// Review has no text field. Consume the entire paste so an embedded
			// Enter or shortcut can never submit, skip, or cancel the request.
			if (!this.review) {
				if (!this.activeEditor) {
					this.draft.selected = this.request.questions[this.questionIndex].options.length;
					this.editing = "custom";
				}
				this.activeEditor?.handleInput(data);
			}
		} else if (kb.matches(data, "app.questions.skip")) {
			this.finish("skipped");
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.finish("cancelled");
		} else if (kb.matches(data, "app.questions.back")) {
			if (this.editing) this.editing = undefined;
			else if (this.review) {
				this.review = false;
				this.questionIndex = Math.min(this.reviewIndex, this.drafts.length - 1);
			} else this.questionIndex = Math.max(0, this.questionIndex - 1);
			this.scrollOffset = 0;
		} else if (this.activeEditor) {
			if (kb.matches(data, "tui.input.submit") && !kb.matches(data, "tui.input.newLine")) this.commit();
			else this.activeEditor.handleInput(data);
		} else if (
			kb.matches(data, "app.questions.pageUp") ||
			kb.matches(data, "app.questions.pageDown") ||
			kb.matches(data, "tui.select.pageUp") ||
			kb.matches(data, "tui.select.pageDown")
		) {
			this.followSelection = false;
			const up = kb.matches(data, "app.questions.pageUp") || kb.matches(data, "tui.select.pageUp");
			this.scrollOffset += (up ? -1 : 1) * Math.max(1, this.bodyHeight - 2);
		} else if (this.review) {
			if (kb.matches(data, "tui.select.up")) this.reviewIndex = Math.max(0, this.reviewIndex - 1);
			else if (kb.matches(data, "tui.select.down"))
				this.reviewIndex = Math.min(this.drafts.length, this.reviewIndex + 1);
			else if (kb.matches(data, "tui.select.confirm")) {
				if (this.reviewIndex === this.drafts.length) this.finish("answered");
				else {
					this.questionIndex = this.reviewIndex;
					this.review = false;
					this.scrollOffset = 0;
				}
			}
		} else {
			const optionCount = this.request.questions[this.questionIndex].options.length;
			if (kb.matches(data, "tui.select.up")) this.draft.selected = Math.max(0, this.draft.selected - 1);
			else if (kb.matches(data, "tui.select.down"))
				this.draft.selected = Math.min(optionCount, this.draft.selected + 1);
			else if (kb.matches(data, "app.questions.notes") && this.draft.selected < optionCount) this.editing = "notes";
			else if (kb.matches(data, "tui.select.confirm")) {
				if (this.draft.selected === optionCount) this.editing = "custom";
				else this.commit();
			} else if (decodePrintableKey(data) !== undefined || /^[^\x00-\x1f\x7f]/u.test(data)) {
				this.draft.selected = optionCount;
				this.editing = "custom";
				this.draft.custom.handleInput(data);
			}
		}
		this.focused = this._focused;
		this.tui.requestRender();
	}

	invalidate(): void {
		for (const draft of this.drafts) {
			draft.custom.invalidate();
			for (const editor of draft.notes) editor.invalidate();
		}
	}

	private hint(action: Keybinding, label: string): string {
		const keys = this.keybindings.getKeys(action);
		return keys.length ? `${formatKeyText(keys[0])} ${label}` : "";
	}

	render(width: number): RenderFrame {
		if (width < 12)
			return createRenderFrame([
				truncateToWidth(this.theme.fg("muted", "Widen terminal to answer"), Math.max(0, width)),
			]);
		const panelWidth = Math.max(1, Math.min(100, width));
		const contentWidth = Math.max(1, panelWidth - 4);
		const theme = this.theme;
		const question = this.request.questions[this.questionIndex];
		const title = this.review ? "Review answers" : question.header;
		const progress = this.review
			? `${this.drafts.length} answered`
			: `${this.questionIndex + 1} of ${this.drafts.length}`;
		const heading = `─ ${title} · ${progress} `;
		const header = createRenderFrame([
			theme.fg(
				"borderAccent",
				truncateToWidth(heading, panelWidth, "") + "─".repeat(Math.max(0, panelWidth - visibleWidth(heading))),
			),
			"",
		]);
		const lines: string[] = [];
		let anchor = 0;
		const addText = (text: string, prefix = "  ") => {
			for (const [index, line] of wrapTextWithAnsi(text, contentWidth).entries()) {
				lines.push((index === 0 ? prefix : "  ") + line);
			}
		};
		const addChoice = (label: string, description: string, selected: boolean) => {
			if (selected) anchor = lines.length;
			const start = lines.length;
			addText(theme.fg(selected ? "accent" : "text", selected ? theme.bold(label) : label), selected ? "› " : "  ");
			if (description) addText(theme.fg("muted", description));
			if (selected) {
				for (let i = start; i < lines.length; i++) {
					lines[i] = theme.bg(
						"selectedBg",
						lines[i] + " ".repeat(Math.max(0, panelWidth - visibleWidth(lines[i]))),
					);
				}
			}
			lines.push("");
		};
		if (this.review) {
			addText(theme.fg("muted", "Check your choices. Select a question to edit it."));
			lines.push("");
			this.request.questions.forEach((item, index) => {
				addChoice(
					`${index + 1}. ${item.header}`,
					this.drafts[index].answer!.join("\n"),
					index === this.reviewIndex,
				);
			});
			addChoice("Submit answers", "", this.reviewIndex === this.drafts.length);
		} else {
			addText(theme.bold(theme.fg("text", question.question)));
			lines.push("");
			if (this.editing) {
				if (this.editing === "notes") addText(theme.fg("accent", question.options[this.draft.selected].label));
			} else {
				question.options.forEach((option, index) => {
					const hasNotes = this.draft.notes[index].getText().trim().length > 0;
					addChoice(
						`${option.label}${hasNotes ? " · notes saved" : ""}`,
						option.description,
						index === this.draft.selected,
					);
				});
				addChoice(
					`Write your own answer · ${this.draft.custom.getText() ? "Draft saved" : "start typing"}`,
					"",
					this.draft.selected === question.options.length,
				);
			}
		}
		if (lines.at(-1) === "") lines.pop();
		let body = createRenderFrame(lines);
		const editor = this.activeEditor;
		if (editor) {
			const editorFrame = prefixRenderFrame(editor.render(Math.max(3, panelWidth - 2)), " ");
			anchor =
				body.lines.length +
				Math.max(
					1,
					editorFrame.lines.findIndex((line) => line.includes(CURSOR_MARKER)),
				);
			body = concatRenderFrames([body, editorFrame]);
		}
		const primaryHints = editor
			? [
					this.hint("tui.input.submit", "continue"),
					this.hint("tui.input.newLine", "newline"),
					this.hint("app.questions.back", "choices"),
				]
			: [
					`${this.hint("tui.select.up", "").trim()}/${this.hint("tui.select.down", "move")}`,
					this.hint("tui.select.confirm", this.review ? "confirm" : "choose"),
					!this.review ? this.hint("app.questions.notes", "notes") : "",
					this.hint("app.questions.back", "back"),
				];
		const secondaryHints = [this.hint("app.questions.skip", "skip all"), this.hint("tui.select.cancel", "cancel")];
		const footerLines = [
			"",
			...wrapTextWithAnsi(primaryHints.filter(Boolean).join(" · "), Math.max(1, panelWidth - 2)),
			...wrapTextWithAnsi(secondaryHints.filter(Boolean).join(" · "), Math.max(1, panelWidth - 2)),
		];
		if (this.error) footerLines.unshift(theme.fg("warning", truncateToWidth(this.error, panelWidth - 2)));
		const footer = createRenderFrame(footerLines.map((line) => ` ${theme.fg("muted", line)}`));
		// Leave room for the host status/footer and a small amount of conversation.
		this.bodyHeight = Math.max(3, this.tui.terminal.rows - 6 - header.lines.length - footer.lines.length);
		if (body.lines.length > this.bodyHeight) {
			const visibleHeight = Math.max(1, this.bodyHeight - 2);
			if (this.followSelection || editor) {
				if (anchor < this.scrollOffset) this.scrollOffset = anchor;
				else if (anchor >= this.scrollOffset + visibleHeight) this.scrollOffset = anchor - visibleHeight + 1;
			}
			this.scrollOffset = Math.max(0, Math.min(body.lines.length - visibleHeight, this.scrollOffset));
			const end = this.scrollOffset + visibleHeight;
			body = concatRenderFrames([
				createRenderFrame([
					theme.fg(
						"muted",
						this.scrollOffset
							? ` ↑ ${this.scrollOffset} more · ${this.hint("app.questions.pageUp", "scroll")}`
							: "",
					),
				]),
				sliceRenderFrame(body, this.scrollOffset, end),
				createRenderFrame([
					theme.fg(
						"muted",
						end < body.lines.length
							? ` ↓ ${body.lines.length - end} more · ${this.hint("app.questions.pageDown", "scroll")}`
							: "",
					),
				]),
			]);
		}
		this.followSelection = false;
		return mapRenderFrameLines(concatRenderFrames([header, body, footer]), (line) =>
			truncateToWidth(line, Math.max(0, width)),
		);
	}
}
