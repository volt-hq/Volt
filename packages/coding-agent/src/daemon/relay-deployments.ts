/**
 * The Volt-operated relay deployments and the credential service that issues
 * access for each. Endpoints bind against the production relays by default
 * ("production" mode); the n0 public relays ("development" mode) are for
 * development only and must be opted into via VOLT_IROH_RELAY_MODE=development.
 *
 * The Volt iOS app accepts only these relay/service pairs for managed relay
 * pairing, so changing them can break shipped app builds. See "iOS app
 * compatibility" in AGENTS.md.
 */
export const VOLT_PRODUCTION_RELAY_URLS = ["https://iroh-relay-us-central.volt-cli.dev"];
export const VOLT_PRODUCTION_RELAY_CREDENTIAL_SERVICE_URL = "https://credentials.volt-cli.dev";
export const VOLT_CANARY_RELAY_URLS = ["https://iroh-relay-us-central-canary.volt-cli.dev"];
export const VOLT_CANARY_RELAY_CREDENTIAL_SERVICE_URL = "https://credentials-canary.volt-cli.dev";
