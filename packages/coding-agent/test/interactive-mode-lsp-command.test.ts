import { Container, visibleWidth } from "@hansjm10/volt-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { LspServerStatus } from "../src/core/lsp/manager.ts";
import { initTheme } from "../src/core/theme/runtime.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type Status = ReturnType<AgentSession["getLspStatus"]>;
type Context = {
	session: {
		getLspStatus(): Status;
		restartLspServers(): number;
	};
	chatContainer: Container;
	ui: { requestRender(): void };
};
const prototype = InteractiveMode.prototype as unknown as {
	handleLspCommand(this: Context, args?: string): Promise<void>;
};

function server(overrides: Partial<LspServerStatus> = {}): LspServerStatus {
	return {
		name: "typescript",
		workspaceRoot: "/workspace",
		root: "/workspace/app",
		alive: false,
		openDocuments: 0,
		idleMs: 0,
		launchSource: "path",
		attempts: 0,
		state: "unused",
		unresolvedCommand: "tsc",
		...overrides,
	};
}

function context(servers: LspServerStatus[], enabled = true): Context {
	return {
		session: {
			getLspStatus: () => ({ enabled, workspaceRoot: "/workspace", servers }),
			restartLspServers: vi.fn(() => 1),
		},
		chatContainer: new Container(),
		ui: { requestRender: vi.fn() },
	};
}

describe("InteractiveMode /lsp health", () => {
	beforeAll(() => initTheme("dark"));

	it.each([80, 120, 160])(
		"renders readiness, capability evidence and request failures at %i columns",
		async (width) => {
			const ctx = context([
				server({
					state: "degraded",
					alive: true,
					resolvedExecutable: "/opt/bin/tsc",
					version: "7.0.2",
					serverInfo: { name: "TypeScript", version: "7.0.2" },
					capabilities: ["hoverProvider"],
					operations: 4,
					failures: 1,
					attempts: 1,
					breaker: "closed",
					lastDurationMs: 15,
					totalDurationMs: 50,
					requestError: "Request timed out; diagnostics not verified.",
					lastSuccess: "2026-09-14T10:00:00Z",
					lastFailure: "2026-09-14T10:01:00Z",
				}),
			]);
			await prototype.handleLspCommand.call(ctx);
			const lines = ctx.chatContainer.render(width).lines;
			const text = stripAnsi(lines.join("\n"));
			for (const expected of [
				"LSP Health",
				"degraded",
				"7.0.2",
				"hoverProvider",
				"4 operations",
				"1 failures",
				"last 15ms",
				"Request timed out",
				"diagnostics not verified",
			]) {
				expect(text).toContain(expected);
			}
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			expect(ctx.session.restartLspServers).not.toHaveBeenCalled();
			expect(ctx.ui.requestRender).toHaveBeenCalledOnce();
		},
	);

	it("does not confuse idle/unused/starting with failed or ready and distinguishes unknown capabilities", async () => {
		const ctx = context([
			server({ name: "unused", state: "unused" }),
			server({ name: "idle", state: "idle", capabilities: undefined }),
			server({ name: "starting", state: "starting", alive: true, capabilities: undefined }),
			server({ name: "ready", state: "ready", alive: true, capabilities: [] }),
		]);
		await prototype.handleLspCommand.call(ctx);
		const text = stripAnsi(ctx.chatContainer.render(120).lines.join("\n"));
		expect(text).toContain("unused unused");
		expect(text).toContain("idle idle");
		expect(text).toContain("starting starting");
		expect(text).toContain("Capabilities: unknown");
		expect(text).toContain("Capabilities: none advertised");
		expect(text).not.toContain("failed");
	});

	it("shows configured disabled servers without claiming they started", async () => {
		const ctx = context([server({ state: "disabled" })], false);
		await prototype.handleLspCommand.call(ctx);
		const text = stripAnsi(ctx.chatContainer.render(80).lines.join("\n"));
		expect(text).toContain("LSP is disabled");
		expect(text).toContain("typescript disabled");
		expect(text).toContain("capabilities unknown; not started");
	});

	it("retains startup, stderr, breaker and coverage context", async () => {
		const ctx = context([
			server({
				name: "swift",
				state: "blocked",
				breaker: "open",
				attempts: 3,
				lastError: "Initialize failed",
				startupStderr: "Missing module",
				coverage: "Limited loose-file semantics; configure a build server.",
			}),
		]);
		await prototype.handleLspCommand.call(ctx);
		const text = stripAnsi(ctx.chatContainer.render(80).lines.join("\n"));
		for (const expected of [
			"blocked",
			"breaker open",
			"Startup: Initialize failed",
			"Stderr: Missing module",
			"Coverage: Limited loose-file semantics",
		])
			expect(text).toContain(expected);
	});

	it("keeps restart lazy", async () => {
		const ctx = context([server({ state: "ready", alive: true })]);
		await prototype.handleLspCommand.call(ctx, "restart");
		expect(ctx.session.restartLspServers).toHaveBeenCalledOnce();
		expect(stripAnsi(ctx.chatContainer.render(80).lines.join("\n"))).toContain("Servers respawn on next use.");
	});
});
