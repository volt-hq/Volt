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
const ERROR_RESPONSE_MAX_BYTES = 64 * 1024;
const ERROR_MESSAGE_MAX_CHARS = 500;
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

export type AzureDevOpsResponse =
	| { ok: true; value: unknown }
	| {
			ok: false;
			failure: AzureDevOpsFailure;
			/** The reason Azure DevOps gave for refusing a request with a client error, bounded. */
			message?: string;
	  };

export interface AzureDevOpsRequest {
	organization: string;
	/** Path under the organization: `/`-prefixed, with its segments already percent-encoded. */
	path: string;
	query?: Readonly<Record<string, string>>;
	/** JSON request body: a request with one is a POST. */
	body?: unknown;
	apiVersion?: string;
	signal?: AbortSignal;
	maxBytes?: number;
	timeoutMs?: number;
}

interface AzureCliToken {
	authorization: string;
	expiresAt: number;
}

interface Credentials {
	authorization: string;
	/** The personal access token the authorization carries; absent for the Azure CLI account's token. */
	personalAccessToken?: string;
}

let azureCliToken: AzureCliToken | undefined;
let pendingAzureCliToken: Promise<AzureCliToken | undefined> | undefined;
/**
 * Personal access tokens an organization did not accept as a credential, by lowercase organization name: not sent
 * to that organization again. Other organizations, such as the one a token was created for, still receive it.
 */
const refusedPersonalAccessTokens = new Map<string, string>();

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

/** The environment's personal access token, by variable precedence; undefined when none is set. */
function personalAccessToken(): string | undefined {
	for (const variable of PAT_VARIABLES) {
		const token = process.env[variable]?.trim();
		if (token) return token;
	}
	return undefined;
}

/** The signed-in Azure CLI account's token, cached until shortly before it expires. */
async function azureCliAuthorization(): Promise<string | undefined> {
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

/**
 * The environment's personal access token unless the organization refused it, else the Azure CLI account's token.
 * A token no header can carry is reported missing rather than replaced.
 */
async function credentials(organization: string): Promise<Credentials | undefined> {
	const token = personalAccessToken();
	if (token !== undefined && !/^[\x21-\x7e]+$/.test(token)) return undefined;
	if (token !== undefined && refusedPersonalAccessTokens.get(organization.toLowerCase()) !== token) {
		return {
			authorization: `Basic ${Buffer.from(`:${token}`, "utf8").toString("base64")}`,
			personalAccessToken: token,
		};
	}
	const authorization = await azureCliAuthorization();
	return authorization === undefined ? undefined : { authorization };
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

/** The `message` of an Azure DevOps error response, bounded; undefined when it has none. */
async function errorMessage(response: Response): Promise<string | undefined> {
	if (!/^application\/json\b/i.test(response.headers.get("content-type") ?? "")) return undefined;
	const body = await readBoundedBody(response, ERROR_RESPONSE_MAX_BYTES).catch(() => undefined);
	if (!body) return undefined;
	try {
		const value = JSON.parse(body.toString("utf8")) as unknown;
		const message = isRecord(value) && typeof value.message === "string" ? value.message : undefined;
		const text = message?.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
		return text ? text.slice(0, ERROR_MESSAGE_MAX_CHARS) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Whether the organization refuses the token as a credential, rather than one request the token may not make: the
 * organization's connection data, which any token it accepts can read, is refused to it too.
 */
async function organizationRefusesToken(
	organization: string,
	authorization: string,
	timeoutMs: number,
	signal: AbortSignal | undefined,
): Promise<boolean> {
	const timeout = AbortSignal.timeout(timeoutMs);
	try {
		const response = await fetch(
			new URL(`https://${AZURE_DEVOPS_HOST}/${encodeURIComponent(organization)}/_apis/connectionData`),
			{
				headers: { Accept: "application/json", Authorization: authorization, "X-TFS-FedAuthRedirect": "Suppress" },
				redirect: "error",
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			},
		);
		await response.body?.cancel().catch(() => {});
		return response.status === 401 || response.status === 203;
	} catch {
		if (signal?.aborted) throw new Error(AZURE_DEVOPS_REQUEST_CANCELLED);
		// Without an answer the token is kept: at worst the organization refuses it again.
		return false;
	}
}

/** One Azure DevOps Services REST request. Throws only when `signal` cancels it. */
export async function requestAzureDevOps(request: AzureDevOpsRequest): Promise<AzureDevOpsResponse> {
	const { signal } = request;
	if (signal?.aborted) throw new Error(AZURE_DEVOPS_REQUEST_CANCELLED);
	const url = new URL(`https://${AZURE_DEVOPS_HOST}/${encodeURIComponent(request.organization)}${request.path}`);
	for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.set(key, value);
	url.searchParams.set("api-version", request.apiVersion ?? DEFAULT_API_VERSION);
	const first = await abortable(credentials(request.organization), signal);
	if (!first) {
		// A personal access token the organization refused, with no Azure CLI account to use instead, is denied access.
		const token = personalAccessToken();
		return {
			ok: false,
			failure:
				token !== undefined && token === refusedPersonalAccessTokens.get(request.organization.toLowerCase())
					? "access-denied"
					: "no-credentials",
		};
	}
	const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const send = (authorization: string, deadline: AbortSignal): Promise<Response> =>
		fetch(url, {
			...(request.body === undefined ? {} : { method: "POST", body: JSON.stringify(request.body) }),
			headers: {
				Accept: "application/json",
				Authorization: authorization,
				...(request.body === undefined ? {} : { "Content-Type": "application/json" }),
				// Answer 401 instead of redirecting to an interactive sign-in page.
				"X-TFS-FedAuthRedirect": "Suppress",
			},
			redirect: "error",
			signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
		});
	// Each send has its own deadline, so getting the Azure CLI account's token does not use up the retry's.
	let timeout = AbortSignal.timeout(timeoutMs);
	try {
		let response = await send(first.authorization, timeout);
		if (first.personalAccessToken !== undefined && statusFailure(response) === "access-denied") {
			// The request was refused before it took effect, so the Azure CLI account sends it again. A 403 refuses
			// this request only. A 401 or the sign-in page can also refuse a token that only may not make this
			// request, so the token is set aside for the organization only when the organization refuses it outright.
			await response.body?.cancel().catch(() => {});
			if (
				response.status !== 403 &&
				(await organizationRefusesToken(request.organization, first.authorization, timeoutMs, signal))
			) {
				refusedPersonalAccessTokens.set(request.organization.toLowerCase(), first.personalAccessToken);
			}
			const fallback = await abortable(azureCliAuthorization(), signal);
			if (fallback !== undefined) {
				timeout = AbortSignal.timeout(timeoutMs);
				response = await send(fallback, timeout);
			}
		}
		const failure = statusFailure(response);
		if (failure) {
			const message =
				failure === "http-error" && response.status >= 400 && response.status < 500
					? await errorMessage(response)
					: undefined;
			await response.body?.cancel().catch(() => {});
			return { ok: false, failure, ...(message === undefined ? {} : { message }) };
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
