/**
 * The TUI's `UiNode` mapping (RFC §8.3, §10) on the generic reconciler of
 * packages/tui: each of the 14 node types renders as a retained component
 * that keyed updates change in place, in either screen mode. Semantic tokens
 * resolve through the TUI theme (`semantic-theme.ts`).
 *
 * Actions, card actions, and forms send their intents to the view's intent
 * sink (`intents.ts`); without one they render but send nothing. Interactive
 * components (forms, action bars, cards, trees) take input once their host
 * focuses them; Tab moves through a card's interactive section children.
 * Image nodes render as terminal images when the terminal can show them, else
 * as a one-line description.
 */

import type {
	UiCardNode,
	UiCodeNode,
	UiFormNode,
	UiImageNode,
	UiKeyValueNode,
	UiNode,
	UiNodeAction,
	UiNodeFormField,
	UiNodeStyledText,
	UiNodeToken,
	UiProgressNode,
	UiTableNode,
	UiTerminalNode,
	UiTextNode,
} from "@hansjm10/volt-protocol";
import {
	ActionBar,
	type ActionItem,
	Card,
	type CardProps,
	type Component,
	concatRenderFrames,
	createRenderFrame,
	DiffView,
	FocusGroup,
	Form,
	type FormField,
	type FormProps,
	getCapabilities,
	getImageDimensions,
	Image,
	Markdown,
	ProgressBar,
	prefixRenderFrame,
	type RenderFrame,
	StepProgress,
	type StyledText,
	Table,
	TerminalOutput,
	TreeView,
	truncateStyledText,
	truncateToWidth,
	ViewReconciler,
	ViewRegistry,
	visibleWidth,
	wrapStyledText,
	wrapTextWithAnsi,
} from "@hansjm10/volt-tui";
import { getMarkdownTheme, highlightCode, theme } from "../../../core/theme/runtime.ts";
import { formSubmitIntent, type UiIntentSink } from "./intents.ts";
import { TUI_SEMANTIC_THEME } from "./semantic-theme.ts";

export interface UiNodeViewOptions {
	/** Where actions, card actions, and forms send their intents. Without one they send nothing. */
	readonly intents?: UiIntentSink;
	/** Show image nodes as terminal images when the terminal can. Defaults to true. */
	readonly showImages?: boolean;
}

/** Most rows a terminal node shows, its newest lines. */
const TERMINAL_VISIBLE_ROWS = 12;
/** Widest terminal image, in cells. */
const IMAGE_MAX_WIDTH_CELLS = 60;

/** Styled text, wrapped. */
class StyledTextView implements Component {
	private text: StyledText;
	private token: UiNodeToken;

	constructor(text: StyledText, token: UiNodeToken = "text") {
		this.text = text;
		this.token = token;
	}

	set(text: StyledText, token: UiNodeToken = "text"): void {
		this.text = text;
		this.token = token;
	}

	invalidate(): void {}

	render(width: number): RenderFrame {
		return createRenderFrame(wrapStyledText(this.text, width, TUI_SEMANTIC_THEME, this.token));
	}
}

/** Labelled values, one item per line: the label muted, the value wrapped after it. */
class KeyValueView implements Component {
	private items: UiKeyValueNode["items"];

	constructor(items: UiKeyValueNode["items"]) {
		this.items = items;
	}

	set(items: UiKeyValueNode["items"]): void {
		this.items = items;
	}

	invalidate(): void {}

	render(width: number): RenderFrame {
		const lines: string[] = [];
		for (const item of this.items) {
			const label = wrapStyledText(item.label, width, TUI_SEMANTIC_THEME, "muted").join(" ");
			const prefix = truncateToWidth(`${label}: `, Math.max(1, Math.floor(width / 2)), "…");
			const indent = visibleWidth(prefix);
			const value = wrapStyledText(item.value, Math.max(1, width - indent), TUI_SEMANTIC_THEME);
			lines.push(...value.map((line, index) => `${index === 0 ? prefix : " ".repeat(indent)}${line}`));
		}
		return createRenderFrame(lines);
	}
}

/** A list's items, each after its bullet or number. */
class ListView implements Component {
	private ordered: boolean;
	private items: readonly Component[] = [];

	constructor(ordered: boolean) {
		this.ordered = ordered;
	}

	set(ordered: boolean, items: readonly Component[]): void {
		this.ordered = ordered;
		this.items = items;
	}

	invalidate(): void {
		for (const item of this.items) item.invalidate();
	}

	render(width: number): RenderFrame {
		const frames: RenderFrame[] = [];
		this.items.forEach((item, index) => {
			const marker = this.ordered ? `${index + 1}. ` : "• ";
			const indent = " ".repeat(marker.length);
			const frame = prefixRenderFrame(item.render(Math.max(1, width - marker.length)), indent);
			const [first, ...rest] = frame.lines;
			if (first === undefined) return;
			frames.push(
				createRenderFrame([`${theme.fg("muted", marker)}${first.slice(indent.length)}`, ...rest], frame.images),
			);
		});
		return concatRenderFrames(frames);
	}
}

/** A component under an optional bold title line. */
class TitledView<C extends Component> implements Component {
	readonly body: C;
	private title: UiNodeStyledText | undefined;

	constructor(body: C, title: UiNodeStyledText | undefined) {
		this.body = body;
		this.title = title;
	}

	setTitle(title: UiNodeStyledText | undefined): void {
		this.title = title;
	}

	invalidate(): void {
		this.body.invalidate();
	}

	render(width: number): RenderFrame {
		const body = this.body.render(width);
		if (this.title === undefined) return body;
		const title = TUI_SEMANTIC_THEME.bold(truncateStyledText(this.title, width, TUI_SEMANTIC_THEME));
		return concatRenderFrames([createRenderFrame([title]), body]);
	}
}

/** A determinate bar or a list of steps; a node that changes kind swaps the component. */
class ProgressView implements Component {
	private view: { kind: "determinate"; bar: ProgressBar } | { kind: "steps"; steps: StepProgress };

	constructor(node: UiProgressNode) {
		this.view = ProgressView.create(node);
	}

	private static create(node: UiProgressNode): ProgressView["view"] {
		return node.kind === "determinate"
			? { kind: "determinate", bar: new ProgressBar(TUI_SEMANTIC_THEME, barProps(node)) }
			: { kind: "steps", steps: new StepProgress(TUI_SEMANTIC_THEME, stepsProps(node)) };
	}

	set(node: UiProgressNode): void {
		if (node.kind === "determinate" && this.view.kind === "determinate") this.view.bar.setProps(barProps(node));
		else if (node.kind === "steps" && this.view.kind === "steps") this.view.steps.setProps(stepsProps(node));
		else this.view = ProgressView.create(node);
	}

	invalidate(): void {}

	render(width: number): RenderFrame {
		return this.view.kind === "determinate" ? this.view.bar.render(width) : this.view.steps.render(width);
	}
}

function barProps(node: Extract<UiProgressNode, { kind: "determinate" }>) {
	return { value: node.value, max: node.max, label: node.label, token: node.token };
}

function stepsProps(node: Extract<UiProgressNode, { kind: "steps" }>) {
	return {
		steps: node.steps.map((step) => ({ label: step.label, status: step.status, detail: step.detail })),
		title: node.title,
	};
}

/** Code, highlighted by language, after a muted gutter. */
class CodeView implements Component {
	private node: UiCodeNode;
	private cache: { width: number; frame: RenderFrame } | undefined;

	constructor(node: UiCodeNode) {
		this.node = node;
	}

	set(node: UiCodeNode): void {
		this.node = node;
		this.cache = undefined;
	}

	invalidate(): void {
		this.cache = undefined;
	}

	render(width: number): RenderFrame {
		if (this.cache?.width === width) return this.cache.frame;
		const gutter = theme.fg("mdCodeBlockBorder", "│ ");
		const code = this.node.code.replace(/\t/g, "   ");
		const lines = highlightCode(code, this.node.language)
			.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width - 2)))
			.map((line) => truncateToWidth(`${gutter}${line}`, width, ""));
		const frame = createRenderFrame(lines);
		this.cache = { width, frame };
		return frame;
	}
}

/** An image the terminal shows, or a one-line description where it cannot. */
class ImageView implements Component {
	private node: UiImageNode;
	private readonly showImages: boolean;
	private image: Image | undefined;
	private description: string | undefined;

	constructor(node: UiImageNode, showImages: boolean) {
		this.node = node;
		this.showImages = showImages;
	}

	set(node: UiImageNode): void {
		if (node.data !== this.node.data || node.mimeType !== this.node.mimeType) this.dispose();
		this.node = node;
		this.description = undefined;
	}

	invalidate(): void {
		this.image?.invalidate();
	}

	dispose(): void {
		this.image?.dispose();
		this.image = undefined;
	}

	render(width: number): RenderFrame {
		const protocol = getCapabilities().images;
		// Kitty and Sixel placements take PNG data only.
		if (this.showImages && protocol !== null && (protocol === "iterm2" || this.node.mimeType === "image/png")) {
			this.image ??= new Image(
				this.node.data,
				this.node.mimeType,
				{ fallbackColor: (text) => theme.fg("muted", text) },
				{ maxWidthCells: IMAGE_MAX_WIDTH_CELLS },
			);
			return this.image.render(width);
		}
		this.description ??= this.describe();
		return createRenderFrame([theme.fg("muted", truncateToWidth(this.description, width, "…"))]);
	}

	private describe(): string {
		const dimensions = getImageDimensions(this.node.data, this.node.mimeType);
		const parts = [
			...(this.node.alt ? [this.node.alt.replace(/\s+/g, " ").trim()] : []),
			`[${this.node.mimeType}]`,
			...(dimensions ? [`${dimensions.widthPx}x${dimensions.heightPx}`] : []),
		];
		return `[Image: ${parts.join(" ")}]`;
	}
}

function actionItems(actions: readonly UiNodeAction[]): ActionItem[] {
	return actions.map((action) => ({
		id: action.id,
		label: action.label,
		token: action.token ?? (action.destructive ? "error" : undefined),
		disabled: action.disabled,
	}));
}

/** Send the intent of the enabled action `id`. */
function sendAction(actions: readonly UiNodeAction[], id: string, intents: UiIntentSink | undefined): void {
	const action = actions.find((candidate) => candidate.id === id);
	if (action && !action.disabled) intents?.send(action.intent);
}

/** A row of actions; activating one sends its intent. */
class ActionsView extends ActionBar {
	private actions: readonly UiNodeAction[];

	constructor(actions: readonly UiNodeAction[], intents: UiIntentSink | undefined) {
		super(TUI_SEMANTIC_THEME, { actions: actionItems(actions) });
		this.actions = actions;
		this.onAction = (id) => sendAction(this.actions, id, intents);
	}

	set(actions: readonly UiNodeAction[]): void {
		this.actions = actions;
		this.setProps({ actions: actionItems(actions) });
	}
}

function cardProps(node: UiCardNode, sections: readonly Component[]): CardProps {
	return {
		title: node.title,
		titleToken: node.token,
		badges: node.badges,
		sections: (node.sections ?? []).map((section, index) => {
			const view = sections[index];
			return { title: section.title, children: view === undefined ? [] : [view] };
		}),
		actions: actionItems(node.actions ?? []),
	};
}

/** One card section: its children reconciled by key, in a focus group so Tab reaches the interactive ones. */
interface CardSectionView {
	readonly view: ViewReconciler<UiNode>;
	readonly group: FocusGroup;
}

/** A card; each section reconciles its children, and the actions send their intents. */
class CardView extends Card {
	private readonly registry: ViewRegistry<UiNode>;
	private sections = new Map<string, CardSectionView>();
	private actions: readonly UiNodeAction[] = [];

	constructor(node: UiCardNode, registry: ViewRegistry<UiNode>, intents: UiIntentSink | undefined) {
		super(TUI_SEMANTIC_THEME, cardProps(node, []));
		this.registry = registry;
		this.onAction = (id) => sendAction(this.actions, id, intents);
		this.set(node);
		// Input starts at the first interactive section child, before the card's own actions.
		this.enterFocus(1);
	}

	set(node: UiCardNode): void {
		const sections = node.sections ?? [];
		const keys = sections.map((section, index) => (section.key === undefined ? `#${index}` : `=${section.key}`));
		const duplicate = keys.find((key, index) => keys.indexOf(key) !== index);
		if (duplicate !== undefined) throw new Error(`Duplicate card section key "${duplicate.slice(1)}"`);
		const next = new Map<string, CardSectionView>();
		const groups = sections.map((section, index) => {
			const key = keys[index]!;
			const retained = this.sections.get(key);
			this.sections.delete(key);
			const entry = retained ?? {
				view: new ViewReconciler(this.registry),
				group: new FocusGroup([], { wrap: false }),
			};
			next.set(key, entry);
			entry.view.update(section.children);
			entry.group.setChildren(entry.view.children);
			return entry.group;
		});
		for (const stale of this.sections.values()) stale.view.dispose();
		this.sections = next;
		this.actions = node.actions ?? [];
		this.setProps(cardProps(node, groups));
	}

	dispose(): void {
		for (const section of this.sections.values()) section.view.dispose();
		this.sections.clear();
	}
}

function formField(field: UiNodeFormField): FormField {
	const base = { id: field.id, label: field.label, description: field.description };
	switch (field.kind) {
		case "string":
			return {
				...base,
				kind: "string",
				value: field.value,
				placeholder: field.placeholder,
				required: field.required,
				minLength: field.minLength,
				maxLength: field.maxLength,
				// The whole value must match, as the host checks it.
				pattern: field.pattern === undefined ? undefined : `^(?:${field.pattern})$`,
			};
		case "boolean":
			return { ...base, kind: "boolean", value: field.value };
		case "enum":
			return {
				...base,
				kind: "enum",
				options: field.options.map((option) => ({ value: option.value, label: option.label })),
				value: field.value,
				required: field.required,
			};
		case "integer":
			return {
				...base,
				kind: "integer",
				value: field.value,
				min: field.min,
				max: field.max,
				required: field.required,
			};
	}
}

function formProps(node: UiFormNode): FormProps {
	return { fields: node.fields.map(formField), submitLabel: node.submitLabel, cancelLabel: node.cancelLabel };
}

/** A form under its title; submitting sends its submit intent with the values, cancelling its cancel intent. */
class FormView extends Form {
	private node: UiFormNode;

	constructor(node: UiFormNode, intents: UiIntentSink | undefined) {
		super(TUI_SEMANTIC_THEME, formProps(node));
		this.node = node;
		this.onSubmit = (values) => intents?.send(formSubmitIntent(this.node.submit, values));
		this.onCancel = () => {
			if (this.node.cancel) intents?.send(this.node.cancel);
		};
	}

	set(node: UiFormNode): void {
		this.node = node;
		this.setProps(formProps(node));
	}

	override render(width: number): RenderFrame {
		const form = super.render(width);
		if (this.node.title === undefined) return form;
		const title = TUI_SEMANTIC_THEME.bold(truncateStyledText(this.node.title, width, TUI_SEMANTIC_THEME));
		return concatRenderFrames([createRenderFrame([title]), form]);
	}
}

function terminalProps(node: UiTerminalNode) {
	return { lines: node.lines, omittedLines: node.omittedLines, maxVisibleRows: TERMINAL_VISIBLE_ROWS };
}

function tableProps(node: UiTableNode) {
	return { columns: node.columns, rows: node.rows.map((row) => row.cells), emptyText: node.emptyText };
}

function textToken(node: UiTextNode): UiNodeToken {
	return node.token ?? "text";
}

/** The node-type registry of the mapping: every `UiNode` type. */
export function createUiNodeRegistry(options: UiNodeViewOptions = {}): ViewRegistry<UiNode> {
	const { intents } = options;
	const showImages = options.showImages ?? true;
	const registry = new ViewRegistry<UiNode>();
	registry.register("text", {
		create: (node) => new StyledTextView(node.text, textToken(node)),
		update: (view, node) => view.set(node.text, textToken(node)),
	});
	registry.register("markdown", {
		create: (node) => new Markdown(node.markdown, 0, 0, getMarkdownTheme()),
		update: (view, node) => view.setText(node.markdown),
	});
	registry.register("list", {
		create: (node) => new ListView(node.ordered === true),
		update: () => {},
		children: (node) => node.items,
		mount: (view, items, node) => view.set(node.ordered === true, items),
	});
	registry.register("table", {
		create: (node) => new Table(TUI_SEMANTIC_THEME, tableProps(node)),
		update: (view, node) => view.setProps(tableProps(node)),
	});
	registry.register("keyValue", {
		create: (node) => new KeyValueView(node.items),
		update: (view, node) => view.set(node.items),
	});
	registry.register("progress", {
		create: (node) => new ProgressView(node),
		update: (view, node) => view.set(node),
	});
	registry.register("form", {
		create: (node) => new FormView(node, intents),
		update: (view, node) => view.set(node),
	});
	registry.register("actions", {
		create: (node) => new ActionsView(node.actions, intents),
		update: (view, node) => view.set(node.actions),
	});
	registry.register("card", {
		create: (node) => new CardView(node, registry, intents),
		update: (view, node) => view.set(node),
	});
	registry.register("diff", {
		create: (node) =>
			new TitledView(
				new DiffView(TUI_SEMANTIC_THEME, { lines: node.lines, lineNumbers: node.lineNumbers }),
				node.path,
			),
		update: (view, node) => {
			view.setTitle(node.path);
			view.body.setProps({ lines: node.lines, lineNumbers: node.lineNumbers });
		},
	});
	registry.register("terminal", {
		create: (node) => new TitledView(new TerminalOutput(TUI_SEMANTIC_THEME, terminalProps(node)), node.title),
		update: (view, node) => {
			view.setTitle(node.title);
			view.body.setProps(terminalProps(node));
		},
	});
	registry.register("code", {
		create: (node) => new TitledView(new CodeView(node), node.title),
		update: (view, node) => {
			view.setTitle(node.title);
			view.body.set(node);
		},
	});
	registry.register("image", {
		create: (node) => new ImageView(node, showImages),
		update: (view, node) => view.set(node),
	});
	registry.register("tree", {
		create: (node) => new TreeView(TUI_SEMANTIC_THEME, { items: node.items, expanded: node.expanded }),
		update: (view, node) => view.setProps({ items: node.items, expanded: node.expanded }),
	});
	return registry;
}

/** A retained view of `UiNode` trees: `update` reconciles it against new roots. */
export function createUiNodeView(options: UiNodeViewOptions = {}): ViewReconciler<UiNode> {
	return new ViewReconciler(createUiNodeRegistry(options));
}
