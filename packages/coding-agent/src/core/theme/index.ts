export {
	detectTerminalBackgroundFromEnv,
	detectTerminalBackgroundTheme,
	getAvailableThemesWithPaths,
	getDefaultTheme,
	getResolvedThemeColors,
	getThemeExportColors,
	getThemeForRgbColor,
	isLightTheme,
	loadTheme,
	loadThemeFromPath,
	loadThemeJson,
	type TerminalBackgroundThemeDetectionOptions,
	type TerminalBackgroundThemeDetector,
	type TerminalThemeDetectionOptions,
	type ThemeDiscoveryDirs,
} from "./discovery.ts";
export {
	createThemeFromJson,
	getDefaultColorMode,
	parseThemeJson,
	parseThemeJsonContent,
	THEME_BG_COLOR_KEYS,
	Theme,
	type ThemeJson,
	ThemeJsonSchema,
} from "./theme.ts";
export {
	createThemeService,
	type ThemeService,
	type ThemeServiceOptions,
	type ThemeSetResult,
} from "./theme-service.ts";
export {
	ansi256ToHex,
	bgAnsi,
	fgAnsi,
	hexTo256,
	hexToRgb,
	resolveThemeColors,
	resolveVarRefs,
	rgbTo256,
} from "./tokens.ts";
export type {
	ColorMode,
	ResolvedThemeTokens,
	TerminalTheme,
	TerminalThemeDetection,
	ThemeBg,
	ThemeColor,
	ThemeColorValue,
	ThemeInfo,
	ThemeName,
} from "./types.ts";
