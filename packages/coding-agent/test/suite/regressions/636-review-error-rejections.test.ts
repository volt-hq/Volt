import { afterEach, describe, expect, it } from "vitest";
import {
	createLoopbackClient,
	type LoopbackClient,
	ProtocolQueryError,
	ProtocolRejectedError,
} from "../../../src/client/protocol-client.ts";
import { createHostHarness } from "../host-harness.ts";

describe("regression #636: review errors reach protocol clients as unavailable", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	/** A local client of a conversation in a host without the daemon's review discussion service. */
	async function connect(): Promise<LoopbackClient> {
		const harness = await createHostHarness();
		const client = await createLoopbackClient(harness.host, await harness.openStartup());
		cleanups.push(async () => {
			await client.stop();
			await harness.cleanup();
		});
		return client;
	}

	async function queryError(promise: Promise<unknown>): Promise<ProtocolQueryError> {
		const error = await promise.then(
			() => undefined,
			(caught: unknown) => caught,
		);
		if (!(error instanceof ProtocolQueryError)) throw new Error(`Expected a query error, got ${String(error)}`);
		return error;
	}

	it("rejects review discussion intents unavailable on a host without review discussions", async () => {
		const client = await connect();

		const error = await client
			.intent("review_start_discussions", { runId: "review:636", findingIds: ["f1"], requestId: "start" })
			.then(
				() => undefined,
				(caught: unknown) => caught,
			);

		expect(error).toBeInstanceOf(ProtocolRejectedError);
		expect((error as ProtocolRejectedError).reason).toEqual({
			code: "unavailable",
			message: "This backend has no daemon sibling service",
		});
	});

	it("answers review discussion reads query_error unavailable on a host without review discussions", async () => {
		const client = await connect();

		const error = await queryError(client.query("review.discussion_source", {}));

		expect(error.code).toBe("unavailable");
		expect(error.message).toBe("This backend has no daemon sibling service");
	});

	it("answers a review read query_error unavailable when the review's source is unavailable", async () => {
		const client = await connect();

		const error = await queryError(client.query("review.general", { runId: "review:unknown" }));

		expect(error.code).toBe("unavailable");
		expect(error.message).toBe("This conversation is not an exact member of the review run.");
	});
});
