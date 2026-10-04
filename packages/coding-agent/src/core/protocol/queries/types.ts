/**
 * The host side of protocol queries (RFC §6.1): reads of what is not in a
 * conversation log. A definition says which profiles may run it and what it
 * reads; queries share the intent context (target, services, profile).
 */

import type { QueryErrorCode, QueryName, QueryParams, QueryResult, RemoteCapability } from "@hansjm10/volt-protocol";
import type { IntentContext } from "../intents/types.ts";

export interface QueryDefinition<N extends QueryName> {
	readonly name: N;
	/** `conversation` queries read one conversation; `host` queries read the host. */
	readonly scope: "conversation" | "host";
	/** Whether a remote profile may run it at all. */
	readonly remote: "safe" | "unsafe";
	/** The remote capabilities a run needs. */
	readonly requires: readonly RemoteCapability[];
	run(ctx: IntentContext, params: QueryParams<N>): Promise<QueryResult<N>>;
}

export function defineQuery<N extends QueryName>(definition: QueryDefinition<N>): QueryDefinition<N> {
	return definition;
}

export class QueryRejectedError extends Error {
	readonly code: QueryErrorCode;
	readonly requiredCapability?: RemoteCapability;

	constructor(code: QueryErrorCode, message: string, details: { requiredCapability?: RemoteCapability } = {}) {
		super(message);
		this.name = "QueryRejectedError";
		this.code = code;
		if (details.requiredCapability !== undefined) this.requiredCapability = details.requiredCapability;
	}
}
