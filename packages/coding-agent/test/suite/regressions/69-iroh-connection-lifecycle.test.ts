import { Buffer } from "node:buffer";
import { expect, test } from "vitest";
import type { IrohBiStreamLike } from "../../../src/core/rpc/iroh-transport.ts";
import { IrohConnectionSupervisor } from "../../../src/daemon/iroh-connection-supervisor.ts";
import type { IrohConnectionLike, IrohNodeIdLike } from "../../../src/daemon/iroh-native.ts";
import { createHarness } from "../harness.ts";

interface Deferred {
	promise: Promise<void>;
	resolve(): void;
}

function createDeferred(): Deferred {
	let resolve = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

class ManualIrohConnection implements IrohConnectionLike {
	readonly closeReasons: string[] = [];
	private readonly terminal = createDeferred();

	remoteId(): IrohNodeIdLike {
		return { toString: () => "client-node" };
	}

	acceptBi(): Promise<IrohBiStreamLike> {
		return Promise.reject(new Error("not used"));
	}

	setMaxConcurrentBiStreams(_count: bigint): void {}

	close(_errorCode: bigint, reason: number[]): void {
		this.closeReasons.push(Buffer.from(reason).toString("utf8"));
	}

	closed(): Promise<void> {
		return this.terminal.promise;
	}

	resolveTerminal(): void {
		this.terminal.resolve();
	}
}

test("replacement waits for a sibling handshake before closing its connection", async () => {
	const harness = await createHarness();
	const connection = new ManualIrohConnection();
	const supervisor = new IrohConnectionSupervisor(connection);
	const replacedStream = createDeferred();
	const siblingHandshake = createDeferred();
	supervisor.trackChild(replacedStream.promise);
	supervisor.trackChild(siblingHandshake.promise);

	try {
		supervisor.requestClose("replaced", "when_idle");
		replacedStream.resolve();
		await Promise.resolve();
		expect(connection.closeReasons).toEqual([]);

		siblingHandshake.resolve();
		await expect.poll(() => connection.closeReasons).toEqual(["replaced"]);
		connection.resolveTerminal();
		await supervisor.finalize("done");
	} finally {
		connection.resolveTerminal();
		replacedStream.resolve();
		siblingHandshake.resolve();
		await supervisor.finalize("done");
		harness.cleanup();
	}
});

test("timeout closes immediately but releases accounting only after children and transport settle", async () => {
	const harness = await createHarness();
	const connection = new ManualIrohConnection();
	const supervisor = new IrohConnectionSupervisor(connection);
	const child = createDeferred();
	const lifecycleEvents: string[] = [];
	supervisor.trackChild(
		child.promise.then(() => {
			lifecycleEvents.push("child_settled");
		}),
	);
	supervisor.addTerminalFinalizer(() => {
		lifecycleEvents.push("accounting_released");
	});

	try {
		supervisor.requestClose("handshake_timeout", "immediate");
		expect(connection.closeReasons).toEqual(["handshake_timeout"]);
		const finalized = supervisor.finalize("done");

		await Promise.resolve();
		expect(lifecycleEvents).toEqual([]);
		child.resolve();
		await expect.poll(() => lifecycleEvents).toEqual(["child_settled"]);
		expect(lifecycleEvents).not.toContain("accounting_released");

		connection.resolveTerminal();
		await finalized;
		expect(lifecycleEvents).toEqual(["child_settled", "accounting_released"]);
	} finally {
		connection.resolveTerminal();
		child.resolve();
		await supervisor.finalize("done");
		harness.cleanup();
	}
});

test("quiesce joins admitted application children without waiting for native transport settlement", async () => {
	const harness = await createHarness();
	const connection = new ManualIrohConnection();
	const supervisor = new IrohConnectionSupervisor(connection);
	const mutation = createDeferred();
	const lifecycleEvents: string[] = [];
	supervisor.trackChild(
		mutation.promise.then(() => {
			lifecycleEvents.push("mutation_settled");
		}),
	);

	try {
		supervisor.requestClose("host_shutdown", "immediate");
		const applicationDrain = supervisor.sealAndWaitForChildren().then(() => {
			lifecycleEvents.push("application_drained");
		});
		await Promise.resolve();
		expect(connection.closeReasons).toEqual(["host_shutdown"]);
		expect(lifecycleEvents).toEqual([]);
		expect(() => supervisor.trackChild(Promise.resolve())).toThrow("after connection finalization started");

		mutation.resolve();
		await applicationDrain;
		expect(lifecycleEvents).toEqual(["mutation_settled", "application_drained"]);

		// The native connection tail is deliberately still pending. Application
		// quiescence must not inherit that unbounded transport wait.
		let finalized = false;
		const nativeFinalization = supervisor.finalize("done").then(() => {
			finalized = true;
		});
		await Promise.resolve();
		expect(finalized).toBe(false);
		connection.resolveTerminal();
		await nativeFinalization;
		expect(finalized).toBe(true);
	} finally {
		connection.resolveTerminal();
		mutation.resolve();
		await supervisor.finalize("done");
		harness.cleanup();
	}
});
