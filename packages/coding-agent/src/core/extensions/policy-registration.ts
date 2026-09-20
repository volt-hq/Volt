/** A host-owned registration. Calling it removes the registration idempotently. */
export interface PolicyRegistration<T> {
	(): void;
	/** Replace the registered value in place, preserving policy order. */
	update(value: T): void;
	/** Revoke prior authorization after changing callback closure state. */
	invalidate(): void;
}

export type ExtensionHandlerFn = (...args: unknown[]) => unknown;

/** Owns immutable handler lists; only tool-policy changes advance authorization. */
export class ExtensionHandlerRegistry {
	private readonly handlers = new Map<string, readonly ExtensionHandlerFn[]>();
	private revision = 0n;

	constructor(entries: Iterable<readonly [string, readonly ExtensionHandlerFn[]]> = []) {
		for (const [event, handlers] of entries) {
			for (const handler of handlers) this.register(event, handler);
		}
	}

	get authorizationRevision(): bigint {
		return this.revision;
	}

	get(event: string): readonly ExtensionHandlerFn[] | undefined {
		return this.handlers.get(event);
	}

	has(event: string): boolean {
		return this.handlers.has(event);
	}

	register(
		event: string,
		handler: ExtensionHandlerFn,
		assertActive: () => void = () => {},
	): PolicyRegistration<ExtensionHandlerFn> {
		assertActive();
		if (typeof handler !== "function") throw new TypeError("Expected an extension handler");
		// A unique wrapper gives duplicate registrations independent ownership.
		let callback = handler;
		const invoke: ExtensionHandlerFn = (...args) => callback(...args);
		const changed = () => {
			if (event === "tool_call" || event === "tool_result") this.revision++;
		};
		this.handlers.set(event, Object.freeze([...(this.handlers.get(event) ?? []), invoke]));
		changed();
		let registered = true;
		const assertRegistered = () => {
			assertActive();
			if (!registered) throw new Error("Policy registration has been removed");
		};
		const remove = () => {
			assertActive();
			if (!registered) return;
			registered = false;
			const remaining = (this.handlers.get(event) ?? []).filter((item) => item !== invoke);
			if (remaining.length) this.handlers.set(event, Object.freeze(remaining));
			else this.handlers.delete(event);
			changed();
		};
		return Object.freeze(
			Object.assign(remove, {
				update: (next: ExtensionHandlerFn) => {
					assertRegistered();
					if (typeof next !== "function") throw new TypeError("Expected an extension handler");
					callback = next;
					changed();
				},
				invalidate: () => {
					assertRegistered();
					changed();
				},
			}),
		);
	}
}
