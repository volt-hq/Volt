export interface IrohRemoteResourceLimits {
	maxConnectionTasks: number;
	maxConnectionsPerNode: number;
	maxUnauthenticatedConnections: number;
	maxUnauthenticatedConnectionsPerNode: number;
	maxActiveStreams: number;
	maxActiveStreamsPerNode: number;
	maxConcurrentHandshakes: number;
	maxConcurrentHandshakesPerNode: number;
}

export const DEFAULT_IROH_REMOTE_RESOURCE_LIMITS: IrohRemoteResourceLimits = {
	maxConnectionTasks: 128,
	maxConnectionsPerNode: 16,
	maxUnauthenticatedConnections: 32,
	maxUnauthenticatedConnectionsPerNode: 4,
	maxActiveStreams: 128,
	maxActiveStreamsPerNode: 16,
	maxConcurrentHandshakes: 64,
	maxConcurrentHandshakesPerNode: 16,
};

export interface IrohRemoteResourceLease {
	release(): void;
}

export type IrohRemoteResourceAdmission =
	| { ok: true; lease: IrohRemoteResourceLease }
	| { ok: false; scope: "global" | "node"; limit: number };

export interface IrohRemoteResourceSnapshot {
	connectionTasks: number;
	nodeConnections: number;
	unauthenticatedConnections: number;
	nodeUnauthenticatedConnections: number;
	activeStreams: number;
	nodeActiveStreams: number;
	concurrentHandshakes: number;
	nodeConcurrentHandshakes: number;
}

class ResourceLease implements IrohRemoteResourceLease {
	private released = false;
	private readonly onRelease: () => void;

	constructor(onRelease: () => void) {
		this.onRelease = onRelease;
	}

	release(): void {
		if (this.released) return;
		this.released = true;
		this.onRelease();
	}
}

function assertPositiveInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive integer`);
	}
}

/**
 * Synchronous admission accounting for the daemon's Iroh transport. Callers
 * acquire before starting work and release from a `finally` block. Per-node
 * maps remove zero-count entries so rotating node ids cannot grow bookkeeping.
 */
export class IrohRemoteResourceGuard {
	private readonly limits: IrohRemoteResourceLimits;
	private connectionTasks = 0;
	private unauthenticatedConnections = 0;
	private activeStreams = 0;
	private concurrentHandshakes = 0;
	private readonly unauthenticatedConnectionsByNode = new Map<string, number>();
	private readonly connectionsByNode = new Map<string, number>();
	private readonly activeStreamsByNode = new Map<string, number>();
	private readonly concurrentHandshakesByNode = new Map<string, number>();

	constructor(limits: IrohRemoteResourceLimits = DEFAULT_IROH_REMOTE_RESOURCE_LIMITS) {
		for (const [name, value] of Object.entries(limits)) {
			assertPositiveInteger(value, name);
		}
		this.limits = { ...limits };
	}

	tryAcquireConnectionTask(): IrohRemoteResourceAdmission {
		if (this.connectionTasks >= this.limits.maxConnectionTasks) {
			return { ok: false, scope: "global", limit: this.limits.maxConnectionTasks };
		}
		this.connectionTasks++;
		return {
			ok: true,
			lease: new ResourceLease(() => {
				this.connectionTasks--;
			}),
		};
	}

	tryAcquireNodeConnection(nodeId: string): IrohRemoteResourceAdmission {
		const nodeCount = this.connectionsByNode.get(nodeId) ?? 0;
		if (nodeCount >= this.limits.maxConnectionsPerNode) {
			return { ok: false, scope: "node", limit: this.limits.maxConnectionsPerNode };
		}
		this.connectionsByNode.set(nodeId, nodeCount + 1);
		return {
			ok: true,
			lease: new ResourceLease(() => {
				const currentNodeCount = this.connectionsByNode.get(nodeId) ?? 0;
				if (currentNodeCount <= 1) {
					this.connectionsByNode.delete(nodeId);
				} else {
					this.connectionsByNode.set(nodeId, currentNodeCount - 1);
				}
			}),
		};
	}

	tryAcquireUnauthenticatedConnection(nodeId: string): IrohRemoteResourceAdmission {
		return this.tryAcquirePerNode(
			nodeId,
			() => this.unauthenticatedConnections,
			this.unauthenticatedConnectionsByNode,
			this.limits.maxUnauthenticatedConnections,
			this.limits.maxUnauthenticatedConnectionsPerNode,
			(value) => {
				this.unauthenticatedConnections = value;
			},
		);
	}

	tryAcquireActiveStream(nodeId: string): IrohRemoteResourceAdmission {
		return this.tryAcquirePerNode(
			nodeId,
			() => this.activeStreams,
			this.activeStreamsByNode,
			this.limits.maxActiveStreams,
			this.limits.maxActiveStreamsPerNode,
			(value) => {
				this.activeStreams = value;
			},
		);
	}

	tryAcquireHandshake(nodeId: string): IrohRemoteResourceAdmission {
		return this.tryAcquirePerNode(
			nodeId,
			() => this.concurrentHandshakes,
			this.concurrentHandshakesByNode,
			this.limits.maxConcurrentHandshakes,
			this.limits.maxConcurrentHandshakesPerNode,
			(value) => {
				this.concurrentHandshakes = value;
			},
		);
	}

	snapshot(nodeId: string): IrohRemoteResourceSnapshot {
		return {
			connectionTasks: this.connectionTasks,
			nodeConnections: this.connectionsByNode.get(nodeId) ?? 0,
			unauthenticatedConnections: this.unauthenticatedConnections,
			nodeUnauthenticatedConnections: this.unauthenticatedConnectionsByNode.get(nodeId) ?? 0,
			activeStreams: this.activeStreams,
			nodeActiveStreams: this.activeStreamsByNode.get(nodeId) ?? 0,
			concurrentHandshakes: this.concurrentHandshakes,
			nodeConcurrentHandshakes: this.concurrentHandshakesByNode.get(nodeId) ?? 0,
		};
	}

	private tryAcquirePerNode(
		nodeId: string,
		getGlobalCount: () => number,
		countsByNode: Map<string, number>,
		globalLimit: number,
		nodeLimit: number,
		setGlobalCount: (value: number) => void,
	): IrohRemoteResourceAdmission {
		const globalCount = getGlobalCount();
		if (globalCount >= globalLimit) {
			return { ok: false, scope: "global", limit: globalLimit };
		}
		const nodeCount = countsByNode.get(nodeId) ?? 0;
		if (nodeCount >= nodeLimit) {
			return { ok: false, scope: "node", limit: nodeLimit };
		}
		setGlobalCount(globalCount + 1);
		countsByNode.set(nodeId, nodeCount + 1);
		return {
			ok: true,
			lease: new ResourceLease(() => {
				setGlobalCount(getGlobalCount() - 1);
				const currentNodeCount = countsByNode.get(nodeId) ?? 0;
				if (currentNodeCount <= 1) {
					countsByNode.delete(nodeId);
				} else {
					countsByNode.set(nodeId, currentNodeCount - 1);
				}
			}),
		};
	}
}
