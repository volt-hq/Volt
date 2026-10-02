import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TestSocketEndpoint {
	socketPath: string;
	cleanup(): void;
}

export function createTestSocketEndpoint(prefix: string): TestSocketEndpoint {
	if (process.platform === "win32") {
		return {
			socketPath: `\\\\.\\pipe\\${prefix}-${process.pid}-${randomUUID()}`,
			cleanup() {},
		};
	}
	const directory = mkdtempSync(join(tmpdir(), `${prefix}-`));
	return {
		socketPath: join(directory, "s.sock"),
		cleanup() {
			rmSync(directory, { recursive: true, force: true });
		},
	};
}

export async function listenTestServer(server: Server, socketPath: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const cleanup = () => {
			server.off("error", onError);
			server.off("listening", onListening);
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		const onListening = () => {
			cleanup();
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		try {
			server.listen(socketPath);
		} catch (error) {
			cleanup();
			reject(error);
		}
	});
}
