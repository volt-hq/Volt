// Regression: https://github.com/volt-hq/volt-app/issues/397
import { type HostFrame, REMOTE_CAPABILITIES } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localProfile, type Profile, remoteProfile } from "../../../src/core/protocol/profiles.ts";
import {
	type AuthorityLoss,
	type ServeConnectionOptions,
	serveConnection,
} from "../../../src/core/protocol/server/connection.ts";
import type { RpcCloseHandler, RpcTransport, RpcValueHandler } from "../../../src/core/protocol/transport/transport.ts";
import { createHostHarness } from "../host-harness.ts";

const HELLO = { type: "hello", protocol: 1, client: { name: "test", version: "1" }, accepts: { hostRequests: [] } };
const profiles = [
	localProfile,
	remoteProfile({
		grant: { schemaVersion: 1, revision: 1, capabilities: [...REMOTE_CAPABILITIES] },
		redaction: { workspacePath: "/test/workspace" },
	}),
];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	vi.restoreAllMocks();
});

function connect(
	profile: Profile,
	options: ServeConnectionOptions = {},
	onWrite?: (frame: HostFrame) => void | Promise<void>,
) {
	const frames: HostFrame[] = [];
	let receive: RpcValueHandler | undefined;
	let disconnect: RpcCloseHandler | undefined;
	const transport: RpcTransport = {
		write(value) {
			const frame = value as HostFrame;
			frames.push(frame);
			return onWrite?.(frame);
		},
		onLine: () => () => {},
		onValue(handler) {
			receive = handler;
			return () => {
				receive = undefined;
			};
		},
		onClose(handler) {
			disconnect = handler;
			return () => {
				disconnect = undefined;
			};
		},
		close: vi.fn(),
	};
	const connection = serveConnection(transport, profile, options);
	cleanups.push(() =>
		connection
			.close()
			.then(() => connection.closed)
			.catch(() => undefined),
	);
	return {
		connection,
		frames,
		send: (frame: object) => receive?.(frame),
		disconnect: (error?: Error) => disconnect?.(error),
		transport,
	};
}

describe.each(profiles)("app #397 welcome ordering on $name", (profile) => {
	it("delivers early catalogs in order, including repeats, then delivers later changes", async () => {
		const peer = connect(profile);
		peer.connection.changed("models");
		peer.connection.changed("settings");
		peer.connection.changed("models");
		expect(peer.frames).toEqual([]);
		peer.send(HELLO);
		await peer.connection.ready;
		peer.connection.changed("sessions");
		expect(peer.frames).toEqual([
			expect.objectContaining({ type: "welcome", profile: profile.name }),
			{ type: "changed", catalog: "models" },
			{ type: "changed", catalog: "settings" },
			{ type: "changed", catalog: "models" },
			{ type: "changed", catalog: "sessions" },
		]);
	});

	it("buffers synchronous attachment callbacks and session_start notifications", async () => {
		const harness = await createHostHarness({
			extension: (volt) => {
				volt.on("session_start", () => {
					peer.connection.changed("extensions");
				});
			},
		});
		cleanups.push(() => harness.cleanup());
		const conversation = await harness.openStartup();
		const peer = connect(profile, { host: harness.host, conversation });
		const attach = harness.host.attach.bind(harness.host);
		vi.spyOn(harness.host, "attach").mockImplementation((client, target) => {
			peer.connection.changed("settings");
			expect(peer.frames).toEqual([]);
			return attach(client, target);
		});
		peer.connection.changed("models");
		peer.send(HELLO);
		await peer.connection.ready;
		expect(peer.frames).toEqual([
			expect.objectContaining({ type: "welcome" }),
			{ type: "changed", catalog: "models" },
			{ type: "changed", catalog: "settings" },
			{ type: "changed", catalog: "extensions" },
		]);
	});

	it("keeps changes during an asynchronous welcome and reentrant flush in order", async () => {
		const welcome = Promise.withResolvers<void>();
		const peer = connect(profile, {}, (frame) => {
			if (frame.type === "welcome") return welcome.promise;
			if (frame.type === "changed" && frame.catalog === "models") peer.connection.changed("extensions");
		});
		peer.connection.changed("models");
		peer.send(HELLO);
		peer.connection.changed("settings");
		expect(peer.frames.map((frame) => frame.type)).toEqual(["welcome"]);
		welcome.resolve();
		await vi.waitFor(() => expect(peer.frames).toHaveLength(4));
		expect(peer.frames.slice(1)).toEqual([
			{ type: "changed", catalog: "models" },
			{ type: "changed", catalog: "settings" },
			{ type: "changed", catalog: "extensions" },
		]);
	});

	it.each(["close", "disconnect", "error", "mismatch", "shutdown"] as const)(
		"does not release queued catalogs after %s before hello",
		async (ending) => {
			const failure = new Error("transport failed");
			const peer = connect(profile);
			peer.connection.changed("models");
			if (ending === "close") void peer.connection.close();
			else if (ending === "disconnect") peer.disconnect();
			else if (ending === "error") peer.disconnect(failure);
			else if (ending === "mismatch") peer.send({ ...HELLO, protocol: 2 });
			else void peer.connection.shutdown();
			if (ending === "error") await expect(peer.connection.closed).rejects.toBe(failure);
			else await peer.connection.closed;
			peer.send(HELLO);
			peer.connection.changed("settings");
			expect(peer.frames).toEqual(
				ending === "mismatch" || ending === "shutdown"
					? [
							expect.objectContaining({
								type: "fatal",
								code: ending === "mismatch" ? "protocol_mismatch" : "host_shutdown",
							}),
						]
					: [],
			);
			await expect(peer.connection.ready).rejects.toThrow("before hello");
			expect(peer.transport.close).toHaveBeenCalledOnce();
		},
	);

	it.each(["close", "error", "revoked", "workspace_unregistered"] as const)(
		"does not release catalogs when %s occurs while welcome is pending",
		async (ending) => {
			const welcome = Promise.withResolvers<void>();
			let loss: AuthorityLoss | undefined;
			const failure = new Error("disconnected during welcome");
			const peer = connect(profile, { authority: () => loss }, (frame) => {
				if (frame.type === "welcome") return welcome.promise;
			});
			peer.connection.changed("models");
			peer.send(HELLO);
			if (ending === "close") void peer.connection.close();
			else if (ending === "error") peer.disconnect(failure);
			else loss = ending;
			welcome.resolve();
			if (ending === "error") await expect(peer.connection.closed).rejects.toBe(failure);
			else await peer.connection.closed;
			peer.connection.changed("settings");
			expect(peer.frames.map((frame) => frame.type)).toEqual(loss ? ["welcome", "fatal"] : ["welcome"]);
			if (loss) expect(peer.frames.at(-1)).toEqual({ type: "fatal", code: loss });
		},
	);

	it("rechecks authority between buffered notifications and writes nothing after fatal", async () => {
		let loss: AuthorityLoss | undefined;
		const peer = connect(profile, { authority: () => loss }, (frame) => {
			if (frame.type === "changed") loss = "revoked";
		});
		peer.connection.changed("models");
		peer.connection.changed("settings");
		peer.send(HELLO);
		await peer.connection.closed;
		peer.connection.changed("sessions");
		expect(peer.frames).toEqual([
			expect.objectContaining({ type: "welcome" }),
			{ type: "changed", catalog: "models" },
			{ type: "fatal", code: "revoked" },
		]);
	});

	it.each(["sync", "async", "redaction"] as const)("does not flush after a %s welcome failure", async (kind) => {
		const failure = new Error("welcome failed");
		const redactor = profile.redactor();
		const failingProfile: Profile =
			kind === "redaction"
				? {
						...profile,
						redactor: () => ({
							...redactor,
							redact: () => {
								throw failure;
							},
						}),
					}
				: profile;
		const peer = connect(failingProfile, {}, () => {
			if (kind === "async") return Promise.reject(failure);
			throw failure;
		});
		peer.connection.changed("models");
		peer.send(HELLO);
		await expect(peer.connection.closed).rejects.toBe(failure);
		peer.connection.changed("settings");
		expect(peer.frames.map((frame) => frame.type)).toEqual(kind === "redaction" ? [] : ["welcome"]);
	});

	it("stops flushing when a buffered notification write fails", async () => {
		const failure = new Error("catalog write failed");
		const peer = connect(profile, {}, (frame) => {
			if (frame.type === "changed") throw failure;
		});
		peer.connection.changed("models");
		peer.connection.changed("settings");
		peer.send(HELLO);
		await expect(peer.connection.closed).rejects.toBe(failure);
		expect(peer.frames.map((frame) => frame.type)).toEqual(["welcome", "changed"]);
	});

	it("bounds pending notifications and closes explicitly instead of silently losing events", async () => {
		const peer = connect(profile);
		for (let index = 0; index < 257; index++) peer.connection.changed("models");
		await peer.connection.closed;
		expect(peer.frames).toEqual([expect.objectContaining({ type: "fatal", code: "invalid_frame" })]);
	});
});
