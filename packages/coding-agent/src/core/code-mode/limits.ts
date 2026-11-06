/**
 * Limits for code mode scripts. The defaults follow section 5.18 of docs/code-mode-design.md; they are
 * fixed in code, and callers override them only in tests.
 */

const KIB = 1024;
const MIB = 1024 * KIB;

/** Limits that apply to one script. */
export interface CodeModeScriptLimits {
	/** Time the script may spend executing inside its VM. Waits on nested calls do not count. */
	computeBudgetMs: number;
	/** Nested-call attempts per script. The next attempt terminates the script. */
	callBudget: number;
	/** Time between asking a VM to stop and terminating its worker. */
	graceMs: number;
	/** Time the host waits for in-flight nested calls to settle after a script ends. */
	drainMs: number;
	/** Encoded arguments of one nested call, in UTF-8 bytes. */
	maxArgumentBytes: number;
	/** Encoded arguments of all unfinished nested calls of a script, in UTF-8 bytes. */
	maxOutstandingArgumentBytes: number;
	/** Encoded script value of one nested call, in UTF-8 bytes. */
	maxScriptValueBytes: number;
	/** Message of a `ToolCallError`, in UTF-8 bytes. */
	maxErrorMessageBytes: number;
	/** A message from the worker that carries a value, in UTF-8 bytes. */
	maxFrameBytes: number;
	/** Output text the host retains for one script, in characters. */
	maxRetainedOutputChars: number;
	/** Output items the host retains for one script. */
	maxOutputItems: number;
	/** Unhandled rejections reported per script. */
	maxReportedRejections: number;
}

export const DEFAULT_CODE_MODE_SCRIPT_LIMITS: Readonly<CodeModeScriptLimits> = Object.freeze({
	computeBudgetMs: 30_000,
	callBudget: 200,
	graceMs: 250,
	drainMs: 1_000,
	maxArgumentBytes: 1 * MIB,
	maxOutstandingArgumentBytes: 16 * MIB,
	maxScriptValueBytes: 1 * MIB,
	maxErrorMessageBytes: 8 * KIB,
	maxFrameBytes: 8 * MIB,
	maxRetainedOutputChars: 16 * MIB,
	maxOutputItems: 100_000,
	maxReportedRejections: 10,
});

/** Limits that apply to the worker pool of one process. */
export interface CodeModePoolOptions {
	/** Workers per process; each runs at most one script at a time. */
	maxWorkers: number;
	/** Scripts that may wait for a worker before new scripts fail without starting. */
	maxQueuedScripts: number;
	/** Time an idle worker is kept before it is stopped. */
	idleTimeoutMs: number;
	/** Memory limit of each VM, in bytes. */
	memoryLimitBytes: number;
	/**
	 * Native stack of each worker thread, in megabytes. QuickJS's stack guard does not see the native stack
	 * that WebAssembly frames use, so it must be deep enough for the guard to fire first (section 5.4).
	 */
	workerStackSizeMb: number;
}

export const DEFAULT_CODE_MODE_POOL_OPTIONS: Readonly<CodeModePoolOptions> = Object.freeze({
	maxWorkers: 4,
	maxQueuedScripts: 4,
	idleTimeoutMs: 5 * 60_000,
	memoryLimitBytes: 64 * MIB,
	workerStackSizeMb: 32,
});

/** The longest wall-clock timeout a script may request. */
export const MAX_CODE_MODE_SCRIPT_TIMEOUT_MS = 30 * 60_000;

/** Nesting depth of values crossing the bridge. */
export const MAX_BRIDGE_JSON_DEPTH = 64;

/** Length of a binding name, in characters. */
export const MAX_BINDING_NAME_LENGTH = 256;

/** Length of an image reference a script passes to `image()`, in characters. */
export const MAX_IMAGE_REF_LENGTH = 64;

/** Length of the error block a script failure reports, in characters, truncation marker included. */
export const MAX_SCRIPT_ERROR_CHARS = 8 * KIB;

/** Length of a thrown error's one-line name, in characters, truncation marker included. */
export const MAX_SCRIPT_ERROR_NAME_CHARS = 128;

/** Length of a thrown error's one-line summary, in characters, truncation marker included. */
export const MAX_SCRIPT_ERROR_SUMMARY_CHARS = 1024;
