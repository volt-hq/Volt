import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HostFrame, REMOTE_CAPABILITIES } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { IntentHostTheme } from "../src/core/protocol/intents/types.ts";
import { serveIrohRemoteConnection } from "../src/core/remote/iroh/connection.ts";
import { sanitizeHostThemeTokens } from "../src/daemon/theme-push.ts";
import { createIrohStreamPair } from "./utilities/iroh-stream-pair.ts";
import { connectRemotePhone } from "./utilities/remote-phone.ts";

describe("host theme token push (§9.5)", () => {
	const cleanups: Array<() => Promise<void> | void> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	it("keeps only plain hex colors and drops anything path-like or unresolved", () => {
		const sanitized = sanitizeHostThemeTokens({
			accent: "#ff8800",
			background: "#101010ff",
			short: "#abc",
			shortAlpha: "#abcd",
			pathLike: "/Users/someone/.volt/agent/themes/custom.json",
			varRef: "var(accent)",
			ansi: "[38;5;208m",
			empty: "",
			notHex: "#zzzzzz",
			fiveDigits: "#12345",
		});
		expect(sanitized).toEqual({
			accent: "#ff8800",
			background: "#101010ff",
			short: "#abc",
			shortAlpha: "#abcd",
		});
	});

	it("shares the theme with a device in host_status and tells it to refetch on changed{host}", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "volt-theme-push-"));
		cleanups.push(() => rmSync(workspace, { recursive: true, force: true }));
		let theme: IntentHostTheme | undefined;
		const pair = createIrohStreamPair();
		const connection = serveIrohRemoteConnection({
			stream: pair.host,
			grant: { schemaVersion: 1, revision: 1, capabilities: [...REMOTE_CAPABILITIES] },
			redaction: { workspacePath: workspace },
			services: () => ({
				keepAwake: {
					status: () => ({ enabled: false, state: "disabled" }),
					setEnabled: (enabled) => ({ enabled, state: enabled ? "active" : "disabled" }),
				},
				hostTheme: () => theme,
			}),
		});
		const phone = connectRemotePhone(pair.phone);
		cleanups.push(async () => {
			await phone.close();
			await connection.close().catch(() => undefined);
		});
		await phone.hello();

		// Sharing is off: host_status carries no theme.
		const unshared = await phone.query("host_status");
		expect(unshared).toMatchObject({ type: "result", data: { keepAwake: { enabled: false } } });
		expect(unshared.type === "result" ? unshared.data : undefined).not.toHaveProperty("theme");

		// The theme changed and sharing is on: the device is told to refetch, and reads only hex colors.
		theme = {
			themeName: "dark",
			tokens: sanitizeHostThemeTokens({ accent: "#ff8800", leak: `${workspace}/themes/custom.json` }),
		};
		const from = phone.frames.length;
		connection.changed("host");
		await phone.waitFor(
			(frame): frame is Extract<HostFrame, { type: "changed" }> =>
				frame.type === "changed" && frame.catalog === "host",
			{ from },
		);
		await expect(phone.query("host_status")).resolves.toMatchObject({
			type: "result",
			data: { theme: { themeName: "dark", tokens: { accent: "#ff8800" } } },
		});
		expect(JSON.stringify(phone.frames)).not.toContain(workspace);
	});
});
