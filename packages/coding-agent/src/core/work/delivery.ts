/**
 * Delivery of finished work (RFC §7.1). A completed or failed item of a
 * `message` or `wake` kind queues its notice with its finish: the kernel
 * commits both in one batch, and the notice carries metadata only (the
 * output is fetched by work id). A turn that stops on a final response, a
 * policy, or a tool fences the delivery of the work it started: those items
 * finish without a notice, and the notices they already queued that no turn
 * took yet are withdrawn.
 */

/** Fenced turns remembered for work that starts after its turn was fenced, newest last. */
const FENCED_TURNS_MAX = 32;
/** Queued notices remembered for withdrawal; the oldest is forgotten first. */
const QUEUED_NOTICES_MAX = 256;

interface QueuedNotice {
	readonly turnId: string;
	readonly clientMessageId: string;
}

/** Which finished work queues its notice, and the notices a fenced turn withdraws. */
export class WorkDeliveries {
	private readonly fenced: string[] = [];
	/** Notices of work started during a turn, by work id. */
	private readonly notices = new Map<string, QueuedNotice>();

	/** Whether work started during `turnId` (none: outside a turn) may queue its notice. */
	delivers(turnId: string | undefined): boolean {
		return turnId === undefined || !this.fenced.includes(turnId);
	}

	/** The finish of `workId`, started during `turnId`, queued the notice `clientMessageId`. */
	queued(workId: string, turnId: string | undefined, clientMessageId: string): void {
		if (turnId === undefined) return;
		this.notices.set(workId, { turnId, clientMessageId });
		if (this.notices.size > QUEUED_NOTICES_MAX) {
			const oldest = this.notices.keys().next().value;
			if (oldest !== undefined) this.notices.delete(oldest);
		}
	}

	/** Fence the work `turnId` started; returns the queued notices to withdraw. */
	fence(turnId: string): string[] {
		if (!this.fenced.includes(turnId)) {
			this.fenced.push(turnId);
			if (this.fenced.length > FENCED_TURNS_MAX) this.fenced.shift();
		}
		const withdraw: string[] = [];
		for (const [workId, notice] of this.notices) {
			if (notice.turnId !== turnId) continue;
			this.notices.delete(workId);
			withdraw.push(notice.clientMessageId);
		}
		return withdraw;
	}
}
