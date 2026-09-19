/** Build-owned relay authority. Runtime settings cannot add managed deployments. */
export interface IrohDeployment {
	name: string;
	relayUrls: string[];
	credentialServiceUrl: string;
}

export interface IrohDeploymentProfile {
	deployments: IrohDeployment[];
	/** Private deployment builds replace this module; ordinary builds use default TLS roots. */
	caRootsDer?: number[][];
	brokerCaPem?: string;
}

export const VOLT_PRODUCTION_RELAY_URLS = ["https://iroh-relay-us-central.volt-cli.dev"];
export const VOLT_PRODUCTION_RELAY_CREDENTIAL_SERVICE_URL = "https://credentials.volt-cli.dev";
export const VOLT_CANARY_RELAY_URLS = ["https://iroh-relay-us-central-canary.volt-cli.dev"];
export const VOLT_CANARY_RELAY_CREDENTIAL_SERVICE_URL = "https://credentials-canary.volt-cli.dev";

export const IROH_DEPLOYMENT_PROFILE: IrohDeploymentProfile = {
	deployments: [
		{
			name: "production",
			relayUrls: VOLT_PRODUCTION_RELAY_URLS,
			credentialServiceUrl: VOLT_PRODUCTION_RELAY_CREDENTIAL_SERVICE_URL,
		},
		{
			name: "canary",
			relayUrls: VOLT_CANARY_RELAY_URLS,
			credentialServiceUrl: VOLT_CANARY_RELAY_CREDENTIAL_SERVICE_URL,
		},
	],
};
