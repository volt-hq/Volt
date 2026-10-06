/**
 * The query registry: admission (profile, then parameters and the byte budgets
 * they annotate) and the run, for every query frame a host serves, local or
 * relayed.
 */

import { QUERY_SCHEMAS, type QueryName, type QueryParams, type QueryResult } from "@hansjm10/volt-protocol";
import type { TObject } from "typebox";
import { Compile, type Validator } from "typebox/compile";
import { type IntentContext, missingCapability } from "../intents/types.ts";
import { formatSchemaBoundError, formatSchemaError } from "../schema-errors.ts";
import type { BUILTIN_QUERIES } from "./definitions.ts";
import { type QueryDefinition, QueryRejectedError } from "./types.ts";

export type BuiltinQueryDefinitions = typeof BUILTIN_QUERIES;

export class QueryRegistry {
	private readonly load: () => BuiltinQueryDefinitions;
	private loaded: BuiltinQueryDefinitions | undefined;
	private readonly validators = new Map<QueryName, Validator>();

	/** `load` returns the definitions; the registry reads them on first use. */
	constructor(load: () => BuiltinQueryDefinitions) {
		this.load = load;
	}

	private get definitions(): BuiltinQueryDefinitions {
		if (this.loaded) return this.loaded;
		const definitions = this.load();
		for (const name of Object.keys(definitions) as QueryName[]) {
			const definition: QueryDefinition<QueryName> = definitions[name];
			if (definition.name !== name) throw new Error(`Query ${name} is defined as ${definition.name}`);
		}
		this.loaded = definitions;
		return definitions;
	}

	names(): QueryName[] {
		return Object.keys(this.definitions) as QueryName[];
	}

	get<N extends QueryName>(name: N): BuiltinQueryDefinitions[N] {
		return this.definitions[name];
	}

	has(name: string): name is QueryName {
		return Object.hasOwn(this.definitions, name);
	}

	/** Whether query `name` reads a closed child's log. */
	readsClosedLogs(name: string): boolean {
		if (!this.has(name)) return false;
		const definition: QueryDefinition<QueryName> = this.definitions[name];
		return definition.closedLogs === true;
	}

	/** Admit and run a query with typed parameters. */
	run<N extends QueryName>(ctx: IntentContext, name: N, params: QueryParams<N>): Promise<QueryResult<N>> {
		return this.runUnchecked(ctx, name, params) as Promise<QueryResult<N>>;
	}

	/** Admit and run any query by name with unchecked parameters (a wire frame). */
	runFrame(ctx: IntentContext, name: string, params: unknown): Promise<unknown> {
		if (!this.has(name)) {
			return Promise.reject(new QueryRejectedError("unknown_query", `Unknown query: ${name}`));
		}
		return this.runUnchecked(ctx, name, params);
	}

	private async runUnchecked(ctx: IntentContext, name: QueryName, params: unknown): Promise<unknown> {
		const definition: QueryDefinition<QueryName> = this.definitions[name];
		const admitted = this.admit(ctx, name, params);
		if (definition.scope === "conversation" && !ctx.target && !(definition.closedLogs && ctx.closedLog)) {
			throw new QueryRejectedError("unavailable", `${name} needs a conversation`);
		}
		return definition.run(ctx, admitted as never);
	}

	/**
	 * The profile's admission of query `name` and its parameters, before
	 * anything is read: throws {@link QueryRejectedError} when refused, and
	 * returns the admitted parameters.
	 */
	admit(ctx: Pick<IntentContext, "profile">, name: QueryName, params: unknown): unknown {
		const definition: QueryDefinition<QueryName> = this.definitions[name];
		if (ctx.profile.name === "remote") {
			if (definition.remote !== "safe") {
				throw new QueryRejectedError("not_allowed", `Query not available over remote host: ${name}`);
			}
			const missing = missingCapability(ctx.profile.grant, definition.requires);
			if (missing !== undefined) {
				throw new QueryRejectedError("not_allowed", `Remote capability required: ${missing}`, {
					requiredCapability: missing,
				});
			}
		}
		const admitted = params ?? {};
		const validator = this.validator(name);
		const schema = QUERY_SCHEMAS[name].params as TObject;
		const invalid = validator.Check(admitted)
			? formatSchemaBoundError(schema, admitted)
			: formatSchemaError(schema, validator.Errors(admitted));
		if (invalid !== undefined)
			throw new QueryRejectedError("invalid_input", `Invalid ${name} parameters: ${invalid}`);
		return admitted;
	}

	private validator(name: QueryName): Validator {
		let validator = this.validators.get(name);
		if (validator === undefined) {
			validator = Compile(QUERY_SCHEMAS[name].params);
			this.validators.set(name, validator);
		}
		return validator;
	}
}
