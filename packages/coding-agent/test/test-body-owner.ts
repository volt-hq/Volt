type BodyOutcome = { ok: true } | { ok: false; error: unknown };

interface OwnedTestBody {
	controller: AbortController;
	body?: Promise<BodyOutcome>;
	closing: boolean;
	finish?: Promise<void>;
}

/**
 * Vitest stops awaiting a timed-out test without stopping its async body. Own the
 * whole body, including post-operation continuations, before removing fixtures.
 */
export function createTestBodyOwner(settleTimeoutMs = 5_000) {
	let active: OwnedTestBody | undefined;

	return {
		start(): void {
			if (active) throw new Error("Previous test body or fixture cleanup is still active");
			active = { controller: new AbortController(), closing: false };
		},
		run<T>(testSignal: AbortSignal, body: (signal: AbortSignal) => Promise<T>): Promise<T> {
			const owned = active;
			if (!owned || owned.closing || owned.body) throw new Error("Test body owner is not accepting a test");
			const signal = AbortSignal.any([testSignal, owned.controller.signal]);
			const result = Promise.resolve().then(() => {
				signal.throwIfAborted();
				return body(signal);
			});
			owned.body = result.then(
				() => ({ ok: true }),
				(error: unknown) => ({ ok: false, error }),
			);
			return result;
		},
		async finish(cleanup: () => Promise<void>): Promise<void> {
			const owned = active;
			if (!owned) return;
			if (!owned.finish) {
				owned.closing = true;
				owned.controller.abort(new Error("Test fixture teardown requested cancellation"));
				owned.finish = (async () => {
					const outcome = await owned.body;
					const errors: unknown[] = outcome && !outcome.ok ? [outcome.error] : [];
					try {
						await cleanup();
					} catch (error) {
						errors.push(error);
					}
					if (errors.length === 1) throw errors[0];
					if (errors.length > 1) throw new AggregateError(errors, "Test body and fixture cleanup failed");
				})();
				const release = () => {
					if (active === owned) active = undefined;
				};
				// Keep ownership after a drain deadline until the actual work settles.
				// Observe both outcomes even if Vitest has stopped awaiting the hook.
				void owned.finish.then(release, release);
			}
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					owned.finish,
					new Promise<never>((_resolve, reject) => {
						timer = setTimeout(
							() => reject(new Error(`Test body or fixture cleanup did not settle within ${settleTimeoutMs}ms`)),
							settleTimeoutMs,
						);
					}),
				]);
			} finally {
				clearTimeout(timer);
			}
		},
	};
}
