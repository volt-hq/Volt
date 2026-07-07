import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getKeepAwakeCommand, KeepAwakeController, type KeepAwakeStatus } from "../src/daemon/keep-awake.ts";

class FakeChild extends EventEmitter {
	pid = 4242;
	exitCode: number | null = null;
	killed = false;
	signals: string[] = [];
	unref = vi.fn();
	kill(signal?: string): boolean {
		this.killed = true;
		this.signals.push(signal ?? "SIGTERM");
		return true;
	}
	/** Simulate the OS reaping the child. */
	exit(code: number | null, signal: string | null = null): void {
		this.exitCode = code;
		this.emit("exit", code, signal);
	}
}

function createFakeSpawn() {
	const children: FakeChild[] = [];
	const calls: { command: string; args: string[] }[] = [];
	const spawn = vi.fn((command: string, args: string[]) => {
		calls.push({ command, args });
		const child = new FakeChild();
		children.push(child);
		return child;
	});
	return { spawn: spawn as any, children, calls };
}

function createController(overrides: Partial<ConstructorParameters<typeof KeepAwakeController>[0]> = {}) {
	const fake = createFakeSpawn();
	const statuses: KeepAwakeStatus[] = [];
	const controller = new KeepAwakeController({
		platform: "darwin",
		spawn: fake.spawn,
		onStatusChanged: (status) => statuses.push(status),
		retryBackoffMs: [1_000, 5_000, 30_000],
		...overrides,
	});
	return { controller, fake, statuses };
}

describe("getKeepAwakeCommand", () => {
	it("uses caffeinate idle+system flags on darwin without touching the display", () => {
		const command = getKeepAwakeCommand("darwin");
		expect(command?.method).toBe("caffeinate");
		expect(command?.command).toBe("/usr/bin/caffeinate");
		expect(command?.args).toEqual(["-i", "-s"]);
		expect(command?.args).not.toContain("-d");
	});

	it("uses a blocking systemd-inhibit on linux", () => {
		const command = getKeepAwakeCommand("linux");
		expect(command?.method).toBe("systemd-inhibit");
		expect(command?.args).toContain("--mode=block");
		expect(command?.args).toContain("--what=sleep:idle");
	});

	it("uses a powershell SetThreadExecutionState child on win32", () => {
		const command = getKeepAwakeCommand("win32");
		expect(command?.method).toBe("powershell");
		expect(command?.args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
		expect(command?.args[3]).toContain("SetThreadExecutionState");
		expect(command?.args[3]).toContain("0x80000001");
	});

	it("returns undefined for unsupported platforms", () => {
		expect(getKeepAwakeCommand("freebsd")).toBeUndefined();
	});
});

describe("KeepAwakeController", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("starts disabled", () => {
		const { controller, fake } = createController();
		expect(controller.status).toEqual({ enabled: false, state: "disabled", method: "caffeinate" });
		expect(fake.spawn).not.toHaveBeenCalled();
	});

	it("spawns once on enable and ignores a duplicate enable", () => {
		const { controller, fake } = createController();
		const status = controller.setEnabled(true);
		expect(status.state).toBe("active");
		controller.setEnabled(true);
		expect(fake.spawn).toHaveBeenCalledTimes(1);
		expect(fake.calls[0]).toEqual({ command: "/usr/bin/caffeinate", args: ["-i", "-s"] });
		expect(fake.children[0]?.unref).toHaveBeenCalled();
	});

	it("kills the child on disable and reports disabled without a respawn", () => {
		const { controller, fake, statuses } = createController();
		controller.setEnabled(true);
		const status = controller.setEnabled(false);
		expect(status).toEqual({ enabled: false, state: "disabled", method: "caffeinate" });
		expect(fake.children[0]?.signals).toEqual(["SIGTERM"]);
		// The killed child's exit event is stale and must not trigger a respawn.
		fake.children[0]?.exit(null, "SIGTERM");
		vi.advanceTimersByTime(120_000);
		expect(fake.spawn).toHaveBeenCalledTimes(1);
		expect(statuses.map((s) => s.state)).toEqual(["active", "disabled"]);
	});

	it("degrades and respawns on the backoff ladder when the child dies", () => {
		const { controller, fake, statuses } = createController();
		controller.setEnabled(true);
		fake.children[0]?.exit(1);
		expect(controller.status).toMatchObject({ enabled: true, state: "degraded", reason: "caffeinate exited" });
		vi.advanceTimersByTime(999);
		expect(fake.spawn).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1);
		expect(fake.spawn).toHaveBeenCalledTimes(2);
		expect(controller.status.state).toBe("active");
		// Second quick death waits 5s, third 30s, later ones repeat 30s.
		fake.children[1]?.exit(1);
		vi.advanceTimersByTime(5_000);
		expect(fake.spawn).toHaveBeenCalledTimes(3);
		fake.children[2]?.exit(1);
		vi.advanceTimersByTime(30_000);
		expect(fake.spawn).toHaveBeenCalledTimes(4);
		expect(statuses.map((s) => s.state)).toEqual([
			"active",
			"degraded",
			"active",
			"degraded",
			"active",
			"degraded",
			"active",
		]);
	});

	it("resets the backoff ladder after the child stays alive for a minute", () => {
		const { controller, fake } = createController();
		controller.setEnabled(true);
		fake.children[0]?.exit(1);
		vi.advanceTimersByTime(1_000);
		expect(fake.spawn).toHaveBeenCalledTimes(2);
		// Child survives past the stability window, so the next death retries at 1s again.
		vi.advanceTimersByTime(60_000);
		fake.children[1]?.exit(1);
		vi.advanceTimersByTime(1_000);
		expect(fake.spawn).toHaveBeenCalledTimes(3);
	});

	it("reports a not-found reason when the binary is missing", () => {
		const { controller, fake } = createController({ platform: "linux" });
		controller.setEnabled(true);
		const error = new Error("spawn systemd-inhibit ENOENT") as NodeJS.ErrnoException;
		error.code = "ENOENT";
		fake.children[0]?.emit("error", error);
		expect(controller.status).toMatchObject({
			enabled: true,
			state: "degraded",
			reason: "systemd-inhibit not found",
		});
	});

	it("degrades with a generic reason on unsupported platforms", () => {
		const { controller, fake } = createController({ platform: "freebsd" });
		const status = controller.setEnabled(true);
		expect(status).toEqual({ enabled: true, state: "degraded", reason: "unsupported platform" });
		expect(fake.spawn).not.toHaveBeenCalled();
	});

	it("shutdown kills the child, cancels retries, and keeps the enabled flag", async () => {
		const { controller, fake } = createController();
		controller.setEnabled(true);
		await controller.shutdown();
		expect(fake.children[0]?.signals).toEqual(["SIGTERM"]);
		expect(controller.status.enabled).toBe(true);
		vi.advanceTimersByTime(120_000);
		expect(fake.spawn).toHaveBeenCalledTimes(1);
		await expect(controller.shutdown()).resolves.toBeUndefined();
	});

	it("escalates to SIGKILL when the child ignores SIGTERM", () => {
		const { controller, fake } = createController();
		controller.setEnabled(true);
		const child = fake.children[0];
		if (child === undefined) throw new Error("expected child");
		// Pretend the process object reports not-yet-exited despite kill().
		child.killed = false;
		controller.setEnabled(false);
		child.killed = false;
		vi.advanceTimersByTime(2_000);
		expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
	});
});
