import * as fs from "node:fs";
import * as path from "node:path";
import type { EditorTheme, MarkdownTheme, SelectListTheme, SettingsListTheme } from "@earendil-works/volt-tui";
import chalk from "chalk";
import { getCustomThemesDir } from "../../../config.ts";
import {
	getAvailableThemesWithPaths as coreGetAvailableThemesWithPaths,
	getResolvedThemeColors as coreGetResolvedThemeColors,
	getThemeExportColors as coreGetThemeExportColors,
	loadTheme,
	loadThemeFromPath,
} from "../../../core/theme/discovery.ts";
import type { Theme } from "../../../core/theme/theme.ts";
import type { ThemeInfo } from "../../../core/theme/types.ts";
import { closeWatcher, watchWithErrorHandler } from "../../../utils/fs-watch.ts";
import { highlight, supportsLanguage } from "../../../utils/syntax-highlight.ts";

export {
	detectTerminalBackgroundFromEnv,
	detectTerminalBackgroundTheme,
	getDefaultTheme,
	getThemeForRgbColor,
	loadThemeFromPath,
	type TerminalBackgroundThemeDetectionOptions,
	type TerminalBackgroundThemeDetector,
	type TerminalThemeDetectionOptions,
} from "../../../core/theme/discovery.ts";
export { Theme } from "../../../core/theme/theme.ts";
export type {
	TerminalTheme,
	TerminalThemeDetection,
	ThemeBg,
	ThemeColor,
	ThemeInfo,
} from "../../../core/theme/types.ts";

import { getDefaultTheme } from "../../../core/theme/discovery.ts";

// ============================================================================
// Theme Discovery (module-level registry view)
// ============================================================================

export function getAvailableThemes(): string[] {
	return getAvailableThemesWithPaths().map(({ name }) => name);
}

export function getAvailableThemesWithPaths(): ThemeInfo[] {
	return coreGetAvailableThemesWithPaths(registeredThemes);
}

export function getThemeByName(name: string): Theme | undefined {
	try {
		return loadTheme(name, undefined, registeredThemes);
	} catch {
		return undefined;
	}
}

// ============================================================================
// Global Theme Instance
// ============================================================================

// Use globalThis to share theme across module loaders (tsx + jiti in dev mode)
const THEME_KEY = Symbol.for("@earendil-works/volt-coding-agent:theme");
const THEME_KEY_OLD = Symbol.for("@earendil-works/volt-coding-agent:theme");

// Export theme as a getter that reads from globalThis
// This ensures all module instances (tsx, jiti) see the same theme
export const theme: Theme = new Proxy({} as Theme, {
	get(_target, prop) {
		const t = (globalThis as Record<symbol, Theme>)[THEME_KEY];
		if (!t) throw new Error("Theme not initialized. Call initTheme() first.");
		return (t as unknown as Record<string | symbol, unknown>)[prop];
	},
});

function setGlobalTheme(t: Theme): void {
	(globalThis as Record<symbol, Theme>)[THEME_KEY] = t;
	(globalThis as Record<symbol, Theme>)[THEME_KEY_OLD] = t;
}

let currentThemeName: string | undefined;
let themeWatcher: fs.FSWatcher | undefined;
let themeReloadTimer: NodeJS.Timeout | undefined;
let onThemeChangeCallback: (() => void) | undefined;
const registeredThemes = new Map<string, Theme>();

export function setRegisteredThemes(themes: Theme[]): void {
	registeredThemes.clear();
	for (const theme of themes) {
		if (theme.name) {
			registeredThemes.set(theme.name, theme);
		}
	}
}

export function initTheme(themeName?: string, enableWatcher: boolean = false): void {
	const name = themeName ?? getDefaultTheme();
	currentThemeName = name;
	try {
		setGlobalTheme(loadTheme(name, undefined, registeredThemes));
		if (enableWatcher) {
			startThemeWatcher();
		}
	} catch (_error) {
		// Theme is invalid - fall back to dark theme silently
		currentThemeName = "dark";
		setGlobalTheme(loadTheme("dark", undefined, registeredThemes));
		// Don't start watcher for fallback theme
	}
}

export function setTheme(name: string, enableWatcher: boolean = false): { success: boolean; error?: string } {
	currentThemeName = name;
	try {
		setGlobalTheme(loadTheme(name, undefined, registeredThemes));
		if (enableWatcher) {
			startThemeWatcher();
		}
		if (onThemeChangeCallback) {
			onThemeChangeCallback();
		}
		return { success: true };
	} catch (error) {
		// Theme is invalid - fall back to dark theme
		currentThemeName = "dark";
		setGlobalTheme(loadTheme("dark", undefined, registeredThemes));
		// Don't start watcher for fallback theme
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function setThemeInstance(themeInstance: Theme): void {
	setGlobalTheme(themeInstance);
	currentThemeName = "<in-memory>";
	stopThemeWatcher(); // Can't watch a direct instance
	if (onThemeChangeCallback) {
		onThemeChangeCallback();
	}
}

export function onThemeChange(callback: () => void): void {
	onThemeChangeCallback = callback;
}

function startThemeWatcher(): void {
	stopThemeWatcher();

	// Only watch if it's a custom theme (not built-in)
	if (!currentThemeName || currentThemeName === "dark" || currentThemeName === "light") {
		return;
	}

	const customThemesDir = getCustomThemesDir();
	const watchedThemeName = currentThemeName;
	const watchedFileName = `${watchedThemeName}.json`;
	const themeFile = path.join(customThemesDir, watchedFileName);

	// Only watch if the file exists
	if (!fs.existsSync(themeFile)) {
		return;
	}

	const scheduleReload = () => {
		if (themeReloadTimer) {
			clearTimeout(themeReloadTimer);
		}
		themeReloadTimer = setTimeout(() => {
			themeReloadTimer = undefined;

			// Ignore stale timers after switching themes or stopping the watcher
			if (currentThemeName !== watchedThemeName) {
				return;
			}

			// Keep the last successfully loaded theme active if the file is temporarily missing
			if (!fs.existsSync(themeFile)) {
				return;
			}

			try {
				// Reload the theme from disk and refresh the registry cache
				const reloadedTheme = loadThemeFromPath(themeFile);
				registeredThemes.set(watchedThemeName, reloadedTheme);
				setGlobalTheme(reloadedTheme);
				// Notify callback (to invalidate UI)
				if (onThemeChangeCallback) {
					onThemeChangeCallback();
				}
			} catch (_error) {
				// Ignore errors (file might be in invalid state while being edited)
			}
		}, 100);
	};

	themeWatcher =
		watchWithErrorHandler(
			customThemesDir,
			(_eventType, filename) => {
				if (currentThemeName !== watchedThemeName) {
					return;
				}
				if (!filename) {
					scheduleReload();
					return;
				}
				if (filename !== watchedFileName) {
					return;
				}
				scheduleReload();
			},
			() => {
				closeWatcher(themeWatcher);
				themeWatcher = undefined;
			},
		) ?? undefined;
}

export function stopThemeWatcher(): void {
	if (themeReloadTimer) {
		clearTimeout(themeReloadTimer);
		themeReloadTimer = undefined;
	}
	closeWatcher(themeWatcher);
	themeWatcher = undefined;
}

// ============================================================================
// HTML Export Helpers
// ============================================================================

/**
 * Get resolved theme colors as CSS-compatible hex strings.
 * Used by HTML export to generate CSS custom properties.
 */
export function getResolvedThemeColors(themeName?: string): Record<string, string> {
	const name = themeName ?? currentThemeName ?? getDefaultTheme();
	return coreGetResolvedThemeColors(name, registeredThemes);
}

/**
 * Check if a theme is a "light" theme (for CSS that needs light/dark variants).
 */
export function isLightTheme(themeName?: string): boolean {
	// Currently just check the name - could be extended to analyze colors
	return themeName === "light";
}

/**
 * Get explicit export colors from theme JSON, if specified.
 * Returns undefined for each color that isn't explicitly set.
 */
export function getThemeExportColors(themeName?: string): {
	pageBg?: string;
	cardBg?: string;
	infoBg?: string;
} {
	const name = themeName ?? currentThemeName ?? getDefaultTheme();
	return coreGetThemeExportColors(name, registeredThemes);
}

// ============================================================================
// TUI Helpers
// ============================================================================

type CliHighlightTheme = Record<string, (s: string) => string>;

let cachedHighlightThemeFor: Theme | undefined;
let cachedCliHighlightTheme: CliHighlightTheme | undefined;

function buildCliHighlightTheme(t: Theme): CliHighlightTheme {
	return {
		keyword: (s: string) => t.fg("syntaxKeyword", s),
		built_in: (s: string) => t.fg("syntaxType", s),
		literal: (s: string) => t.fg("syntaxNumber", s),
		number: (s: string) => t.fg("syntaxNumber", s),
		regexp: (s: string) => t.fg("syntaxString", s),
		string: (s: string) => t.fg("syntaxString", s),
		comment: (s: string) => t.fg("syntaxComment", s),
		doctag: (s: string) => t.fg("syntaxComment", s),
		meta: (s: string) => t.fg("muted", s),
		function: (s: string) => t.fg("syntaxFunction", s),
		title: (s: string) => t.fg("syntaxFunction", s),
		class: (s: string) => t.fg("syntaxType", s),
		type: (s: string) => t.fg("syntaxType", s),
		tag: (s: string) => t.fg("syntaxPunctuation", s),
		name: (s: string) => t.fg("syntaxKeyword", s),
		attr: (s: string) => t.fg("syntaxVariable", s),
		variable: (s: string) => t.fg("syntaxVariable", s),
		params: (s: string) => t.fg("syntaxVariable", s),
		operator: (s: string) => t.fg("syntaxOperator", s),
		punctuation: (s: string) => t.fg("syntaxPunctuation", s),
		emphasis: (s: string) => t.italic(s),
		strong: (s: string) => t.bold(s),
		link: (s: string) => t.underline(s),
		addition: (s: string) => t.fg("toolDiffAdded", s),
		deletion: (s: string) => t.fg("toolDiffRemoved", s),
	};
}

function getCliHighlightTheme(t: Theme): CliHighlightTheme {
	if (cachedHighlightThemeFor !== t || !cachedCliHighlightTheme) {
		cachedHighlightThemeFor = t;
		cachedCliHighlightTheme = buildCliHighlightTheme(t);
	}
	return cachedCliHighlightTheme;
}

/**
 * Highlight code with syntax coloring based on file extension or language.
 * Returns array of highlighted lines.
 */
export function highlightCode(code: string, lang?: string): string[] {
	// Validate language before highlighting to avoid stderr spam from cli-highlight
	const validLang = lang && supportsLanguage(lang) ? lang : undefined;
	// Skip highlighting when no valid language is specified. cli-highlight's
	// auto-detection is unreliable and can misidentify prose as AppleScript,
	// LiveCodeServer, etc., coloring random English words as keywords.
	if (!validLang) {
		return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
	}
	const opts = {
		language: validLang,
		ignoreIllegals: true,
		theme: getCliHighlightTheme(theme),
	};
	try {
		return highlight(code, opts).split("\n");
	} catch {
		return code.split("\n");
	}
}

/**
 * Get language identifier from file path extension.
 */
export function getLanguageFromPath(filePath: string): string | undefined {
	const ext = filePath.split(".").pop()?.toLowerCase();
	if (!ext) return undefined;

	const extToLang: Record<string, string> = {
		ts: "typescript",
		tsx: "typescript",
		js: "javascript",
		jsx: "javascript",
		mjs: "javascript",
		cjs: "javascript",
		py: "python",
		rb: "ruby",
		rs: "rust",
		go: "go",
		java: "java",
		kt: "kotlin",
		swift: "swift",
		c: "c",
		h: "c",
		cpp: "cpp",
		cc: "cpp",
		cxx: "cpp",
		hpp: "cpp",
		cs: "csharp",
		php: "php",
		sh: "bash",
		bash: "bash",
		zsh: "bash",
		fish: "fish",
		ps1: "powershell",
		sql: "sql",
		html: "html",
		htm: "html",
		css: "css",
		scss: "scss",
		sass: "sass",
		less: "less",
		json: "json",
		yaml: "yaml",
		yml: "yaml",
		toml: "toml",
		xml: "xml",
		md: "markdown",
		markdown: "markdown",
		dockerfile: "dockerfile",
		makefile: "makefile",
		cmake: "cmake",
		lua: "lua",
		perl: "perl",
		r: "r",
		scala: "scala",
		clj: "clojure",
		ex: "elixir",
		exs: "elixir",
		erl: "erlang",
		hs: "haskell",
		ml: "ocaml",
		vim: "vim",
		graphql: "graphql",
		proto: "protobuf",
		tf: "hcl",
		hcl: "hcl",
	};

	return extToLang[ext];
}

export function getMarkdownTheme(): MarkdownTheme {
	return {
		heading: (text: string) => theme.fg("mdHeading", text),
		link: (text: string) => theme.fg("mdLink", text),
		linkUrl: (text: string) => theme.fg("mdLinkUrl", text),
		code: (text: string) => theme.fg("mdCode", text),
		codeBlock: (text: string) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text: string) => theme.fg("mdCodeBlockBorder", text),
		quote: (text: string) => theme.fg("mdQuote", text),
		quoteBorder: (text: string) => theme.fg("mdQuoteBorder", text),
		hr: (text: string) => theme.fg("mdHr", text),
		listBullet: (text: string) => theme.fg("mdListBullet", text),
		bold: (text: string) => theme.bold(text),
		italic: (text: string) => theme.italic(text),
		underline: (text: string) => theme.underline(text),
		strikethrough: (text: string) => chalk.strikethrough(text),
		highlightCode: (code: string, lang?: string): string[] => {
			// Validate language before highlighting to avoid stderr spam from cli-highlight
			const validLang = lang && supportsLanguage(lang) ? lang : undefined;
			// Skip highlighting when no valid language is specified. cli-highlight's
			// auto-detection is unreliable and can misidentify prose as AppleScript,
			// LiveCodeServer, etc., coloring random English words as keywords.
			if (!validLang) {
				return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
			}
			const opts = {
				language: validLang,
				ignoreIllegals: true,
				theme: getCliHighlightTheme(theme),
			};
			try {
				return highlight(code, opts).split("\n");
			} catch {
				return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
			}
		},
	};
}

export function getSelectListTheme(): SelectListTheme {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("muted", text),
		noMatch: (text: string) => theme.fg("muted", text),
	};
}

export function getEditorTheme(): EditorTheme {
	return {
		borderColor: (text: string) => theme.fg("borderMuted", text),
		selectList: getSelectListTheme(),
	};
}

export function getSettingsListTheme(): SettingsListTheme {
	return {
		label: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : text),
		value: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
		description: (text: string) => theme.fg("dim", text),
		cursor: theme.fg("accent", "→ "),
		hint: (text: string) => theme.fg("dim", text),
	};
}
