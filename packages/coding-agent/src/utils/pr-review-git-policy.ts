import { devNull } from "node:os";

export const PR_REVIEW_GIT_CONFIG_ARGS = ["config", "--null", "--list", "--name-only"];

/**
 * Both phases load normal system/global/repository configuration, never injected
 * config or repository selectors. Only preparation retains transport credentials
 * and environment; local validation keeps configuration lookup paths, not transport.
 */
export function getPrReviewGitEnvironment(mode: "local" | "transport"): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = mode === "transport" ? { ...process.env } : {};
	if (mode === "local") {
		for (const key of ["PATH", "SystemRoot", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "XDG_CONFIG_HOME"]) {
			if (process.env[key] !== undefined) env[key] = process.env[key];
		}
	}
	for (const key of Object.keys(env)) {
		if (
			/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CEILING_DIRECTORIES|CONFIG(?:_.*)?|TRACE.*)$/.test(
				key,
			)
		)
			delete env[key];
	}
	Object.assign(env, {
		GIT_TERMINAL_PROMPT: "0",
		GIT_OPTIONAL_LOCKS: "0",
		GIT_PAGER: "cat",
		GIT_LFS_SKIP_SMUDGE: "1",
		GIT_NO_REPLACE_OBJECTS: "1",
		GIT_NO_LAZY_FETCH: "1",
		LC_ALL: "C",
	});
	if (mode === "local") env.GIT_ALLOW_PROTOCOL = "";
	return env;
}

/** Disable executable configuration from every loaded scope before running Git. */
export function getPrReviewGitArgs(args: readonly string[], configKeys = ""): string[] {
	const overrides = ["--no-pager", "-c", `core.hooksPath=${devNull}`, "-c", "core.fsmonitor=false"];
	for (const key of configKeys.split("\0")) {
		if (!/^filter\..*\.(clean|smudge|process|required)$/s.test(key)) continue;
		if (!/^filter\.[^\s=\x00-\x1f]+\.(clean|smudge|process|required)$/.test(key)) {
			throw new Error("Invalid checkout filter configuration.");
		}
		overrides.push("-c", `${key}=${key.endsWith(".required") ? "false" : ""}`);
	}
	return [...overrides, ...args];
}
