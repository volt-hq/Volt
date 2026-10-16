/**
 * Read Volt's saved `openai-codex` OAuth credential without writing it back.
 *
 * The spike must preserve saved auth and fail if renewal would be required
 * (daemon-voice-design.md, "Authority and privacy"), so it never refreshes,
 * never writes `auth.json`, and never exposes the token outside the process.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Credentials that expire sooner than this are treated as needing renewal. */
const MIN_REMAINING_MS = 5 * 60 * 1000;

export interface CodexSubscriptionAuth {
	/** Bearer token; keep it out of logs, reports, errors, argv, and env. */
	readonly accessToken: string;
	readonly accountId: string;
	/** Safe to report. */
	readonly expiresInMs: number;
	readonly authPath: string;
}

export function resolveAgentDir(): string {
	const configured = process.env.VOLT_CODING_AGENT_DIR;
	if (configured && configured.length > 0) return configured;
	return join(homedir(), ".volt", "agent");
}

export function loadCodexSubscriptionAuth(now = Date.now()): CodexSubscriptionAuth {
	const authPath = join(resolveAgentDir(), "auth.json");
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(authPath, "utf8"));
	} catch (error) {
		throw new Error(
			`Cannot read Volt auth at ${authPath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const entry = (parsed as Record<string, unknown> | null)?.["openai-codex"];
	if (!entry || typeof entry !== "object") {
		throw new Error("Volt has no saved openai-codex credential; log in with Volt first (/login)");
	}
	const credential = entry as Record<string, unknown>;
	if (credential.type !== "oauth") {
		throw new Error(`The saved openai-codex credential is not an OAuth credential (type=${String(credential.type)})`);
	}
	const accessToken = credential.access;
	const accountId = credential.accountId;
	const expires = credential.expires;
	if (typeof accessToken !== "string" || accessToken.length === 0) {
		throw new Error("The saved openai-codex credential has no access token");
	}
	if (typeof accountId !== "string" || accountId.length === 0) {
		throw new Error("The saved openai-codex credential has no accountId");
	}
	if (typeof expires !== "number") {
		throw new Error("The saved openai-codex credential has no expiry");
	}
	const expiresInMs = expires - now;
	if (expiresInMs < MIN_REMAINING_MS) {
		throw new Error(
			`The saved openai-codex credential expires in ${Math.round(expiresInMs / 1000)} s; the spike does not refresh tokens. Run Volt once to renew it, then retry.`,
		);
	}
	return { accessToken, accountId, expiresInMs, authPath };
}

/** A stable digest of the auth file so the report can prove it was not modified, without exposing it. */
export function authFileFingerprint(authPath: string): { size: number; mtimeMs: number } {
	const stat = statSync(authPath);
	return { size: stat.size, mtimeMs: stat.mtimeMs };
}
