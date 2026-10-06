/**
 * A single-line input for a secret such as an API key: it edits like any
 * input, but shows a bullet for each character typed, never the text.
 */

import { CURSOR_MARKER, createRenderFrame, Input, type RenderFrame } from "@hansjm10/volt-tui";

const BULLET = "•";

export class SecretInput extends Input {
	override render(width: number): RenderFrame {
		const prompt = "> ";
		const available = width - prompt.length;
		if (available <= 0) return createRenderFrame([prompt]);
		// One column stays free for the cursor at the end.
		const bullets = BULLET.repeat(Math.min([...this.getValue()].length, Math.max(0, available - 1)));
		const marker = this.focused ? CURSOR_MARKER : "";
		const line = `${prompt}${bullets}${marker}\x1b[7m \x1b[27m`;
		return createRenderFrame([`${line}${" ".repeat(Math.max(0, available - bullets.length - 1))}`]);
	}
}
