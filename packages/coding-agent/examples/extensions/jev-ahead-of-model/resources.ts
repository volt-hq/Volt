import type { ExtensionWorkFailure } from "@hansjm10/volt-coding-agent";
import { MAX_AHEAD_NATIVE_OPERATIONS } from "./limits.ts";

/** Request-local observations. Cached source evidence still requires native validation at admission. */
export class AheadResources {
	operations = 0;
	validationReservations = 0;
	cacheHits = 0;
	blockedReason: string | undefined;
	private generation = 0;
	private bytes = 0;
	private cache = new Map<string, { value: unknown; bytes: number }>();

	get remaining(): number {
		return Math.max(0, MAX_AHEAD_NATIVE_OPERATIONS - this.operations - this.validationReservations);
	}

	invalidate(): void {
		this.generation++;
		this.cache.clear();
		this.bytes = 0;
	}

	async run<T extends { status: string }>(
		key: string | undefined,
		run: () => Promise<T>,
		onCacheHit: () => void,
	): Promise<T | ExtensionWorkFailure> {
		if (this.blockedReason) return { status: "limit_exceeded", reason: this.blockedReason };
		const cached = key && this.cache.get(key);
		if (cached) {
			this.cacheHits++;
			onCacheHit();
			// Keys include the service and all arguments; callers preserve each service's result type.
			return structuredClone(cached.value) as T;
		}
		if (!this.remaining) {
			this.blockedReason = "validation_reserve";
			return { status: "limit_exceeded", reason: this.blockedReason };
		}
		this.operations++;
		const generation = this.generation;
		const result = await run();
		if (result.status === "limit_exceeded") this.blockedReason = "host_limit";
		if (key && result.status === "ok" && generation === this.generation) {
			const bytes = Buffer.byteLength(JSON.stringify(result));
			if (bytes <= 256 * 1024) {
				while (this.cache.size && (this.cache.size >= 64 || this.bytes + bytes > 256 * 1024)) {
					const oldest = this.cache.keys().next().value!;
					this.bytes -= this.cache.get(oldest)!.bytes;
					this.cache.delete(oldest);
				}
				this.cache.set(key, { value: structuredClone(result), bytes });
				this.bytes += bytes;
			}
		}
		return result;
	}
}
