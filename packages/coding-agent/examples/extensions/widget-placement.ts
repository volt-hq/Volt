/**
 * Panel Placement Extension
 *
 * Demonstrates ctx.ui.setPanel() placements: panels above and below the
 * editor, and one in the sidebar (fullscreen mode; above the editor elsewhere).
 */

import { defineManifest, type ExtensionAPI } from "@hansjm10/volt-coding-agent";

export const manifest = defineManifest({ id: "widget-placement", displayName: "Panel Placement" });

export default function widgetPlacementExtension(volt: ExtensionAPI) {
	volt.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setPanel("above", { node: { type: "text", text: "Above editor panel" } });
		ctx.ui.setPanel("below", { placement: "belowEditor", node: { type: "text", text: "Below editor panel" } });
		ctx.ui.setPanel("sidebar", {
			title: "Sidebar",
			placement: "sidebar",
			node: { type: "text", text: "Sidebar panel", token: "muted" },
		});
	});
}
