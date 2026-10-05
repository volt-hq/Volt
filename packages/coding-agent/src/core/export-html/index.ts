import type { AgentTool } from "@hansjm10/volt-agent-core";
import type { ToolCall, ToolResultMessage } from "@hansjm10/volt-ai";
import { PRESENTATION_MAX_SERIALIZED_BYTES } from "@hansjm10/volt-protocol";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { APP_NAME, getExportTemplateDir } from "../../config.ts";
import { writeDurableAtomicFileSync } from "../../utils/durable-atomic-write.ts";
import { normalizePath, resolvePath } from "../../utils/paths.ts";
import { hardenPrivateRegularFileSync, PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE } from "../../utils/private-files.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { SessionEntry, SessionManager } from "../session-manager.ts";
import { assertCurrentSessionSnapshot, isHostOnlySessionEntry, loadEntriesFromFile } from "../session-manager.ts";
import { getResolvedThemeColors, getThemeExportColors } from "../theme/runtime.ts";
import { BUILTIN_PRESENTERS } from "../tools/presenters.ts";
import { type PresenterSet, presentCustomMessage, presentToolCall } from "../ui/presentation.ts";
import { messagePresentationHtml, type PresentedHtml, toolPresentationHtml } from "./ui-node-html.ts";

export interface ExportOptions {
	outputPath?: string;
	themeName?: string;
	/** The presenters tool calls and custom messages export with; the built-in tools' by default. */
	presenters?: PresenterSet;
}

/** Parse a color string to RGB values. Supports hex (#RRGGBB) and rgb(r,g,b) formats. */
function parseColor(color: string): { r: number; g: number; b: number } | undefined {
	const hexMatch = color.match(/^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
	if (hexMatch) {
		return {
			r: Number.parseInt(hexMatch[1], 16),
			g: Number.parseInt(hexMatch[2], 16),
			b: Number.parseInt(hexMatch[3], 16),
		};
	}
	const rgbMatch = color.match(/^rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
	if (rgbMatch) {
		return {
			r: Number.parseInt(rgbMatch[1], 10),
			g: Number.parseInt(rgbMatch[2], 10),
			b: Number.parseInt(rgbMatch[3], 10),
		};
	}
	return undefined;
}

/** Calculate relative luminance of a color (0-1, higher = lighter). */
function getLuminance(r: number, g: number, b: number): number {
	const toLinear = (c: number) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** Adjust color brightness. Factor > 1 lightens, < 1 darkens. */
function adjustBrightness(color: string, factor: number): string {
	const parsed = parseColor(color);
	if (!parsed) return color;
	const adjust = (c: number) => Math.min(255, Math.max(0, Math.round(c * factor)));
	return `rgb(${adjust(parsed.r)}, ${adjust(parsed.g)}, ${adjust(parsed.b)})`;
}

/** Derive export background colors from a base color (e.g., userMessageBg). */
function deriveExportColors(baseColor: string): { pageBg: string; cardBg: string; infoBg: string } {
	const parsed = parseColor(baseColor);
	if (!parsed) {
		return {
			pageBg: "rgb(24, 24, 30)",
			cardBg: "rgb(30, 30, 36)",
			infoBg: "rgb(60, 55, 40)",
		};
	}

	const luminance = getLuminance(parsed.r, parsed.g, parsed.b);
	const isLight = luminance > 0.5;

	if (isLight) {
		return {
			pageBg: adjustBrightness(baseColor, 0.96),
			cardBg: baseColor,
			infoBg: `rgb(${Math.min(255, parsed.r + 10)}, ${Math.min(255, parsed.g + 5)}, ${Math.max(0, parsed.b - 20)})`,
		};
	}
	return {
		pageBg: adjustBrightness(baseColor, 0.7),
		cardBg: adjustBrightness(baseColor, 0.85),
		infoBg: `rgb(${Math.min(255, parsed.r + 20)}, ${Math.min(255, parsed.g + 15)}, ${parsed.b})`,
	};
}

/**
 * Generate CSS custom property declarations from theme colors.
 */
function generateThemeVars(themeName?: string): string {
	const colors = getResolvedThemeColors(themeName);
	const lines: string[] = [];
	for (const [key, value] of Object.entries(colors)) {
		lines.push(`--${key}: ${value};`);
	}

	// Use explicit theme export colors if available, otherwise derive from userMessageBg
	const themeExport = getThemeExportColors(themeName);
	const userMessageBg = colors.userMessageBg || "#343541";
	const derivedColors = deriveExportColors(userMessageBg);

	lines.push(`--exportPageBg: ${themeExport.pageBg ?? derivedColors.pageBg};`);
	lines.push(`--exportCardBg: ${themeExport.cardBg ?? derivedColors.cardBg};`);
	lines.push(`--exportInfoBg: ${themeExport.infoBg ?? derivedColors.infoBg};`);

	return lines.join("\n      ");
}

interface SessionData {
	header: ReturnType<SessionManager["getHeader"]>;
	entries: ReturnType<SessionManager["getEntries"]>;
	leafId: string | null;
	systemPrompt?: string;
	tools?: Array<Pick<ToolDefinition, "name" | "description" | "parameters">>;
	/** The presentations of the tool calls, as HTML, by tool call id; `null` for a call its presentation hides. */
	presentedTools?: Record<string, PresentedHtml | null>;
	/** The presentations of custom messages whose types have presenters, as HTML, by entry id. */
	presentedMessages?: Record<string, PresentedHtml>;
}

/**
 * Core HTML generation logic shared by both export functions.
 */
function generateHtml(sessionData: SessionData, themeName?: string): string {
	const templateDir = getExportTemplateDir();
	const template = readFileSync(join(templateDir, "template.html"), "utf-8");
	const templateCss = readFileSync(join(templateDir, "template.css"), "utf-8");
	const templateJs = readFileSync(join(templateDir, "template.js"), "utf-8");
	const markedJs = readFileSync(join(templateDir, "vendor", "marked.min.js"), "utf-8");
	const hljsJs = readFileSync(join(templateDir, "vendor", "highlight.min.js"), "utf-8");

	const themeVars = generateThemeVars(themeName);
	const colors = getResolvedThemeColors(themeName);
	const themeExport = getThemeExportColors(themeName);
	const derivedExportColors = deriveExportColors(colors.userMessageBg || "#343541");
	const bodyBg = themeExport.pageBg ?? derivedExportColors.pageBg;
	const containerBg = themeExport.cardBg ?? derivedExportColors.cardBg;
	const infoBg = themeExport.infoBg ?? derivedExportColors.infoBg;

	// Base64 encode session data to avoid escaping issues
	const sessionDataBase64 = Buffer.from(JSON.stringify(sessionData)).toString("base64");

	// Build the CSS with theme variables injected
	const css = templateCss
		.replace("{{THEME_VARS}}", themeVars)
		.replace("{{BODY_BG}}", bodyBg)
		.replace("{{CONTAINER_BG}}", containerBg)
		.replace("{{INFO_BG}}", infoBg);

	return template
		.replace("{{CSS}}", css)
		.replace("{{JS}}", templateJs)
		.replace("{{SESSION_DATA}}", sessionDataBase64)
		.replace("{{MARKED_JS}}", markedJs)
		.replace("{{HIGHLIGHT_JS}}", hljsJs);
}

/**
 * The presentations of the tool calls and custom messages of `entries`, as
 * HTML: every tool call (with its tool's presenter, or generically), and the
 * custom messages whose types have presenters. A call presents with its
 * result, or as pending.
 */
export function presentSessionEntries(
	entries: readonly SessionEntry[],
	presenters: PresenterSet,
	cwd: string,
): Pick<SessionData, "presentedTools" | "presentedMessages"> {
	const results = new Map<string, ToolResultMessage>();
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "toolResult") {
			results.set(entry.message.toolCallId, entry.message);
		}
	}
	const presentedTools: Record<string, PresentedHtml | null> = {};
	const presentedMessages: Record<string, PresentedHtml> = {};
	for (const entry of entries) {
		if (entry.type === "custom_message" && entry.display) {
			const presentation = presentCustomMessage(
				presenters.message(entry.customType),
				{
					customType: entry.customType,
					content: entry.content,
					...(entry.details === undefined ? {} : { details: entry.details }),
				},
				PRESENTATION_MAX_SERIALIZED_BYTES,
			);
			if (presentation) presentedMessages[entry.id] = messagePresentationHtml(presentation);
			continue;
		}
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		for (const block of entry.message.content) {
			if (block.type !== "toolCall") continue;
			const call: ToolCall = block;
			const result = results.get(call.id);
			const presentation = presentToolCall(
				presenters.tool(call.name),
				call.name,
				{
					args: call.arguments,
					argsComplete: true,
					state: result === undefined ? "pending" : "done",
					...(result === undefined
						? {}
						: {
								result: {
									content: result.content,
									...(result.details === undefined ? {} : { details: result.details }),
									isError: result.isError,
									partial: false,
								},
							}),
					cwd,
				},
				PRESENTATION_MAX_SERIALIZED_BYTES,
			);
			presentedTools[call.id] = toolPresentationHtml(presentation) ?? null;
		}
	}
	return {
		...(Object.keys(presentedTools).length === 0 ? {} : { presentedTools }),
		...(Object.keys(presentedMessages).length === 0 ? {} : { presentedMessages }),
	};
}

/**
 * Export session to HTML using SessionManager and the runtime fields needed for rendering.
 * Used by TUI's /export command.
 */
export async function exportSessionToHtml(
	sm: SessionManager,
	state?: { readonly systemPrompt: string; readonly tools: readonly AgentTool[] },
	options?: ExportOptions | string,
): Promise<string> {
	const opts: ExportOptions = typeof options === "string" ? { outputPath: options } : options || {};

	const sessionRef = sm.getSessionRef();
	if (!sm.isPersisted() || !sessionRef) {
		throw new Error("Cannot export in-memory session to HTML");
	}

	const entries = sm.getEntries();

	const sessionData: SessionData = {
		header: sm.getHeader(),
		entries,
		leafId: sm.getLeafId(),
		systemPrompt: state?.systemPrompt,
		tools: state?.tools?.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
		...presentSessionEntries(entries, opts.presenters ?? BUILTIN_PRESENTERS, sm.getCwd()),
	};

	const html = generateHtml(sessionData, opts.themeName);

	let outputPath = opts.outputPath ? normalizePath(opts.outputPath) : undefined;
	if (!outputPath) {
		outputPath = `${APP_NAME}-session-${sessionRef.sessionId}.html`;
	}

	writeDurableAtomicFileSync(outputPath, html, {
		directoryMode: PRIVATE_DIRECTORY_MODE,
		fileMode: PRIVATE_FILE_MODE,
	});
	return outputPath;
}

/**
 * Export session file to HTML (standalone, without AgentState).
 * Used by CLI for exporting arbitrary session files.
 */
export async function exportFromFile(inputPath: string, options?: ExportOptions | string): Promise<string> {
	const opts: ExportOptions = typeof options === "string" ? { outputPath: options } : options || {};
	const resolvedInputPath = resolvePath(inputPath);

	if (!existsSync(resolvedInputPath)) {
		throw new Error(`File not found: ${resolvedInputPath}`);
	}

	hardenPrivateRegularFileSync(resolvedInputPath);
	const fileEntries = loadEntriesFromFile(resolvedInputPath);
	if (fileEntries.length === 0) {
		throw new Error(`Session file has no valid session header: ${resolvedInputPath}`);
	}
	const header = assertCurrentSessionSnapshot(fileEntries);
	const entries: SessionEntry[] = [];
	let leafId: string | null = null;
	for (const entry of fileEntries) {
		if (entry.type === "session") continue;
		if (entry.type === "leaf") {
			leafId = entry.targetId;
		} else if (!isHostOnlySessionEntry(entry)) {
			entries.push(entry);
			leafId = entry.id;
		}
	}

	const sessionData: SessionData = {
		header,
		entries,
		leafId,
		systemPrompt: undefined,
		tools: undefined,
		...presentSessionEntries(entries, opts.presenters ?? BUILTIN_PRESENTERS, header.cwd),
	};

	const html = generateHtml(sessionData, opts.themeName);

	let outputPath = opts.outputPath ? normalizePath(opts.outputPath) : undefined;
	if (!outputPath) {
		outputPath = `${APP_NAME}-session-${header.id}.html`;
	}

	writeDurableAtomicFileSync(outputPath, html, {
		directoryMode: PRIVATE_DIRECTORY_MODE,
		fileMode: PRIVATE_FILE_MODE,
	});
	return outputPath;
}
