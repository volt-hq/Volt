import { Buffer } from "node:buffer";
import type { IrohConnectionLike } from "./iroh-native.ts";

export type IrohConnectionCloseTiming = "immediate" | "when_idle";

export class IrohConnectionSupervisor {
	private readonly connection: IrohConnectionLike;
	private readonly childTasks = new Set<Promise<void>>();
	private readonly terminalFinalizers: Array<() => void> = [];
	private readonly terminalPromise: Promise<void>;
	private closeReason: string | undefined;
	private closeWhenIdleRequested = false;
	private closeStarted = false;
	private acceptingChildren = true;

	constructor(connection: IrohConnectionLike) {
		this.connection = connection;
		this.terminalPromise = connection.closed().then(
			() => undefined,
			() => undefined,
		);
	}

	get isClosing(): boolean {
		return this.closeStarted;
	}

	get childTaskCount(): number {
		return this.childTasks.size;
	}

	addTerminalFinalizer(finalizer: () => void): void {
		this.terminalFinalizers.push(finalizer);
	}

	trackChild(task: Promise<void>): void {
		if (!this.acceptingChildren) {
			throw new Error("cannot track a child task after connection finalization started");
		}
		this.childTasks.add(task);
		void task.then(
			() => this.onChildSettled(task),
			() => this.onChildSettled(task),
		);
	}

	requestClose(reason: string, timing: IrohConnectionCloseTiming): void {
		if (this.closeStarted) {
			return;
		}
		this.closeReason = reason;
		if (timing === "immediate") {
			this.closePhysicalConnection();
			return;
		}
		this.closeWhenIdleRequested = true;
		this.closeIfIdle();
	}

	async finalize(defaultReason: string): Promise<void> {
		this.acceptingChildren = false;
		this.requestClose(defaultReason, "when_idle");
		while (this.childTasks.size > 0) {
			await Promise.allSettled(Array.from(this.childTasks));
		}
		this.closeIfIdle();
		await this.terminalPromise;
		for (const finalizer of this.terminalFinalizers.splice(0)) {
			try {
				finalizer();
			} catch {
				// One bookkeeping cleanup must not prevent the remaining releases.
			}
		}
	}

	private onChildSettled(task: Promise<void>): void {
		this.childTasks.delete(task);
		this.closeIfIdle();
	}

	private closeIfIdle(): void {
		if (!this.closeWhenIdleRequested || this.childTasks.size > 0) {
			return;
		}
		this.closePhysicalConnection();
	}

	private closePhysicalConnection(): void {
		if (this.closeStarted) {
			return;
		}
		this.closeStarted = true;
		try {
			this.connection.close(0n, Array.from(Buffer.from(this.closeReason ?? "done", "utf8")));
		} catch {
			// Transport closure is best-effort; child settlement and finalizers still run.
		}
	}
}
