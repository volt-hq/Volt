import { readFileSync } from "node:fs";

const INITIAL_PROCESS_ENV: NodeJS.ProcessEnv = { ...process.env };

function readLinuxProcessEnv(): NodeJS.ProcessEnv | undefined {
	try {
		const data = readFileSync("/proc/self/environ", "utf-8");
		const env: NodeJS.ProcessEnv = {};
		for (const entry of data.split("\0")) {
			const idx = entry.indexOf("=");
			if (idx > 0) {
				env[entry.slice(0, idx)] = entry.slice(idx + 1);
			}
		}
		return Object.keys(env).length > 0 ? env : undefined;
	} catch {
		return undefined;
	}
}

export function getSubprocessEnv(): NodeJS.ProcessEnv {
	if (Object.keys(process.env).length > 0) {
		return process.env;
	}
	if (process.platform === "linux") {
		const env = readLinuxProcessEnv();
		if (env) {
			return env;
		}
	}
	return INITIAL_PROCESS_ENV;
}
