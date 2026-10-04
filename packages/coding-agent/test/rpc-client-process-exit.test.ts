import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { spawnRpcClient } from "../src/client/protocol-client.ts";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "volt-rpc-client-exit-"));
	tempDirs.push(dir);
	return dir;
}

function writeChildScript(contents: string): string {
	const dir = createTempDir();
	const path = join(dir, "child.mjs");
	writeFileSync(path, contents);
	return path;
}

function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH") {
			return false;
		}
		throw error;
	}
}

/** A child that answers frames with `handle(frame)`, written as JSON lines. */
function protocolChild(handle: string, prelude = ""): string {
	return writeChildScript(`
${prelude}
let buffer = "";
function writeJson(value) {
	process.stdout.write(JSON.stringify(value) + "\\n");
}
${handle}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let newlineIndex;
	while ((newlineIndex = buffer.indexOf("\\n")) !== -1) {
		const line = buffer.slice(0, newlineIndex);
		buffer = buffer.slice(newlineIndex + 1);
		if (line) handle(JSON.parse(line));
	}
});
process.stdin.resume();
`);
}

/** Answer hello and a snapshot subscription the way a host does, then call `after(frame)` for other frames. */
const WELCOME_AND_SNAPSHOT = `
function welcomeAndSnapshot(frame) {
	if (frame.type === "hello") {
		writeJson({ type: "welcome", protocol: 1, connectionId: "c", profile: "local", server: { name: "test", version: "1" }, conversation: "conv" });
		return true;
	}
	if (frame.type === "subscribe") {
		writeJson({
			type: "snapshot",
			subscriptionId: frame.subscriptionId,
			conversation: "conv",
			ordinal: 0,
			state: { leafId: null, entries: [], earlier: false, model: null, thinkingLevel: "off", fastMode: false, planning: null, name: null, labels: [], queue: [] },
		});
		writeJson({ type: "live", subscriptionId: frame.subscriptionId, basedOn: 0, seq: 1, reset: true, items: [] });
		return true;
	}
	return false;
}
`;

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("spawnRpcClient child process failures", () => {
	test("rejects when the child process exits before welcoming the client", async () => {
		const cliPath = writeChildScript(`
process.stderr.write("startup exploded");
setTimeout(() => {
	process.exit(42);
}, 10);
process.stdin.resume();
`);
		await expect(spawnRpcClient({ cliPath, requestTimeoutMs: 1000 })).rejects.toThrow(
			/Agent process exited \(code=42 signal=null\).*startup exploded/s,
		);
	});

	test("ends the child process when the host refuses the connection", async () => {
		const dir = createTempDir();
		const pidMarker = join(dir, "pid");
		const cliPath = protocolChild(
			`function handle(frame) {
	if (frame.type === "hello") writeJson({ type: "fatal", code: "protocol_mismatch", message: "boot failed" });
}`,
			`import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidMarker)}, String(process.pid));`,
		);
		await expect(spawnRpcClient({ cliPath, requestTimeoutMs: 1000 })).rejects.toThrow(
			/The host ended the connection: protocol_mismatch \(boot failed\)/,
		);
		const pid = Number(readFileSync(pidMarker, "utf8"));
		await expect.poll(() => isProcessRunning(pid)).toBe(false);
	});

	test("ends the child process when it never welcomes the client", async () => {
		const dir = createTempDir();
		const pidMarker = join(dir, "pid");
		const cliPath = protocolChild(
			"function handle() {}",
			`import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidMarker)}, String(process.pid));`,
		);
		await expect(spawnRpcClient({ cliPath, requestTimeoutMs: 1000 })).rejects.toThrow(/Timeout waiting for welcome/);
		const pid = Number(readFileSync(pidMarker, "utf8"));
		await expect.poll(() => isProcessRunning(pid)).toBe(false);
	});

	test("lets a client answer a host request asked before it caught up", async () => {
		const cliPath = protocolChild(
			`${WELCOME_AND_SNAPSHOT}
let subscriptionId;
function handle(frame) {
	if (frame.type === "hello") return welcomeAndSnapshot(frame);
	if (frame.type === "subscribe") {
		subscriptionId = frame.subscriptionId;
		writeJson({
			type: "live",
			subscriptionId,
			basedOn: 0,
			seq: 1,
			reset: true,
			items: [{ type: "set", key: "host_request/startup", value: { kind: "host_request", requestId: "startup", request: { kind: "confirm", title: "Continue?", message: "Ready?" } } }],
		});
		return;
	}
	if (frame.type === "host_response" && frame.requestId === "startup") {
		writeJson({ type: "live", subscriptionId, basedOn: 0, seq: 2, items: [{ type: "clear", key: "host_request/startup" }] });
	}
}`,
		);
		const answered: string[] = [];
		const client = await spawnRpcClient({
			cliPath,
			requestTimeoutMs: 1000,
			hostRequests: ["confirm"],
			onFrame: (frame, self) => {
				if (frame.type !== "live") return;
				for (const item of frame.items) {
					if (item.type === "set" && item.value.kind === "host_request") {
						answered.push(item.value.requestId);
						self.answer(item.value.requestId, { confirmed: true });
					}
				}
			},
		});
		try {
			expect(answered).toEqual(["startup"]);
			await expect.poll(() => client.live.values.has("host_request/startup")).toBe(false);
		} finally {
			await client.stop();
		}
	});

	test("rejects an in-flight intent when the child process exits", async () => {
		const cliPath = protocolChild(`${WELCOME_AND_SNAPSHOT}
function handle(frame) {
	if (welcomeAndSnapshot(frame)) return;
	process.exit(43);
}`);
		const client = await spawnRpcClient({ cliPath, requestTimeoutMs: 1000 });
		await expect(client.intent("abort", {})).rejects.toThrow(/Agent process exited \(code=43 signal=null\)/);
		await client.stop();
	});
});
