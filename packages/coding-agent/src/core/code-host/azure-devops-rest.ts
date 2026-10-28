import { Buffer } from "node:buffer";
import type { ChildProcess } from "node:child_process";
import { spawnProcess } from "../../utils/child-process.ts";
import { terminateProcessTree } from "../../utils/shell.ts";
import { AZURE_DEVOPS_HOST } from "./azure-devops-remote.ts";

/** Microsoft Entra resource id of Azure DevOps: the audience of the tokens its REST API accepts. */
const AZURE_DEVOPS_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";
const DEFAULT_API_VERSION = "7.1";
const DEFAULT_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const AZURE_CLI_TIMEOUT_MS = 30_000;
const AZURE_CLI_OUTPUT_MAX_BYTES = 64 * 1024;
/** A cached Azure CLI token is renewed this long before it expires. */
const TOKEN_RENEWAL_MARGIN_MS = 5 * 60_000;
/** Lifetime assumed for an Azure CLI token that reports no expiry. */
const TOKEN_DEFAULT_LIFETIME_MS = 10 * 60_000;
/** Personal access token variables, in precedence order. */
const PAT_VARIABLES = ["VOLT_ADO_PAT", "AZURE_DEVOPS_EXT_PAT"] as const;

export const AZURE_DEVOPS_REQUEST_CANCELLED = "Azure DevOps request was cancelled.";

export type AzureDevOpsFailure =
	| "no-credentials"
	| "access-denied"
	| "not-found"
	| "rate-limited"
	| "timeout"
	| "network"
	| "output-limit"
	| "invalid-response"
	| "http-error";

export type AzureDevOpsResponse = { ok: true; value: unknown } | { ok: false; failure: AzureDevOpsFailure };

export interface AzureDevOpsRequest {
	organization: string;
	/** Path under the organization: `/`-prefixed, with its segments already percent-encoded. */
	path: string;
	query?: Readonly<Record<string, string>>;
	apiVersion?: string;
	signal?: AbortSignal;
	maxBytes?: number;
	timeoutMs?: number;
}

interface AzureCliToken {
	authorization: string;
	expiresAt: number;
}

let azureCliToken: AzureCliToken | undefined;
let pendingAzureCliToken: Promise<AzureCliToken | undefined> | undefined;

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Bounded `az` output, or undefined when it cannot run, fails, or runs too long; stderr is never kept. */
function runAzureCli(args: string[]): Promise<string | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		let failed = false;
		const chunks: Buffer[] = [];
		let bytes = 0;
		const finish = (output: string | undefined): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolve(output);
		};
		let child: ChildProcess;
		try {
			child = spawnProcess("az", args, {
				stdio: ["ignore", "pipe", "ignore"],
				env: { ...process.env, AZURE_CORE_NO_COLOR: "true", AZURE_CORE_ONLY_SHOW_ERRORS: "true" },
			});
		} catch {
			resolve(undefined);
			return;
		}
		const terminate = (): void => {
			failed = true;
			if (child.pid) void terminateProcessTree(child.pid);
			else child.kill();
		};
		const timeout = setTimeout(terminate, AZURE_CLI_TIMEOUT_MS);
		timeout.unref?.();
		child.stdout?.on("data", (chunk: Buffer) => {
			if (failed) return;
			bytes += chunk.length;
			if (bytes > AZURE_CLI_OUTPUT_MAX_BYTES) terminate();
			else chunks.push(chunk);
		});
		child.once("error", () => finish(undefined));
		child.once("close", (code) =>
			finish(!failed && code === 0 ? Buffer.concat(chunks, bytes).toString("utf8") : undefined),
		);
	});
}

async function readAzureCliToken(): Promise<AzureCliToken | undefined> {
	const output = await runAzureCli([
		"account",
		"get-access-token",
		"--resource",
		AZURE_DEVOPS_RESOURCE,
		"--output",
		"json",
		"--only-show-errors",
	]);
	if (output === undefined) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(output);
	} catch {
		return undefined;
	}
	if (
		!isRecord(value) ||
		typeof value.accessToken !== "string" ||
		!/^[A-Za-z0-9._~+/=-]{1,16384}$/.test(value.accessToken)
	) {
		return undefined;
	}
	const expiresOn = Number(value.expires_on);
	return {
		authorization: `Bearer ${value.accessToken}`,
		expiresAt:
			Number.isSafeInteger(expiresOn) && expiresOn > 0 ? expiresOn * 1000 : Date.now() + TOKEN_DEFAULT_LIFETIME_MS,
	};
}

/** A personal access token from the environment, else the signed-in Azure CLI account's token. */
async function authorization(): Promise<string | undefined> {
	for (const variable of PAT_VARIABLES) {
		const token = process.env[variable]?.trim();
		if (!token) continue;
		return /^[\x21-\x7e]+$/.test(token) ? `Basic ${Buffer.from(`:${token}`, "utf8").toString("base64")}` : undefined;
	}
	if (azureCliToken && azureCliToken.expiresAt - TOKEN_RENEWAL_MARGIN_MS > Date.now()) {
		return azureCliToken.authorization;
	}
	// One `az` run serves concurrent requests; it is not tied to any one caller's cancellation.
	pendingAzureCliToken ??= readAzureCliToken().finally(() => {
		pendingAzureCliToken = undefined;
	});
	const token = await pendingAzureCliToken;
	if (token) azureCliToken = token;
	return token?.authorization;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	return new Promise((resolve, reject) => {
		const onAbort = (): void => reject(new Error(AZURE_DEVOPS_REQUEST_CANCELLED));
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

function statusFailure(response: Response): AzureDevOpsFailure | undefined {
	// 203 is the interactive sign-in page Azure DevOps serves for credentials it does not accept.
	if (response.status === 401 || response.status === 403 || response.status === 203) return "access-denied";
	if (response.status === 404) return "not-found";
	if (response.status === 429) return "rate-limited";
	if (!response.ok) return "http-error";
	return /^application\/json\b/i.test(response.headers.get("content-type") ?? "") ? undefined : "invalid-response";
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Buffer | undefined> {
	const reader = response.body?.getReader();
	if (!reader) return Buffer.alloc(0);
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) return Buffer.concat(chunks, bytes);
		bytes += value.byteLength;
		if (bytes > maxBytes) {
			await reader.cancel().catch(() => {});
			return undefined;
		}
		chunks.push(value);
	}
}

/** One read-only Azure DevOps Services REST request. Throws only when `signal` cancels it. */
export async function requestAzureDevOps(request: AzureDevOpsRequest): Promise<AzureDevOpsResponse> {
	const { signal } = request;
	if (signal?.aborted) throw new Error(AZURE_DEVOPS_REQUEST_CANCELLED);
	const url = new URL(`https://${AZURE_DEVOPS_HOST}/${encodeURIComponent(request.organization)}${request.path}`);
	for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.set(key, value);
	url.searchParams.set("api-version", request.apiVersion ?? DEFAULT_API_VERSION);
	const credentials = await abortable(authorization(), signal);
	if (!credentials) return { ok: false, failure: "no-credentials" };
	const timeout = AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	try {
		const response = await fetch(url, {
			headers: {
				Accept: "application/json",
				Authorization: credentials,
				// Answer 401 instead of redirecting to an interactive sign-in page.
				"X-TFS-FedAuthRedirect": "Suppress",
			},
			redirect: "error",
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
		const failure = statusFailure(response);
		if (failure) {
			await response.body?.cancel().catch(() => {});
			return { ok: false, failure };
		}
		const body = await readBoundedBody(response, request.maxBytes ?? DEFAULT_RESPONSE_MAX_BYTES);
		if (!body) return { ok: false, failure: "output-limit" };
		try {
			return { ok: true, value: JSON.parse(body.toString("utf8")) as unknown };
		} catch {
			return { ok: false, failure: "invalid-response" };
		}
	} catch {
		if (signal?.aborted) throw new Error(AZURE_DEVOPS_REQUEST_CANCELLED);
		return { ok: false, failure: timeout.aborted ? "timeout" : "network" };
	}
}

export function azureDevOpsFailureMessage(failure: AzureDevOpsFailure): string {
	switch (failure) {
		case "no-credentials":
			return "No Azure DevOps credentials are available on the host. Set AZURE_DEVOPS_EXT_PAT or VOLT_ADO_PAT to a personal access token, or sign in with `az login`, then retry.";
		case "access-denied":
			return "Azure DevOps denied access. Check that the host's personal access token or Azure CLI account can read the repository, then retry.";
		case "not-found":
			return "Azure DevOps did not find the repository or pull request, or the host's credentials cannot read it.";
		case "rate-limited":
			return "Azure DevOps is limiting requests. Wait, then retry.";
		case "timeout":
			return "Azure DevOps did not respond in time. Check connectivity on the host, then retry.";
		case "network":
			return "Could not reach Azure DevOps. Check connectivity and proxy settings on the host, then retry.";
		case "output-limit":
			return "An Azure DevOps response exceeded its size limit.";
		case "invalid-response":
			return "Azure DevOps returned an unexpected response.";
		case "http-error":
			return "Azure DevOps rejected the request.";
	}
}
