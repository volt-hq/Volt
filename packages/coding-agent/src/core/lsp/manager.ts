/**
 * Config-driven multi-server LSP manager.
 *
 * Routes files to language servers by extension, lazily spawns one client per
 * (server, project root), and formats post-mutation diagnostics for tool
 * results. Server start failures are reported once and then suppressed.
 */

import { existsSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import type { ToolDiagnosticsProvider } from "../tools/diagnostics-provider.ts";
import { LspClient, type LspDiagnostic } from "./client.ts";
import { type ResolvedLspConfig, type ResolvedLspServerConfig, SEVERITY_NAMES } from "./config.ts";

export interface LspManagerOptions {
	cwd: string;
	config: ResolvedLspConfig;
}

interface ServerFailureState {
	count: number;
	reported: boolean;
}

const MAX_START_ATTEMPTS = 3;

export class LspManager implements ToolDiagnosticsProvider {
	private cwd: string;
	private config: ResolvedLspConfig;
	private clients = new Map<string, LspClient>();
	private startFailures = new Map<string, ServerFailureState>();
	private disposed = false;

	constructor(options: LspManagerOptions) {
		this.cwd = options.cwd;
		this.config = options.config;
	}

	/**
	 * Collect diagnostics for a file that was just written.
	 *
	 * Returns formatted diagnostics text, or undefined when no matching server
	 * is configured, the server is unavailable, or there is nothing to report.
	 */
	async getDiagnostics(absolutePath: string, content: string, signal?: AbortSignal): Promise<string | undefined> {
		if (this.disposed) {
			return undefined;
		}
		const server = this.findServer(absolutePath);
		if (!server) {
			return undefined;
		}
		const failure = this.startFailures.get(server.name);
		if (failure && failure.count >= MAX_START_ATTEMPTS) {
			return undefined;
		}

		const client = this.getClient(server, absolutePath);
		let diagnostics: LspDiagnostic[];
		try {
			diagnostics = await client.getDiagnostics(absolutePath, content, this.config.settleMs, signal);
		} catch (error) {
			return this.handleClientError(server, client, error);
		}
		if (this.disposed) {
			return undefined;
		}
		this.startFailures.delete(server.name);
		return this.formatDiagnostics(absolutePath, diagnostics);
	}

	dispose(): void {
		this.disposed = true;
		for (const client of this.clients.values()) {
			client.dispose();
		}
		this.clients.clear();
	}

	private findServer(absolutePath: string): ResolvedLspServerConfig | undefined {
		const ext = extname(absolutePath).toLowerCase();
		if (!ext) {
			return undefined;
		}
		return this.config.servers.find((server) => server.fileExtensions.includes(ext));
	}

	private findRoot(absolutePath: string, rootMarkers: string[]): string {
		if (rootMarkers.length > 0) {
			let dir = dirname(absolutePath);
			while (true) {
				if (rootMarkers.some((marker) => existsSync(join(dir, marker)))) {
					return dir;
				}
				const parent = dirname(dir);
				if (parent === dir) {
					break;
				}
				dir = parent;
			}
		}
		const rel = relative(this.cwd, absolutePath);
		const isUnderCwd = rel !== "" && !rel.startsWith("..") && !rel.includes(":");
		return isUnderCwd ? this.cwd : dirname(absolutePath);
	}

	private getClient(server: ResolvedLspServerConfig, absolutePath: string): LspClient {
		const root = this.findRoot(absolutePath, server.rootMarkers);
		const key = `${server.name}\u0000${root}`;
		const existing = this.clients.get(key);
		if (existing?.isAlive) {
			return existing;
		}
		existing?.dispose();
		const client = new LspClient({
			serverName: server.name,
			command: server.command,
			rootDir: root,
			initializationOptions: server.initializationOptions,
		});
		this.clients.set(key, client);
		return client;
	}

	private handleClientError(server: ResolvedLspServerConfig, client: LspClient, error: unknown): string | undefined {
		if (!client.isAlive) {
			for (const [key, value] of this.clients) {
				if (value === client) {
					this.clients.delete(key);
				}
			}
			client.dispose();
		}
		const failure = this.startFailures.get(server.name) ?? { count: 0, reported: false };
		failure.count++;
		this.startFailures.set(server.name, failure);
		if (this.disposed || failure.reported) {
			return undefined;
		}
		failure.reported = true;
		const message = error instanceof Error ? error.message : String(error);
		return `lsp(${server.name}): ${message} (further failures for this server will be silent)`;
	}

	private formatDiagnostics(absolutePath: string, diagnostics: LspDiagnostic[]): string | undefined {
		const filtered = diagnostics
			.filter((diagnostic) => (diagnostic.severity ?? 1) <= this.config.maxSeverity)
			.sort((a, b) => (a.severity ?? 1) - (b.severity ?? 1) || a.range.start.line - b.range.start.line);
		if (filtered.length === 0) {
			return undefined;
		}
		const shown = filtered.slice(0, this.config.maxDiagnostics);
		const displayPath = relative(this.cwd, absolutePath) || absolutePath;
		const lines = shown.map((diagnostic) => {
			const severity = SEVERITY_NAMES[diagnostic.severity ?? 1] ?? "error";
			const line = diagnostic.range.start.line + 1;
			const column = diagnostic.range.start.character + 1;
			const code =
				diagnostic.code !== undefined
					? ` [${diagnostic.source ? `${diagnostic.source} ` : ""}${diagnostic.code}]`
					: "";
			const message = diagnostic.message.replace(/\s+/g, " ").trim();
			return `${displayPath}(${line},${column}): ${severity}: ${message}${code}`;
		});
		if (filtered.length > shown.length) {
			lines.push(`... and ${filtered.length - shown.length} more`);
		}
		return lines.join("\n");
	}
}
