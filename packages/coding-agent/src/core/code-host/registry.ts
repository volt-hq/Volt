import { azureDevOpsCodeHostProvider } from "./azure-devops-provider.ts";
import { githubCliCodeHostProvider } from "./github-cli-provider.ts";
import { registerCodeHostIdentity } from "./identity.ts";
import { discoverPullRequest } from "./pull-request-discovery.ts";
import {
	REVIEW_TARGET_CANCELLED,
	type ReviewTargetFailure,
	readReviewRemoteUrls,
	reviewTargetFailure,
	selectCurrentReviewRemote,
	selectNumberedReviewRemote,
} from "./review-remote.ts";
import type {
	CodeHostProvider,
	CodeHostPullRequestDiscoveryProvider,
	CodeHostPullRequestStatusProvider,
	ReviewCodeHostContextCaptureOptions,
} from "./types.ts";

/**
 * Resolution order: the first provider that accepts every URL of the selected remote serves the review.
 * Built-in identity rules are listed separately in identity.ts; keep both lists in step.
 */
const providers: CodeHostProvider[] = [githubCliCodeHostProvider, azureDevOpsCodeHostProvider];

/** Add a code-host provider and its identity rules after the built-ins. Returns a function that removes both. */
export function registerCodeHostProvider(provider: CodeHostProvider): () => void {
	if (providers.some((candidate) => candidate.id === provider.id)) {
		throw new Error(`Code-host provider ${JSON.stringify(provider.id)} is already registered.`);
	}
	const unregisterIdentity = registerCodeHostIdentity(provider);
	providers.push(provider);
	return () => {
		const index = providers.indexOf(provider);
		if (index >= 0) providers.splice(index, 1);
		unregisterIdentity();
	};
}

export function findCodeHostProvider(providerId: string): CodeHostProvider | undefined {
	return providers.find((provider) => provider.id === providerId);
}

export function getCodeHostProvider(providerId: string): CodeHostProvider {
	const provider = findCodeHostProvider(providerId);
	if (!provider) throw new Error(`Unsupported code-host provider: ${JSON.stringify(providerId)}.`);
	return provider;
}

export type ResolveCodeHostProviderOptions = Pick<ReviewCodeHostContextCaptureOptions, "cwd" | "number" | "signal">;

export type ResolveCodeHostProviderResult = { ok: true; provider: CodeHostProvider } | ReviewTargetFailure;

/**
 * Select the provider for a PR review from the same remote the provider will resolve:
 * the tracked upstream for the current PR, or the tracking remote/origin/single remote for a number.
 */
export async function resolveCodeHostProvider(
	options: ResolveCodeHostProviderOptions,
): Promise<ResolveCodeHostProviderResult> {
	try {
		const selected = options.number
			? await selectNumberedReviewRemote(options)
			: await selectCurrentReviewRemote(options);
		if (!selected.ok) return selected;
		const urls = await readReviewRemoteUrls(selected.remote, options);
		if (!Array.isArray(urls)) return urls;
		if (urls.length === 0) {
			return reviewTargetFailure(
				"The review remote does not identify one repository. Configure one unambiguous repository on the host.",
			);
		}
		const provider = providers.find((candidate) =>
			urls.every((url) => candidate.canonicalizeRemoteUrl(url) !== null),
		);
		if (provider) return { ok: true, provider };
		const supported = providers.map((candidate) => candidate.displayName).join(" or ");
		return reviewTargetFailure(
			`The review remote is not a supported credential-free ${supported} URL. Check its configuration on the host.`,
		);
	} catch {
		if (options.signal?.aborted) throw new Error(REVIEW_TARGET_CANCELLED);
		return reviewTargetFailure(
			options.number
				? "Could not resolve the numbered PR repository safely. Check Git configuration on the host and retry."
				: "Could not resolve the current pull request safely. Check Git tracking configuration on the host, then retry.",
		);
	}
}

/** Change discovery across the registered providers: the one that recognizes the head repository lists its PRs. */
export const codeHostPullRequestDiscoveryProvider: CodeHostPullRequestDiscoveryProvider = {
	id: "code-host",
	discoverPullRequest: (request) => discoverPullRequest(request, providers),
};

/** Status refresh for every registered provider that supports change association. */
export function listCodeHostPullRequestStatusProviders(): CodeHostPullRequestStatusProvider[] {
	return providers.flatMap((provider) => {
		const refresh = provider.refreshPullRequestStatuses;
		return refresh ? [{ id: provider.id, refreshPullRequestStatuses: refresh.bind(provider) }] : [];
	});
}
