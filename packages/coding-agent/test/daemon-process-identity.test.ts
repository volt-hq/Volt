import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
	type ProcessQueryRunner,
	parseElapsedTime,
	verifyPidfileProcess,
	verifyProcessCreationTime,
	verifyVoltdProcessIdentity,
} from "../src/daemon/process-identity.ts";

const NOW = 1_800_000_000_000;
const ONE_HOUR_MS = 3_600_000;

function posixRunner(line: string): ProcessQueryRunner {
	return async (command, args) => {
		expect(command).toBe("ps");
		expect(args).toEqual(["-p", "4242", "-o", "etime=,args="]);
		return { code: 0, output: `${line}\n` };
	};
}

const alive = () => "alive" as const;
const gone = () => "gone" as const;

describe("parseElapsedTime", () => {
	it("parses mm:ss, hh:mm:ss, and dd-hh:mm:ss", () => {
		expect(parseElapsedTime("05:09")).toBe((5 * 60 + 9) * 1000);
		expect(parseElapsedTime("01:00:00")).toBe(ONE_HOUR_MS);
		expect(parseElapsedTime("2-03:04:05")).toBe((2 * 86_400 + 3 * 3_600 + 4 * 60 + 5) * 1000);
		expect(parseElapsedTime("   01:00:00  ")).toBe(ONE_HOUR_MS);
		expect(parseElapsedTime("not-a-time")).toBeUndefined();
	});
});

describe("verifyPidfileProcess (posix)", () => {
	const pidfile = { pid: 4242, startedAtMs: NOW - ONE_HOUR_MS };

	it("matches a live daemon with the recorded start time and command line", async () => {
		const verification = await verifyPidfileProcess(pidfile, {
			runner: posixRunner("   01:00:00 node /repo/src/cli.ts daemon run --foreground"),
			platform: "linux",
			now: NOW,
			isProcessAlive: alive,
		});
		expect(verification).toBe("match");
	});

	it("matches a Linux title-rewritten voltd argv", async () => {
		const verification = await verifyPidfileProcess(pidfile, {
			runner: posixRunner("01:00:00 voltd"),
			platform: "linux",
			now: NOW,
			isProcessAlive: alive,
		});
		expect(verification).toBe("match");
	});

	it("rejects a recycled pid whose start time does not match", async () => {
		const verification = await verifyPidfileProcess(pidfile, {
			// Started 5 minutes ago; the pidfile daemon started an hour ago.
			runner: posixRunner("05:00 node /repo/src/cli.ts daemon run --foreground"),
			platform: "linux",
			now: NOW,
			isProcessAlive: alive,
		});
		expect(verification).toBe("mismatch");
	});

	it("rejects a same-start-time process with a foreign command line", async () => {
		const verification = await verifyPidfileProcess(pidfile, {
			runner: posixRunner("01:00:00 /usr/bin/postgres -D /var/db"),
			platform: "linux",
			now: NOW,
			isProcessAlive: alive,
		});
		expect(verification).toBe("mismatch");
	});

	it("matches creation time independently and fails closed on a foreign lock-owner command", async () => {
		const creationVerification = await verifyProcessCreationTime(pidfile, {
			runner: posixRunner("01:00:00 /usr/bin/postgres -D /var/db"),
			platform: "linux",
			now: NOW,
			isProcessAlive: alive,
		});
		const daemonVerification = await verifyVoltdProcessIdentity(pidfile, {
			runner: posixRunner("01:00:00 /usr/bin/postgres -D /var/db"),
			platform: "linux",
			now: NOW,
			isProcessAlive: alive,
		});
		expect(creationVerification).toBe("match");
		expect(daemonVerification).toBe("unknown");
	});

	it("uses creation mismatch even when a live POSIX process has no command-line data", async () => {
		const matching = await verifyVoltdProcessIdentity(pidfile, {
			runner: posixRunner("01:00:00"),
			platform: "linux",
			now: NOW,
			isProcessAlive: alive,
		});
		const recycled = await verifyVoltdProcessIdentity(pidfile, {
			runner: posixRunner("05:00"),
			platform: "linux",
			now: NOW,
			isProcessAlive: alive,
		});
		expect(matching).toBe("unknown");
		expect(recycled).toBe("mismatch");
	});

	it("distinguishes an unavailable creation-time query from a recycled pid", async () => {
		const unavailable = await verifyProcessCreationTime(pidfile, {
			runner: async () => ({ code: 127, output: "spawn ps ENOENT" }),
			platform: "linux",
			now: NOW,
			isProcessAlive: alive,
		});
		const recycled = await verifyProcessCreationTime(pidfile, {
			runner: posixRunner("05:00 /usr/bin/postgres"),
			platform: "linux",
			now: NOW,
			isProcessAlive: alive,
		});
		expect(unavailable).toBe("unknown");
		expect(recycled).toBe("mismatch");
	});

	it("rejects a recycled pid whose argv merely contains the voltd substring", async () => {
		for (const argv of ["tail -f /var/log/voltd.log", "vim voltd.ts", "node /repo/voltd-cli/index.js watch"]) {
			const verification = await verifyPidfileProcess(pidfile, {
				runner: posixRunner(`01:00:00 ${argv}`),
				platform: "linux",
				now: NOW,
				isProcessAlive: alive,
			});
			expect(verification, argv).toBe("mismatch");
		}
	});

	it("matches a voltd binary invoked from an absolute path", async () => {
		const verification = await verifyPidfileProcess(pidfile, {
			runner: posixRunner("01:00:00 /usr/local/bin/voltd"),
			platform: "linux",
			now: NOW,
			isProcessAlive: alive,
		});
		expect(verification).toBe("match");
	});

	it("rejects a rapidly recycled voltd pid outside a lock-specific tolerance", async () => {
		const verification = await verifyVoltdProcessIdentity(pidfile, {
			runner: posixRunner("59:50 voltd"),
			platform: "linux",
			now: NOW,
			isProcessAlive: alive,
			toleranceMs: 2_000,
		});
		expect(verification).toBe("mismatch");
	});

	it("tolerates spawn-to-record skew within the tolerance window", async () => {
		const verification = await verifyPidfileProcess(
			{ pid: 4242, startedAtMs: NOW - ONE_HOUR_MS + 5_000 },
			{
				runner: posixRunner("01:00:00 voltd"),
				platform: "linux",
				now: NOW,
				isProcessAlive: alive,
			},
		);
		expect(verification).toBe("match");
	});

	it("reports gone without querying when the pid does not exist", async () => {
		const runner = vi.fn<ProcessQueryRunner>();
		const verification = await verifyPidfileProcess(pidfile, {
			runner,
			platform: "linux",
			now: NOW,
			isProcessAlive: gone,
		});
		expect(verification).toBe("gone");
		expect(runner).not.toHaveBeenCalled();
	});

	it("reports gone when the process exits between the liveness probe and the query", async () => {
		let probes = 0;
		const verification = await verifyPidfileProcess(pidfile, {
			runner: async () => ({ code: 1, output: "" }),
			platform: "linux",
			now: NOW,
			isProcessAlive: () => (++probes === 1 ? "alive" : "gone"),
		});
		expect(verification).toBe("gone");
	});

	it("refuses (mismatch) when the process is alive but ps is unavailable", async () => {
		const verification = await verifyPidfileProcess(pidfile, {
			runner: async () => ({ code: 127, output: "spawn ps ENOENT" }),
			platform: "linux",
			now: NOW,
			isProcessAlive: alive,
		});
		expect(verification).toBe("mismatch");
	});

	it("refuses invalid pids", async () => {
		expect(await verifyPidfileProcess({ pid: 0, startedAtMs: NOW }, { isProcessAlive: alive })).toBe("mismatch");
		expect(await verifyPidfileProcess({ pid: -5, startedAtMs: NOW }, { isProcessAlive: alive })).toBe("mismatch");
		expect(await verifyPidfileProcess({ pid: 1.5, startedAtMs: NOW }, { isProcessAlive: alive })).toBe("mismatch");
	});
});

describe("verifyPidfileProcess (windows)", () => {
	const pidfile = { pid: 4242, startedAtMs: NOW - ONE_HOUR_MS };

	function windowsRunner(payload: object | string): ProcessQueryRunner {
		return async (command, args) => {
			expect(command).toBe("powershell.exe");
			expect(args[0]).toBe("-NoProfile");
			expect(args.at(-1)).toContain("ProcessId=4242");
			return { code: 0, output: typeof payload === "string" ? payload : `${JSON.stringify(payload)}\r\n` };
		};
	}

	it("matches on CIM creation time and command line", async () => {
		const verification = await verifyPidfileProcess(pidfile, {
			runner: windowsRunner({
				startMs: NOW - ONE_HOUR_MS + 2_000,
				commandLine: "C:\\node.exe C:\\volt\\dist\\cli.js daemon run --foreground",
			}),
			platform: "win32",
			now: NOW,
			isProcessAlive: alive,
		});
		expect(verification).toBe("match");
	});

	it("rejects a recycled pid on Windows", async () => {
		const verification = await verifyPidfileProcess(pidfile, {
			runner: windowsRunner({ startMs: NOW - 60_000, commandLine: "C:\\other.exe daemon run --foreground" }),
			platform: "win32",
			now: NOW,
			isProcessAlive: alive,
		});
		expect(verification).toBe("mismatch");
	});

	it("refuses when the CIM query returns nothing for a live pid", async () => {
		const verification = await verifyPidfileProcess(pidfile, {
			runner: windowsRunner(""),
			platform: "win32",
			now: NOW,
			isProcessAlive: alive,
		});
		expect(verification).toBe("mismatch");
	});

	it("fails closed when CIM omits the live process command line", async () => {
		const verification = await verifyVoltdProcessIdentity(pidfile, {
			runner: windowsRunner({ startMs: NOW - ONE_HOUR_MS, commandLine: null }),
			platform: "win32",
			now: NOW,
			isProcessAlive: alive,
		});
		expect(verification).toBe("unknown");
	});
});

describe("verifyPidfileProcess (real ps)", () => {
	const posixOnly = process.platform === "win32" ? it.skip : it;

	posixOnly("parses the real ps output for the current process and refuses to call it voltd", async () => {
		// The vitest process is alive with a plausible start time but is not
		// voltd; the command-line factor must refuse it.
		const verification = await verifyPidfileProcess({
			pid: process.pid,
			startedAtMs: Date.now() - process.uptime() * 1000,
		});
		expect(verification).toBe("mismatch");
	});

	posixOnly("reports a freshly exited child as gone", async () => {
		const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
		await new Promise<void>((resolve) => child.once("exit", () => resolve()));
		const verification = await verifyPidfileProcess({ pid: child.pid ?? -1, startedAtMs: Date.now() });
		expect(verification).toBe("gone");
	});
});
