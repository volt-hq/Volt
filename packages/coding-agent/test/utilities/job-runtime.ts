/**
 * The background jobs of a bare conversation kernel, for tests of the job
 * tools and their rendering: a work registry with the `job` kind over an
 * in-memory log with no model, so finished jobs queue their notices and no
 * turn runs.
 */

import { Conversation, InMemoryConversationLog, type StreamFn } from "@hansjm10/volt-agent-core";
import { LiveState } from "../../src/core/host/live-state.ts";
import { JobRuntime } from "../../src/core/tools/jobs.ts";
import { WorkRegistry } from "../../src/core/work/registry.ts";

const noTurns: StreamFn = () => {
	throw new Error("No turn runs in this test");
};

export interface TestJobRuntime {
	readonly jobs: JobRuntime;
	readonly work: WorkRegistry;
	/** The live state the jobs' `work/<id>` values go to. */
	readonly live: LiveState;
	/** Stop the jobs and close the conversation. */
	close(): Promise<void>;
}

export async function createTestJobRuntime(): Promise<TestJobRuntime> {
	const conversation = await Conversation.open({
		log: new InMemoryConversationLog("test-jobs"),
		stream: noTurns,
		resolveModel: () => undefined,
	});
	const live = new LiveState({ head: () => conversation.state.ordinal });
	const work: WorkRegistry = new WorkRegistry({
		conversationId: () => conversation.conversationId,
		work: () => conversation.work,
		state: () => conversation.state,
		live: () => live,
		turnId: () => undefined,
		runningChanged: () => jobs.changed(),
	});
	const jobs = new JobRuntime(() => work);
	work.register(jobs.kind());
	conversation.subscribe((event) => {
		if (event.type === "committed") jobs.changed();
	});
	await work.reconcile();
	return {
		jobs,
		work,
		live,
		close: async () => {
			await work.cancelAll("closed").catch(() => undefined);
			await conversation.close().catch(() => undefined);
		},
	};
}
