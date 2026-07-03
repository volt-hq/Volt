import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureDaemonDirs, getDaemonPaths } from "../src/daemon/paths.ts";

// Unix permission semantics only.
const posixIt = process.platform === "win32" ? it.skip : it;

describe("daemon fallback socket dir hardening", () => {
	let dir: string | undefined;

	afterEach(() => {
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
			dir = undefined;
		}
	});

	posixIt("tightens loose permissions on a pre-existing fallback socket dir we own", () => {
		dir = mkdtempSync(join(tmpdir(), "voltd-paths-"));
		const agentDir = join(dir, "agent");
		const socketDir = join(dir, "run");
		// Simulates an attacker-guessable /tmp fallback dir created ahead of the
		// daemon with group/other access.
		mkdirSync(socketDir);
		chmodSync(socketDir, 0o755);
		const paths = { ...getDaemonPaths(agentDir), socketPath: join(socketDir, "voltd.sock") };
		ensureDaemonDirs(paths);
		expect(statSync(socketDir).mode & 0o777).toBe(0o700);
	});

	posixIt("refuses a fallback socket path whose parent is not a directory", () => {
		dir = mkdtempSync(join(tmpdir(), "voltd-paths-"));
		const agentDir = join(dir, "agent");
		const socketDir = join(dir, "run");
		writeFileSync(socketDir, "not a dir");
		const paths = { ...getDaemonPaths(agentDir), socketPath: join(socketDir, "voltd.sock") };
		expect(() => ensureDaemonDirs(paths)).toThrow();
	});
});
