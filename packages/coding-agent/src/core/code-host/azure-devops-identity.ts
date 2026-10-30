import { AZURE_DEVOPS_PROVIDER_ID, parseAzureDevOpsPullRequestUrl } from "./azure-devops-remote.ts";
import type { CodeHostIdentity } from "./types.ts";

export const azureDevOpsCodeHostIdentity: CodeHostIdentity = {
	id: AZURE_DEVOPS_PROVIDER_ID,
	displayName: "Azure DevOps",
	parsePullRequestUrl(url) {
		const locator = parseAzureDevOpsPullRequestUrl(url);
		return locator && { url: locator.url, number: locator.number };
	},
	// Azure DevOps does not resolve pull request checkouts (review worktrees) yet, so it produced no persisted one.
	isCanonicalPullRequestCheckout: () => false,
};
