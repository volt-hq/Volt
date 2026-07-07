/**
 * Submit-time scanning of prompt text for image file paths.
 *
 * Interactive mode attaches images referenced by path in the submitted prompt:
 * clipboard paste inserts a temp-file path, the editor's autocomplete inserts
 * `@`-mentions, and users hand-type paths. The path text stays in the message;
 * matched images ride alongside as attachments. Callers gate on the current
 * model's image support — for text-only models the paths stay plain text and
 * the vision-capable `read` tool remains the fallback.
 */

import { readFile, stat } from "node:fs/promises";
import type { Api, ImageContent, Model } from "@earendil-works/volt-ai";
import { resolveReadPathAsync } from "../../core/tools/path-utils.ts";
import { resizeImage } from "../../utils/image-resize.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";

export const MAX_PROMPT_IMAGE_ATTACHMENTS = 10;

const IMAGE_EXTENSION_PATTERN = /\.(png|jpe?g|gif|webp)$/i;

export interface PromptImageAttachments {
	images: ImageContent[];
	/** Absolute paths of attached images, in prompt order. */
	attachedPaths: string[];
	/** Image paths dropped because the attachment cap was reached. */
	cappedPaths: string[];
	/** Image paths that could not be loaded or resized under the size limit. */
	failedPaths: string[];
}

/**
 * Extract candidate path tokens from prompt text: double- or single-quoted
 * segments (with optional `@` prefix, as inserted by autocomplete for paths
 * containing spaces) and whitespace-separated bare tokens.
 */
export function extractPathTokens(text: string): string[] {
	const tokens: string[] = [];
	let i = 0;
	while (i < text.length) {
		if (/\s/.test(text[i])) {
			i++;
			continue;
		}
		const start = i;
		if (text[i] === "@") {
			i++;
		}
		const quote = text[i] === '"' || text[i] === "'" ? text[i] : undefined;
		if (quote) {
			const end = text.indexOf(quote, i + 1);
			if (end !== -1) {
				tokens.push(text.slice(i + 1, end));
				i = end + 1;
				continue;
			}
		}
		let j = i;
		while (j < text.length && !/\s/.test(text[j])) {
			j++;
		}
		// Strip the @ prefix from bare tokens; resolveToCwd also strips it, but
		// keeping tokens clean makes the path-likeness check below reliable.
		const token = text.slice(start === i ? start : start + 1, j);
		if (token) {
			tokens.push(token);
		}
		i = j;
	}
	return tokens;
}

/**
 * Whether a token is worth a filesystem check: path-shaped or carrying a
 * supported image extension. Keeps the scanner from stat'ing every word of
 * prose while still catching relative names like `screenshot.png`.
 */
function isPathLikeToken(token: string): boolean {
	return (
		IMAGE_EXTENSION_PATTERN.test(token) ||
		token.startsWith("/") ||
		token.startsWith("~") ||
		token.startsWith("./") ||
		token.startsWith("../")
	);
}

/**
 * Scan prompt text for existing image files and load them as attachments,
 * resized through the shared image pipeline. Returns null when the model does
 * not accept images (leave the paths as plain text) or when nothing matched.
 */
export async function collectPromptImageAttachments(
	text: string,
	cwd: string,
	model: Pick<Model<Api>, "input"> | undefined | null,
): Promise<PromptImageAttachments | null> {
	if (!model?.input.includes("image")) {
		return null;
	}

	const seen = new Set<string>();
	const result: PromptImageAttachments = { images: [], attachedPaths: [], cappedPaths: [], failedPaths: [] };

	for (const token of extractPathTokens(text)) {
		if (!isPathLikeToken(token)) {
			continue;
		}
		const resolved = await resolveReadPathAsync(token, cwd);
		if (seen.has(resolved)) {
			continue;
		}
		seen.add(resolved);

		const stats = await stat(resolved).catch(() => null);
		if (!stats?.isFile() || stats.size === 0) {
			continue;
		}
		const mimeType = await detectSupportedImageMimeTypeFromFile(resolved).catch(() => null);
		if (!mimeType) {
			continue;
		}

		if (result.images.length >= MAX_PROMPT_IMAGE_ATTACHMENTS) {
			result.cappedPaths.push(resolved);
			continue;
		}

		try {
			const content = await readFile(resolved);
			const resized = await resizeImage(content, mimeType);
			if (!resized) {
				result.failedPaths.push(resolved);
				continue;
			}
			result.images.push({ type: "image", mimeType: resized.mimeType, data: resized.data });
			result.attachedPaths.push(resolved);
		} catch {
			result.failedPaths.push(resolved);
		}
	}

	if (result.images.length === 0 && result.failedPaths.length === 0) {
		return null;
	}
	return result;
}
