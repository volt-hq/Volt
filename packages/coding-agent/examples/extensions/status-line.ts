/**
 * Status Line Extension
 *
 * Demonstrates ctx.ui.setStatus() for displaying persistent status text in the footer.
 * Shows turn progress styled with semantic tokens.
 */

import { defineManifest, type ExtensionAPI } from "@hansjm10/volt-coding-agent";

export const manifest = defineManifest({ id: "status-line", displayName: "Status Line" });

export default function (volt: ExtensionAPI) {
	let turnCount = 0;

	volt.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus("status-demo", [{ text: "Ready", token: "muted" }]);
	});

	volt.on("turn_start", async (_event, ctx) => {
		turnCount++;
		ctx.ui.setStatus("status-demo", [
			{ text: "●", token: "accent" },
			{ text: ` Turn ${turnCount}...`, token: "muted" },
		]);
	});

	volt.on("turn_end", async (_event, ctx) => {
		ctx.ui.setStatus("status-demo", [
			{ text: "✓", token: "success" },
			{ text: ` Turn ${turnCount} complete`, token: "muted" },
		]);
	});
}
