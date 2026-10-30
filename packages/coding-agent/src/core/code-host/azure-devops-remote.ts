import type { CanonicalCodeHostRepository } from "./types.ts";

export const AZURE_DEVOPS_PROVIDER_ID = "azure-devops";
/** Canonical host of every Azure DevOps Services repository, whichever remote URL form names it. */
export const AZURE_DEVOPS_HOST = "dev.azure.com";

/** An Azure DevOps Services repository by its organization, project, and repository names. */
export interface AzureDevOpsRepositoryName {
	organization: string;
	project: string;
	repository: string;
}

export interface AzureDevOpsPullRequestLocator {
	/** Normalized web URL. */
	url: string;
	number: number;
	repository: AzureDevOpsRepositoryName;
}

// Organization names: letters, digits, and inner hyphens, at most 50 characters.
const ORGANIZATION_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,48}[A-Za-z0-9])?$/;
const NAME_MAX_CHARS = 100;
const URL_MAX_CHARS = 2_000;

function decodedName(value: string | undefined): string | undefined {
	if (!value) return undefined;
	let decoded: string;
	try {
		decoded = decodeURIComponent(value);
	} catch {
		return undefined;
	}
	if (
		!decoded ||
		decoded.length > NAME_MAX_CHARS ||
		decoded !== decoded.trim() ||
		decoded === "." ||
		decoded === ".." ||
		/[\u0000-\u001f\u007f/\\]/u.test(decoded)
	) {
		return undefined;
	}
	return decoded;
}

function repositoryName(
	organization: string | undefined,
	project: string | undefined,
	repository: string | undefined,
): AzureDevOpsRepositoryName | undefined {
	const name = {
		organization: decodedName(organization),
		project: decodedName(project),
		repository: decodedName(repository),
	};
	if (!name.organization || !ORGANIZATION_PATTERN.test(name.organization) || !name.project || !name.repository) {
		return undefined;
	}
	return { organization: name.organization, project: name.project, repository: name.repository };
}

/** A user name is not a credential, but only the organization (HTTPS) or `git` (SSH) is an ordinary clone URL. */
function acceptsUser(
	user: string | undefined,
	name: AzureDevOpsRepositoryName | undefined,
	allowGit: boolean,
): AzureDevOpsRepositoryName | undefined {
	if (!name || !user) return name;
	const normalized = user.toLowerCase();
	return normalized === name.organization.toLowerCase() || (allowGit && normalized === "git") ? name : undefined;
}

function sshRepository(
	user: string | undefined,
	host: string,
	segments: string[],
): AzureDevOpsRepositoryName | undefined {
	if (host !== "ssh.dev.azure.com" && host !== "vs-ssh.visualstudio.com") return undefined;
	if (segments.length !== 4 || segments[0] !== "v3") return undefined;
	return acceptsUser(user, repositoryName(segments[1], segments[2], segments[3]), true);
}

/**
 * Parse a credential-free Azure DevOps Services remote: HTTPS `{org}/{project}/_git/{repo}` on dev.azure.com
 * or `{org}.visualstudio.com` (optionally under `DefaultCollection`), or SSH `v3/{org}/{project}/{repo}`.
 */
export function parseAzureDevOpsRemoteUrl(value: string): AzureDevOpsRepositoryName | undefined {
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > URL_MAX_CHARS || /[\u0000-\u001f\u007f]/u.test(trimmed)) return undefined;

	const scp = /^(?:([^@:/]+)@)?([^@:/]+):(v3\/.*)$/.exec(trimmed);
	if (scp?.[2] && scp[3]) return sshRepository(scp[1], scp[2].toLowerCase(), scp[3].split("/"));

	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return undefined;
	}
	if (url.password || url.search || url.hash) return undefined;
	const host = url.hostname.toLowerCase();
	const segments = url.pathname.slice(1).split("/");
	if (url.protocol === "ssh:") {
		if (url.port && url.port !== "22") return undefined;
		return sshRepository(url.username || undefined, host, segments);
	}
	if (url.protocol !== "https:" || url.port) return undefined;
	if (host === AZURE_DEVOPS_HOST) {
		if (segments.length !== 4 || segments[2] !== "_git") return undefined;
		return acceptsUser(url.username || undefined, repositoryName(segments[0], segments[1], segments[3]), false);
	}
	const organization = /^([a-z0-9-]+)\.visualstudio\.com$/.exec(host)?.[1];
	if (!organization || organization === "vs-ssh") return undefined;
	const path = segments[0]?.toLowerCase() === "defaultcollection" ? segments.slice(1) : segments;
	if (path.length !== 3 || path[1] !== "_git") return undefined;
	return acceptsUser(url.username || undefined, repositoryName(organization, path[0], path[2]), false);
}

export function canonicalAzureDevOpsRepository(name: AzureDevOpsRepositoryName): CanonicalCodeHostRepository {
	const path = `${name.organization}/${name.project}/${name.repository}`.toLowerCase();
	return Object.freeze({
		providerId: AZURE_DEVOPS_PROVIDER_ID,
		host: AZURE_DEVOPS_HOST,
		path,
		canonicalId: `${AZURE_DEVOPS_PROVIDER_ID}:${AZURE_DEVOPS_HOST}/${path}`,
	});
}

export function canonicalizeAzureDevOpsRemoteUrl(value: string): CanonicalCodeHostRepository | null {
	const name = parseAzureDevOpsRemoteUrl(value);
	return name ? canonicalAzureDevOpsRepository(name) : null;
}

/** The names a canonical Azure DevOps repository path holds, normalized to lower case. */
export function azureDevOpsRepositoryNameOf(
	repository: CanonicalCodeHostRepository,
): AzureDevOpsRepositoryName | undefined {
	if (repository.providerId !== AZURE_DEVOPS_PROVIDER_ID || repository.host !== AZURE_DEVOPS_HOST) return undefined;
	const [organization, project, name, ...rest] = repository.path.split("/");
	if (rest.length > 0) return undefined;
	return repositoryName(
		organization && encodeURIComponent(organization),
		project && encodeURIComponent(project),
		name && encodeURIComponent(name),
	);
}

export function azureDevOpsPullRequestUrl(name: AzureDevOpsRepositoryName, number: number): string {
	return `https://${AZURE_DEVOPS_HOST}/${encodeURIComponent(name.organization)}/${encodeURIComponent(name.project)}/_git/${encodeURIComponent(name.repository)}/pullrequest/${number}`;
}

/** Parse a pull request web URL: `https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{id}`. */
export function parseAzureDevOpsPullRequestUrl(value: string): AzureDevOpsPullRequestLocator | undefined {
	if (value.length > URL_MAX_CHARS || /[\s\\\u0000-\u001f\u007f]/u.test(value)) return undefined;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return undefined;
	}
	const segments = url.pathname.slice(1).split("/");
	const number = Number(segments[5]);
	if (
		url.protocol !== "https:" ||
		url.hostname !== AZURE_DEVOPS_HOST ||
		url.port ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		segments.length !== 6 ||
		segments[2] !== "_git" ||
		segments[4] !== "pullrequest" ||
		!/^[1-9]\d*$/.test(segments[5] ?? "") ||
		!Number.isSafeInteger(number)
	) {
		return undefined;
	}
	const repository = repositoryName(segments[0], segments[1], segments[3]);
	if (!repository) return undefined;
	return { url: azureDevOpsPullRequestUrl(repository, number), number, repository };
}
