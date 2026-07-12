/**
 * Titlebar Spinner Extension
 *
 * Shows a braille spinner animation in the terminal title while the agent is working.
 * Uses `ctx.ui.setTitle()` to update the terminal title via the extension API.
 *
 * Usage:
 *   volt --extension examples/extensions/titlebar-spinner.ts
 */

import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@hansjm10/volt-coding-agent";

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function getBaseTitle(volt: ExtensionAPI): string {
	const cwd = path.basename(process.cwd());
	const session = volt.getSessionName();
	return session ? `Volt - ${session} - ${cwd}` : `Volt - ${cwd}`;
}

export default function (volt: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | null = null;
	let frameIndex = 0;

	function stopAnimation(ctx: ExtensionContext) {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		frameIndex = 0;
		ctx.ui.setTitle(getBaseTitle(volt));
	}

	function startAnimation(ctx: ExtensionContext) {
		stopAnimation(ctx);
		timer = setInterval(() => {
			const frame = BRAILLE_FRAMES[frameIndex % BRAILLE_FRAMES.length];
			const cwd = path.basename(process.cwd());
			const session = volt.getSessionName();
			const title = session ? `${frame} Volt - ${session} - ${cwd}` : `${frame} Volt - ${cwd}`;
			ctx.ui.setTitle(title);
			frameIndex++;
		}, 80);
	}

	volt.on("agent_start", async (_event, ctx) => {
		startAnimation(ctx);
	});

	volt.on("agent_end", async (_event, ctx) => {
		stopAnimation(ctx);
	});

	volt.on("session_shutdown", async (_event, ctx) => {
		stopAnimation(ctx);
	});
}
