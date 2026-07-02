import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

const MAX_LOG_BYTES = 10 * 1024 * 1024;

export type DaemonLogLevel = "debug" | "info" | "warn" | "error";

export interface DaemonLogger {
	log(level: DaemonLogLevel, subsystem: string, message: string, details?: Record<string, unknown>): void;
	child(subsystem: string): (level: DaemonLogLevel, message: string, details?: Record<string, unknown>) => void;
}

export interface DaemonLoggerOptions {
	logPath: string;
	/** Also echo to stderr (foreground runs launched by hand). */
	echoToStderr?: boolean;
}

/**
 * Plain-text, greppable daemon log: `<iso8601> <level> <subsystem> <message> <json-details?>`.
 * Rotates at 10 MiB keeping exactly one rotated file (voltd.log.1).
 */
export function createDaemonLogger(options: DaemonLoggerOptions): DaemonLogger {
	mkdirSync(dirname(options.logPath), { recursive: true, mode: 0o700 });

	const rotateIfNeeded = () => {
		try {
			if (existsSync(options.logPath) && statSync(options.logPath).size >= MAX_LOG_BYTES) {
				renameSync(options.logPath, `${options.logPath}.1`);
			}
		} catch {
			// Rotation is best-effort; keep logging to the current file.
		}
	};

	const log = (level: DaemonLogLevel, subsystem: string, message: string, details?: Record<string, unknown>) => {
		const line = `${new Date().toISOString()} ${level} ${subsystem} ${message}${
			details === undefined ? "" : ` ${JSON.stringify(details)}`
		}\n`;
		try {
			rotateIfNeeded();
			appendFileSync(options.logPath, line, { mode: 0o600 });
		} catch {
			// Logging must never crash the daemon.
		}
		if (options.echoToStderr) {
			process.stderr.write(line);
		}
	};

	return {
		log,
		child(subsystem: string) {
			return (level, message, details) => log(level, subsystem, message, details);
		},
	};
}
