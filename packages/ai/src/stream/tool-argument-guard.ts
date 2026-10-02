import type { ToolArgumentLimits } from "../types.ts";
import type { AssistantMessageDiagnostic } from "../utils/diagnostics.ts";
import type { JsonObject } from "../utils/json-value.ts";

export const DEFAULT_TOOL_ARGUMENT_LIMITS = Object.freeze({
	maxBytes: 1024 * 1024,
	maxTotalBytes: 8 * 1024 * 1024,
	maxIdleMs: 5 * 60 * 1000,
});

interface CallBudget {
	startedAt: number;
	lastProgressAt: number;
	bytes: number;
	lastHighSurrogate: boolean;
	events: number;
	timer?: ReturnType<typeof setTimeout>;
}

export interface ToolArgumentLimitFailure {
	message: string;
	diagnostic: AssistantMessageDiagnostic;
}

/** Counts raw input before it is retained or parsed. Deadlines use a monotonic clock. */
export class ToolArgumentGuard {
	readonly limits: Required<Omit<ToolArgumentLimits, "maxDurationMs">> & Pick<ToolArgumentLimits, "maxDurationMs">;
	readonly configurationError: string | undefined;
	private readonly calls = new Map<number, CallBudget>();
	private totalBytes = 0;
	private disposed = false;
	private readonly onFailure: (failure: ToolArgumentLimitFailure) => void;

	constructor(options: ToolArgumentLimits | undefined, onFailure: (failure: ToolArgumentLimitFailure) => void) {
		this.limits = {
			maxBytes: options?.maxBytes ?? DEFAULT_TOOL_ARGUMENT_LIMITS.maxBytes,
			maxTotalBytes: options?.maxTotalBytes ?? DEFAULT_TOOL_ARGUMENT_LIMITS.maxTotalBytes,
			maxIdleMs: options?.maxIdleMs ?? DEFAULT_TOOL_ARGUMENT_LIMITS.maxIdleMs,
			...(options?.maxDurationMs === undefined ? {} : { maxDurationMs: options.maxDurationMs }),
		};
		this.onFailure = onFailure;
		for (const [key, value] of Object.entries(this.limits)) {
			const isTimeout = key === "maxIdleMs" || key === "maxDurationMs";
			if (!Number.isSafeInteger(value) || value <= 0 || (isTimeout && value > 2_147_483_647)) {
				this.configurationError = `toolArgumentLimits.${key} must be a positive integer${isTimeout ? " no greater than 2147483647" : ""}`;
				break;
			}
		}
	}

	start(contentIndex: number): void {
		if (this.disposed || this.calls.has(contentIndex)) return;
		const now = performance.now();
		const call: CallBudget = { startedAt: now, lastProgressAt: now, bytes: 0, lastHighSurrogate: false, events: 0 };
		this.calls.set(contentIndex, call);
		this.scheduleDeadline(contentIndex, call);
	}

	private scheduleDeadline(contentIndex: number, call: CallBudget): void {
		const deadline = Math.min(
			call.lastProgressAt + this.limits.maxIdleMs,
			this.limits.maxDurationMs === undefined ? Infinity : call.startedAt + this.limits.maxDurationMs,
		);
		call.timer = setTimeout(() => {
			// Progress moves the idle deadline without allocating a timer for every delta.
			if (this.checkDeadline(contentIndex)) this.scheduleDeadline(contentIndex, call);
		}, deadline - performance.now());
		// A forgotten standalone preview must not keep a Node process alive.
		if (typeof call.timer === "object" && "unref" in call.timer) call.timer.unref();
	}

	append(contentIndex: number, text: string): boolean {
		if (!this.checkDeadline(contentIndex)) return false;
		const call = this.calls.get(contentIndex);
		if (!call) return false;
		call.events++;
		const correction = call.lastHighSurrogate && isLowSurrogate(text.charCodeAt(0)) ? 2 : 0;
		const allowance = Math.min(this.limits.maxBytes - call.bytes, this.limits.maxTotalBytes - this.totalBytes);
		const added = utf8Bytes(text, allowance + correction) - correction;
		call.bytes += added;
		this.totalBytes += added;
		if (!this.checkBytes(contentIndex) || !this.checkDeadline(contentIndex)) return false;
		if (text.length > 0) {
			call.lastHighSurrogate = isHighSurrogate(text.charCodeAt(text.length - 1));
			call.lastProgressAt = performance.now();
		}
		return true;
	}

	/** A final authoritative string replaces the preview, but cannot refund its consumed budget. */
	replace(contentIndex: number, text: string): boolean {
		return this.replaceBytes(contentIndex, (allowance) => utf8Bytes(text, allowance));
	}

	/** Native structured providers have already decoded JSON; bound it before cloning/validation. */
	replaceObject(contentIndex: number, value: JsonObject): boolean {
		return this.replaceBytes(contentIndex, (allowance) => jsonBytes(value, allowance));
	}

	inspectObject(contentIndex: number, value: JsonObject): boolean {
		return this.replaceBytes(contentIndex, (allowance) => jsonBytes(value, allowance), false);
	}

	private replaceBytes(contentIndex: number, count: (allowance: number) => number, retain = true): boolean {
		if (!this.checkDeadline(contentIndex)) return false;
		const call = this.calls.get(contentIndex);
		if (!call) return false;
		call.events++;
		const allowance = Math.min(this.limits.maxBytes, this.limits.maxTotalBytes - this.totalBytes + call.bytes);
		const bytes = count(allowance);
		// A pre-serialization inspection checks the prospective size. The ensuing raw
		// delta accounts for those bytes, so a successful inspection must not charge twice.
		if (!retain && bytes <= allowance) return this.checkDeadline(contentIndex);
		const grew = bytes > call.bytes;
		this.totalBytes += Math.max(0, bytes - call.bytes);
		call.bytes = Math.max(call.bytes, bytes);
		if (!this.checkBytes(contentIndex) || !this.checkDeadline(contentIndex)) return false;
		if (grew) call.lastProgressAt = performance.now();
		return true;
	}

	end(contentIndex: number): void {
		const call = this.calls.get(contentIndex);
		if (call?.timer !== undefined) clearTimeout(call.timer);
		if (call) call.timer = undefined;
	}

	complete(contentIndex: number): boolean {
		if (!this.checkDeadline(contentIndex)) return false;
		this.end(contentIndex);
		return true;
	}

	dispose(): void {
		this.disposed = true;
		for (const contentIndex of this.calls.keys()) this.end(contentIndex);
		this.calls.clear();
	}

	private checkDeadline(contentIndex: number): boolean {
		if (this.disposed) return false;
		this.start(contentIndex);
		const call = this.calls.get(contentIndex);
		const now = performance.now();
		if (call && this.limits.maxDurationMs !== undefined && now - call.startedAt >= this.limits.maxDurationMs) {
			this.fail(contentIndex, "maxDurationMs");
			return false;
		}
		if (call && now - call.lastProgressAt >= this.limits.maxIdleMs) {
			this.fail(contentIndex, "maxIdleMs");
			return false;
		}
		return true;
	}

	private checkBytes(contentIndex: number): boolean {
		const call = this.calls.get(contentIndex);
		if (call && call.bytes > this.limits.maxBytes) {
			this.fail(contentIndex, "maxBytes");
			return false;
		}
		if (this.totalBytes > this.limits.maxTotalBytes) {
			this.fail(contentIndex, "maxTotalBytes");
			return false;
		}
		return true;
	}

	private fail(contentIndex: number, limit: keyof Required<ToolArgumentLimits>): void {
		const limitValue = this.limits[limit];
		if (this.disposed || limitValue === undefined) return;
		const call = this.calls.get(contentIndex);
		const diagnostic: AssistantMessageDiagnostic = {
			type: "tool_argument_generation_limit",
			timestamp: Date.now(),
			details: {
				contentIndex,
				limit,
				limitValue,
				bytes: call?.bytes ?? 0,
				totalBytes: this.totalBytes,
				events: call?.events ?? 0,
				elapsedMs: call ? Math.max(0, performance.now() - call.startedAt) : 0,
				idleMs: call ? Math.max(0, performance.now() - call.lastProgressAt) : 0,
			},
		};
		this.dispose();
		this.onFailure({
			message: `Tool argument preparation exceeded ${limit} (${limitValue}). No tools from this response were executed. Retry explicitly or adjust toolArgumentLimits.`,
			diagnostic,
		});
	}
}

/** Stops scanning at the first byte over budget, without allocating an encoded copy. */
function utf8Bytes(text: string, limit: number): number {
	let bytes = 0;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code < 0x80) bytes++;
		else if (code < 0x800) bytes += 2;
		else if (isHighSurrogate(code) && isLowSurrogate(text.charCodeAt(index + 1))) {
			bytes += 4;
			index++;
		} else bytes += 3;
		if (bytes > limit) break;
	}
	return bytes;
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

/** Bound canonical JSON sizing without serializing a large native object into a second copy. */
function jsonBytes(value: JsonObject, limit: number): number {
	const pending: unknown[] = [value];
	let bytes = 0;
	while (pending.length > 0 && bytes <= limit) {
		const current = pending.pop();
		if (typeof current === "string") {
			bytes += quotedStringBytes(current, limit - bytes);
		} else if (current === null || current === undefined) {
			bytes += 4;
		} else if (typeof current === "boolean") {
			bytes += current ? 4 : 5;
		} else if (typeof current === "number") {
			bytes += JSON.stringify(current).length;
		} else if (Array.isArray(current)) {
			bytes += 2 + Math.max(0, current.length - 1);
			if (bytes > limit) break;
			for (let index = 0; index < current.length; index++) pending.push(current[index]);
		} else if (typeof current === "object") {
			bytes += 2;
			let first = true;
			for (const key in current) {
				if (!Object.hasOwn(current, key)) continue;
				bytes += quotedStringBytes(key, limit - bytes) + 1 + (first ? 0 : 1);
				first = false;
				if (bytes > limit) break;
				const descriptor = Object.getOwnPropertyDescriptor(current, key);
				if (!descriptor || !("value" in descriptor)) return limit + 1;
				pending.push(descriptor.value);
			}
		} else {
			// Not a JSON value. Reject rather than invoking a toJSON hook during sizing.
			return limit + 1;
		}
	}
	return bytes;
}

function quotedStringBytes(text: string, limit: number): number {
	let bytes = 2;
	for (let index = 0; index < text.length && bytes <= limit; index++) {
		const code = text.charCodeAt(index);
		if (code === 0x22 || code === 0x5c || code === 8 || code === 9 || code === 10 || code === 12 || code === 13)
			bytes += 2;
		else if (code < 0x20) bytes += 6;
		else if (code < 0x80) bytes++;
		else if (code < 0x800) bytes += 2;
		else if (isHighSurrogate(code) && isLowSurrogate(text.charCodeAt(index + 1))) {
			bytes += 4;
			index++;
		} else if (isHighSurrogate(code) || isLowSurrogate(code)) bytes += 6;
		else bytes += 3;
	}
	return bytes;
}
