/**
 * One extension's detail and settings form (RFC §8.2): its name, version,
 * where it was found, its permissions and whether they were acknowledged, and
 * a form generated from its settings schema. `/extensions` shows it for a
 * conversation's extension, saving through the `extension_settings` query and
 * the `set_extension_settings` intent; `volt config` shows it standalone over
 * the settings files.
 *
 * The form edits one scope at a time: global settings, or a trusted project's
 * (the "Save to" field). A field shows what that scope stores; a string left
 * empty, or an enum left unset, falls back to the global value or the
 * default. Saving replaces what the scope stores.
 */

import type {
	ExtensionManifest,
	ExtensionPermission,
	ExtensionSettingsScope,
	ExtensionSettingsValues,
	ExtensionSettingsView,
	ExtensionSourceScope,
} from "@hansjm10/volt-protocol";
import {
	type Component,
	concatRenderFrames,
	createRenderFrame,
	type Focusable,
	Form,
	type FormField,
	type FormValues,
	type RenderFrame,
	sanitizeText,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@hansjm10/volt-tui";
import {
	describePermissions,
	type ExtensionPermissionStore,
	permissionSubject,
} from "../../../core/extensions/permissions.ts";
import { theme } from "../../../core/theme/runtime.ts";
import { formField } from "../ui-node/registry.ts";
import { TUI_SEMANTIC_THEME } from "../ui-node/semantic-theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";

/** What the detail shows about an extension. */
export interface ExtensionDetail {
	readonly id: string;
	readonly displayName: string;
	readonly description?: string;
	readonly version: string;
	readonly scope: ExtensionSourceScope;
	readonly permissions: readonly ExtensionPermission[];
	readonly permissionsAcknowledged: boolean;
}

/** An extension as loading or `volt config` reads it. */
export interface DeclaredExtensionDetail {
	readonly manifest: ExtensionManifest;
	readonly version: string;
	readonly scope: ExtensionSourceScope;
	readonly fingerprint: string;
}

/** The detail of `extension`, with whether the user acknowledged its permissions. */
export function extensionDetail(extension: DeclaredExtensionDetail, store: ExtensionPermissionStore): ExtensionDetail {
	const permissions = extension.manifest.permissions ?? [];
	let permissionsAcknowledged: boolean;
	try {
		permissionsAcknowledged = store.isAcknowledged(
			permissionSubject({
				id: extension.manifest.id,
				fingerprint: extension.fingerprint,
				manifest: extension.manifest,
			}),
		);
	} catch {
		permissionsAcknowledged = permissions.length === 0;
	}
	return {
		id: extension.manifest.id,
		displayName: extension.manifest.displayName,
		...(extension.manifest.description === undefined ? {} : { description: extension.manifest.description }),
		version: extension.version,
		scope: extension.scope,
		permissions,
		permissionsAcknowledged,
	};
}

/** Where the form reads and stores the extension's settings. */
export interface ExtensionSettingsSource {
	/** The settings form and the values each scope stores. */
	load(): Promise<ExtensionSettingsView>;
	/** Replace what `scope` stores; rejects with a message to show when the values are refused. */
	save(scope: ExtensionSettingsScope, values: ExtensionSettingsValues): Promise<void>;
}

export interface ExtensionSettingsComponentOptions {
	readonly onClose: () => void;
	readonly requestRender: () => void;
}

/** The "Save to" field's id: setting names start with a letter, so none takes it. */
const SCOPE_FIELD = "#scope";

/** A form that reports when its "Save to" field changes. */
class SettingsForm extends Form {
	onScopeChange?: (scope: ExtensionSettingsScope) => void;
	private scope: ExtensionSettingsScope;

	constructor(fields: readonly FormField[], scope: ExtensionSettingsScope) {
		super(TUI_SEMANTIC_THEME, { fields, submitLabel: "Save", cancelLabel: "Close" });
		this.scope = scope;
	}

	setScope(scope: ExtensionSettingsScope): void {
		this.scope = scope;
	}

	override handleInput(data: string): void {
		super.handleInput(data);
		const scope = this.getValues()[SCOPE_FIELD];
		if ((scope === "global" || scope === "project") && scope !== this.scope) {
			this.scope = scope;
			this.onScopeChange?.(scope);
		}
	}
}

function formatValue(value: string | boolean | number): string {
	return typeof value === "string" ? JSON.stringify(value) : String(value);
}

export class ExtensionSettingsComponent implements Component, Focusable {
	private readonly detail: ExtensionDetail;
	private readonly source: ExtensionSettingsSource;
	private readonly options: ExtensionSettingsComponentOptions;
	private readonly border = new DynamicBorder();
	private view: ExtensionSettingsView | undefined;
	private scope: ExtensionSettingsScope = "global";
	private form: SettingsForm | undefined;
	private status: { readonly text: string; readonly token: "muted" | "success" | "error" } | undefined;
	private hasFocus = false;
	private saving = false;

	constructor(detail: ExtensionDetail, source: ExtensionSettingsSource, options: ExtensionSettingsComponentOptions) {
		this.detail = detail;
		this.source = source;
		this.options = options;
		this.status = { text: "Loading settings…", token: "muted" };
	}

	get focused(): boolean {
		return this.hasFocus;
	}

	set focused(focused: boolean) {
		this.hasFocus = focused;
		if (this.form) this.form.focused = focused;
	}

	/** Load the settings and show the form. */
	async start(): Promise<void> {
		await this.reload();
	}

	private async reload(message?: ExtensionSettingsComponent["status"]): Promise<void> {
		try {
			this.view = await this.source.load();
			if (this.scope === "project" && !this.view.projectTrusted) this.scope = "global";
			this.status = message;
			this.buildForm();
		} catch (error) {
			this.status = { text: error instanceof Error ? error.message : String(error), token: "error" };
		}
		this.options.requestRender();
	}

	/** The value a field falls back to in the current scope: the global value for a project, then the default. */
	private inherited(name: string): string | boolean | number | undefined {
		const view = this.view;
		if (view === undefined) return undefined;
		const global =
			this.scope === "project" && Object.hasOwn(view.values.global, name) ? view.values.global[name] : undefined;
		return global ?? view.form.find((field) => field.id === name)?.value;
	}

	/** A field's description, saying what an empty value falls back to. */
	private fallbackDescription(
		description: FormField["description"],
		inherited: string | boolean | number | undefined,
	): { description?: FormField["description"] } {
		if (inherited === undefined) return description === undefined ? {} : { description };
		const fallback = `Empty uses ${this.scope === "project" ? "the inherited value" : "the default"}, ${formatValue(inherited)}.`;
		if (description === undefined) return { description: fallback };
		if (typeof description === "string") return { description: `${description} ${fallback}` };
		return { description: [...description, { text: ` ${fallback}` }] };
	}

	private fields(): FormField[] {
		const view = this.view;
		if (view === undefined) return [];
		const stored = (this.scope === "project" ? view.values.project : view.values.global) ?? {};
		const fields: FormField[] = [];
		if (view.projectTrusted) {
			fields.push({
				id: SCOPE_FIELD,
				kind: "enum",
				label: "Save to",
				options: [
					{ value: "global", label: "Global (every project)" },
					{ value: "project", label: "This project" },
				],
				value: this.scope,
			});
		}
		for (const uiField of view.form) {
			const field = formField(uiField);
			const value = Object.hasOwn(stored, field.id) ? stored[field.id] : undefined;
			const inherited = this.inherited(field.id);
			const required = inherited === undefined && field.kind !== "boolean" && field.required === true;
			switch (field.kind) {
				case "string":
					fields.push({
						...field,
						value: typeof value === "string" ? value : undefined,
						required,
						...(inherited === undefined
							? {}
							: {
									placeholder: `${this.scope === "project" ? "inherited" : "default"}: ${formatValue(inherited)}`,
								}),
					});
					break;
				case "boolean":
					fields.push({
						...field,
						value: typeof value === "boolean" ? value : inherited === true,
					});
					break;
				case "enum":
					fields.push({
						...field,
						value: typeof value === "string" ? value : undefined,
						required,
						...this.fallbackDescription(field.description, inherited),
					});
					break;
				case "integer":
					fields.push({
						...field,
						value: typeof value === "number" ? value : undefined,
						required,
						...this.fallbackDescription(field.description, inherited),
					});
					break;
			}
		}
		return fields;
	}

	private buildForm(): void {
		const view = this.view;
		if (view === undefined || view.form.length === 0) {
			this.form = undefined;
			return;
		}
		const form = new SettingsForm(this.fields(), this.scope);
		form.onSubmit = (values) => void this.save(values);
		form.onCancel = () => this.options.onClose();
		form.onScopeChange = (scope) => {
			this.scope = scope;
			this.status = undefined;
			form.setProps({ fields: this.fields(), submitLabel: "Save", cancelLabel: "Close" });
			this.options.requestRender();
		};
		form.focused = this.hasFocus;
		this.form = form;
	}

	private async save(values: FormValues): Promise<void> {
		const view = this.view;
		if (view === undefined || this.saving) return;
		const stored = (this.scope === "project" ? view.values.project : view.values.global) ?? {};
		const settings: ExtensionSettingsValues = {};
		for (const field of view.form) {
			const value = values[field.id];
			if (value === undefined || value === "") continue;
			// A switch left as it falls back stays unset, so later global or default changes still apply.
			if (
				field.kind === "boolean" &&
				!Object.hasOwn(stored, field.id) &&
				value === (this.inherited(field.id) ?? false)
			) {
				continue;
			}
			Object.defineProperty(settings, field.id, { value, enumerable: true, configurable: true, writable: true });
		}
		const scope = this.scope;
		this.saving = true;
		this.status = { text: "Saving…", token: "muted" };
		this.options.requestRender();
		try {
			await this.source.save(scope, settings);
			await this.reload({ text: `Saved ${scope} settings`, token: "success" });
		} catch (error) {
			this.status = { text: error instanceof Error ? error.message : String(error), token: "error" };
			this.options.requestRender();
		} finally {
			this.saving = false;
		}
	}

	handleInput(data: string): void {
		if (this.form) {
			this.form.handleInput(data);
			return;
		}
		this.options.onClose();
	}

	invalidate(): void {
		this.form?.invalidate();
		this.border.invalidate();
	}

	private headerLines(width: number): string[] {
		const detail = this.detail;
		const wrap = (text: string): string[] => wrapTextWithAnsi(text, Math.max(1, width - 1)).map((line) => ` ${line}`);
		const lines = [
			truncateToWidth(
				` ${theme.fg("accent", theme.bold(sanitizeText(detail.displayName)))} ${theme.fg(
					"muted",
					`${detail.id} · ${sanitizeText(detail.version)} · ${detail.scope}`,
				)}`,
				width,
				"…",
			),
		];
		if (detail.description) lines.push(...wrap(theme.fg("muted", sanitizeText(detail.description))));
		if (detail.permissions.length === 0) {
			lines.push(...wrap(theme.fg("muted", "Permissions: none")));
		} else {
			const state = detail.permissionsAcknowledged
				? theme.fg("success", "acknowledged")
				: theme.fg("warning", "not acknowledged");
			lines.push(...wrap(`Permissions (${state}${theme.fg("text", ")")}`));
			for (const permission of describePermissions(detail.permissions)) {
				lines.push(...wrap(theme.fg("muted", `  ${permission}`)));
			}
		}
		return lines;
	}

	render(width: number): RenderFrame {
		const frames: RenderFrame[] = [this.border.render(width), createRenderFrame(this.headerLines(width))];
		frames.push(createRenderFrame([""]));
		if (this.form) {
			frames.push(this.form.render(width));
		} else if (this.view !== undefined) {
			frames.push(createRenderFrame([` ${theme.fg("muted", "This extension declares no settings.")}`]));
		}
		if (this.status) {
			const style = this.status.token === "muted" ? "muted" : this.status.token === "success" ? "success" : "error";
			frames.push(
				createRenderFrame([
					"",
					...wrapTextWithAnsi(theme.fg(style, sanitizeText(this.status.text)), Math.max(1, width - 1)).map(
						(line) => ` ${line}`,
					),
				]),
			);
		}
		const hints = this.form
			? `${keyHint("tui.focus.next", "next field")}  ${keyHint("tui.select.confirm", "save")}  ${keyHint("tui.select.cancel", "close")}`
			: keyHint("tui.select.cancel", "close");
		frames.push(createRenderFrame(["", truncateToWidth(` ${hints}`, width, "")]), this.border.render(width));
		return concatRenderFrames(frames);
	}
}
