import * as fs from "node:fs";
import * as path from "node:path";
import { getCustomThemesDir, getThemesDir } from "../../config.ts";
import { closeWatcher, watchWithErrorHandler } from "../../utils/fs-watch.ts";
import {
	getAvailableThemesWithPaths,
	getDefaultTheme,
	getResolvedThemeColors,
	loadTheme,
	loadThemeFromPath,
	type ThemeDiscoveryDirs,
} from "./discovery.ts";
import { Theme } from "./theme.ts";
import { ansi256ToHex } from "./tokens.ts";
import type { ColorMode, ResolvedThemeTokens, ThemeInfo } from "./types.ts";

export interface ThemeServiceOptions {
	/** Overrides the built-in and custom theme directories (tests). */
	dirs?: ThemeDiscoveryDirs;
	/** Initial theme name; defaults to terminal background detection (dark on failure). */
	initialTheme?: string;
	/** Force a color mode instead of detecting terminal capabilities. */
	colorMode?: ColorMode;
	/** Called after a successful setTheme with the resolved theme name (persistence hook). */
	onPersist?: (name: string) => void | Promise<void>;
}

export interface ThemeSetResult {
	success: boolean;
	error?: string;
}

export interface ThemeService {
	/** Resolved active theme. */
	readonly current: Theme;
	/** Name the active theme was loaded under ("<in-memory>" for direct instances). */
	readonly currentThemeName: string | undefined;
	getAllThemes(): Theme[];
	getAvailableThemeInfos(): ThemeInfo[];
	getTheme(name: string): Theme | undefined;
	setTheme(theme: string | Theme): Promise<ThemeSetResult>;
	/** Flat CSS-hex token map for snapshots; defaults to the active theme. */
	resolveTokens(theme?: Theme): ResolvedThemeTokens;
	/** Themes registered by extensions/resource loading; they shadow custom-dir themes. */
	setRegisteredThemes(themes: Theme[]): void;
	subscribe(cb: (theme: Theme) => void): () => void;
	/** Hot-reload fs watcher for custom theme files — enabled ONLY by the rendering (TUI) process. */
	enableHotReload(): void;
	dispose(): void;
}

class ThemeServiceImpl implements ThemeService {
	private readonly dirs: { themesDir: string; customThemesDir: string };
	private readonly colorMode: ColorMode | undefined;
	private readonly onPersist: ((name: string) => void | Promise<void>) | undefined;
	private readonly registeredThemes = new Map<string, Theme>();
	private readonly subscribers = new Set<(theme: Theme) => void>();
	private currentTheme: Theme;
	private currentName: string | undefined;
	private hotReloadEnabled = false;
	private watcher: fs.FSWatcher | undefined;
	private reloadTimer: NodeJS.Timeout | undefined;
	private disposed = false;

	constructor(options: ThemeServiceOptions) {
		this.dirs = {
			themesDir: options.dirs?.themesDir ?? getThemesDir(),
			customThemesDir: options.dirs?.customThemesDir ?? getCustomThemesDir(),
		};
		this.colorMode = options.colorMode;
		this.onPersist = options.onPersist;
		const name = options.initialTheme ?? getDefaultTheme();
		this.currentName = name;
		try {
			this.currentTheme = this.load(name);
		} catch {
			// Theme is invalid - fall back to dark theme silently
			this.currentName = "dark";
			this.currentTheme = this.load("dark");
		}
	}

	get current(): Theme {
		return this.currentTheme;
	}

	get currentThemeName(): string | undefined {
		return this.currentName;
	}

	private load(name: string): Theme {
		return loadTheme(name, this.colorMode, this.registeredThemes, this.dirs);
	}

	getAvailableThemeInfos(): ThemeInfo[] {
		return getAvailableThemesWithPaths(this.registeredThemes, this.dirs);
	}

	getAllThemes(): Theme[] {
		const themes: Theme[] = [];
		for (const info of this.getAvailableThemeInfos()) {
			const theme = this.getTheme(info.name);
			if (theme) {
				themes.push(theme);
			}
		}
		return themes;
	}

	getTheme(name: string): Theme | undefined {
		try {
			return this.load(name);
		} catch {
			return undefined;
		}
	}

	async setTheme(theme: string | Theme): Promise<ThemeSetResult> {
		if (theme instanceof Theme) {
			this.currentTheme = theme;
			this.currentName = theme.name ?? "<in-memory>";
			this.stopWatcher(); // Can't watch a direct instance
			this.notify();
			return { success: true };
		}
		this.currentName = theme;
		try {
			this.currentTheme = this.load(theme);
			this.restartWatcherIfEnabled();
			this.notify();
			await this.onPersist?.(theme);
			return { success: true };
		} catch (error) {
			// Theme is invalid - fall back to dark theme
			this.currentName = "dark";
			this.currentTheme = this.load("dark");
			this.notify();
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	resolveTokens(theme?: Theme): ResolvedThemeTokens {
		const target = theme ?? this.currentTheme;
		const name = theme === undefined ? this.currentName : theme.name;
		if (name && name !== "<in-memory>") {
			try {
				return getResolvedThemeColors(name, this.registeredThemes, this.dirs);
			} catch {
				// Fall through to instance-derived tokens for themes without a loadable source.
			}
		}
		const defaultText = name === "light" ? "#000000" : "#e5e5e7";
		const tokens: ResolvedThemeTokens = {};
		for (const [key, value] of Object.entries(target.resolvedColors)) {
			if (typeof value === "number") {
				tokens[key] = ansi256ToHex(value);
			} else if (value === "") {
				tokens[key] = defaultText;
			} else {
				tokens[key] = value;
			}
		}
		return tokens;
	}

	setRegisteredThemes(themes: Theme[]): void {
		this.registeredThemes.clear();
		for (const theme of themes) {
			if (theme.name) {
				this.registeredThemes.set(theme.name, theme);
			}
		}
	}

	subscribe(cb: (theme: Theme) => void): () => void {
		this.subscribers.add(cb);
		return () => {
			this.subscribers.delete(cb);
		};
	}

	enableHotReload(): void {
		this.hotReloadEnabled = true;
		this.restartWatcherIfEnabled();
	}

	dispose(): void {
		this.disposed = true;
		this.stopWatcher();
		this.subscribers.clear();
	}

	private notify(): void {
		for (const cb of Array.from(this.subscribers)) {
			cb(this.currentTheme);
		}
	}

	private restartWatcherIfEnabled(): void {
		this.stopWatcher();
		if (!this.hotReloadEnabled || this.disposed) {
			return;
		}

		// Only watch custom themes (not built-in)
		const watchedThemeName = this.currentName;
		if (!watchedThemeName || watchedThemeName === "dark" || watchedThemeName === "light") {
			return;
		}

		const customThemesDir = this.dirs.customThemesDir;
		const watchedFileName = `${watchedThemeName}.json`;
		const themeFile = path.join(customThemesDir, watchedFileName);

		// Only watch if the file exists
		if (!fs.existsSync(themeFile)) {
			return;
		}

		const scheduleReload = () => {
			if (this.reloadTimer) {
				clearTimeout(this.reloadTimer);
			}
			this.reloadTimer = setTimeout(() => {
				this.reloadTimer = undefined;

				// Ignore stale timers after switching themes or stopping the watcher
				if (this.currentName !== watchedThemeName) {
					return;
				}

				// Keep the last successfully loaded theme active if the file is temporarily missing
				if (!fs.existsSync(themeFile)) {
					return;
				}

				try {
					// Reload the theme from disk and refresh the registry cache
					const reloadedTheme = loadThemeFromPath(themeFile, this.colorMode);
					this.registeredThemes.set(watchedThemeName, reloadedTheme);
					this.currentTheme = reloadedTheme;
					this.notify();
				} catch {
					// Ignore errors (file might be in invalid state while being edited)
				}
			}, 100);
		};

		this.watcher =
			watchWithErrorHandler(
				customThemesDir,
				(_eventType, filename) => {
					if (this.currentName !== watchedThemeName) {
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
					closeWatcher(this.watcher);
					this.watcher = undefined;
				},
			) ?? undefined;
	}

	private stopWatcher(): void {
		if (this.reloadTimer) {
			clearTimeout(this.reloadTimer);
			this.reloadTimer = undefined;
		}
		closeWatcher(this.watcher);
		this.watcher = undefined;
	}
}

export function createThemeService(options: ThemeServiceOptions = {}): ThemeService {
	return new ThemeServiceImpl(options);
}
