import { AgentHarnessError } from "./types.ts";

/** Host-owned admission shared by exclusive Harness operations and detached work. */
export class AgentHarnessAdmissionGate {
	private holds = 0;
	private currentRevision = 0;

	get isOpen(): boolean {
		return this.holds === 0;
	}

	get revision(): number {
		return this.currentRevision;
	}

	assertOpen(): void {
		if (!this.isOpen) throw new AgentHarnessError("busy", "Operation admission is suspended");
	}

	/** A released suspension never restores authority to an older reservation. */
	isCurrent(revision: number): boolean {
		return this.isOpen && revision === this.currentRevision;
	}

	/** Fence synchronously before cancellation callbacks; release after all owned cleanup settles. */
	suspend(): () => void {
		this.holds++;
		this.currentRevision++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.holds--;
		};
	}
}
