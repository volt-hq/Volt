import { githubCodeHostIdentity } from "./github-identity.ts";
import type { CodeHostIdentity } from "./types.ts";

/**
 * Identity rules for every registered provider. Kept apart from the provider registry so persisted-data
 * validation (including the session-store worker) never loads provider CLIs or network transports.
 */
const identities: CodeHostIdentity[] = [githubCodeHostIdentity];

export function findCodeHostIdentity(providerId: string): CodeHostIdentity | undefined {
	return identities.find((identity) => identity.id === providerId);
}

/** Register identity rules for an additional provider. Returns a function that removes them again. */
export function registerCodeHostIdentity(identity: CodeHostIdentity): () => void {
	if (findCodeHostIdentity(identity.id)) {
		throw new Error(`Code-host provider ${JSON.stringify(identity.id)} is already registered.`);
	}
	identities.push(identity);
	return () => {
		const index = identities.indexOf(identity);
		if (index >= 0) identities.splice(index, 1);
	};
}
