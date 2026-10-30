import {
	AZURE_DEVOPS_PROVIDER_ID,
	azureDevOpsPullRequestUrl,
	azureDevOpsRepositoryNameOf,
	parseAzureDevOpsPullRequestUrl,
} from "./azure-devops-remote.ts";
import type { CodeHostIdentity } from "./types.ts";

export const azureDevOpsCodeHostIdentity: CodeHostIdentity = {
	id: AZURE_DEVOPS_PROVIDER_ID,
	displayName: "Azure DevOps",
	parsePullRequestUrl(url) {
		const locator = parseAzureDevOpsPullRequestUrl(url);
		return locator && { url: locator.url, number: locator.number };
	},
	pullRequestUrl(repository, number) {
		const name = azureDevOpsRepositoryNameOf({
			providerId: AZURE_DEVOPS_PROVIDER_ID,
			host: repository.host,
			path: repository.path,
			canonicalId: `${AZURE_DEVOPS_PROVIDER_ID}:${repository.host}/${repository.path}`,
		});
		const locator = name && parseAzureDevOpsPullRequestUrl(azureDevOpsPullRequestUrl(name, number));
		return locator?.number === number ? locator.url : undefined;
	},
	// Azure DevOps does not resolve pull request checkouts (review worktrees) yet, so it produced no persisted one.
	isCanonicalPullRequestCheckout: () => false,
};
