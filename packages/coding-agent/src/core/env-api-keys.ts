/**
 * Environment-variable credentials: which variable holds each provider's API key, and the ambient
 * credentials (Google Application Default Credentials, AWS) that authenticate a provider without one.
 * This is the only environment fallback for provider credentials; AuthStorage consults it after
 * stored credentials.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Placeholder key for providers authenticated by ambient credentials rather than an API key. */
const AMBIENT_CREDENTIALS_API_KEY = "<authenticated>";

const API_KEY_ENV_VARS: Readonly<Record<string, readonly string[]>> = {
	"github-copilot": ["COPILOT_GITHUB_TOKEN"],
	// ANTHROPIC_OAUTH_TOKEN takes precedence over ANTHROPIC_API_KEY
	anthropic: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
	"ant-ling": ["ANT_LING_API_KEY"],
	openai: ["OPENAI_API_KEY"],
	"azure-openai-responses": ["AZURE_OPENAI_API_KEY"],
	nvidia: ["NVIDIA_API_KEY"],
	deepseek: ["DEEPSEEK_API_KEY"],
	google: ["GEMINI_API_KEY"],
	"google-vertex": ["GOOGLE_CLOUD_API_KEY"],
	groq: ["GROQ_API_KEY"],
	cerebras: ["CEREBRAS_API_KEY"],
	xai: ["XAI_API_KEY"],
	openrouter: ["OPENROUTER_API_KEY"],
	"vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
	zai: ["ZAI_API_KEY"],
	"zai-coding-cn": ["ZAI_CODING_CN_API_KEY"],
	mistral: ["MISTRAL_API_KEY"],
	minimax: ["MINIMAX_API_KEY"],
	"minimax-cn": ["MINIMAX_CN_API_KEY"],
	moonshotai: ["MOONSHOT_API_KEY"],
	"moonshotai-cn": ["MOONSHOT_API_KEY"],
	huggingface: ["HF_TOKEN"],
	fireworks: ["FIREWORKS_API_KEY"],
	together: ["TOGETHER_API_KEY"],
	opencode: ["OPENCODE_API_KEY"],
	"opencode-go": ["OPENCODE_API_KEY"],
	"kimi-coding": ["KIMI_API_KEY"],
	"cloudflare-workers-ai": ["CLOUDFLARE_API_KEY"],
	"cloudflare-ai-gateway": ["CLOUDFLARE_API_KEY"],
	xiaomi: ["XIAOMI_API_KEY"],
	"xiaomi-token-plan-cn": ["XIAOMI_TOKEN_PLAN_CN_API_KEY"],
	"xiaomi-token-plan-ams": ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"],
	"xiaomi-token-plan-sgp": ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"],
};

function readEnv(name: string, env: Record<string, string> | undefined): string | undefined {
	return env?.[name] || process.env[name] || undefined;
}

function hasVertexAdcCredentials(env: Record<string, string> | undefined): boolean {
	const credentialsPath = readEnv("GOOGLE_APPLICATION_CREDENTIALS", env);
	return existsSync(credentialsPath ?? join(homedir(), ".config", "gcloud", "application_default_credentials.json"));
}

/**
 * Configured environment variables that hold an API key for a provider, in precedence order.
 *
 * Ambient credential sources such as AWS profiles, AWS IAM credentials, and Google Application
 * Default Credentials are not API key variables and are not reported.
 */
export function findEnvKeys(provider: string, env?: Record<string, string>): string[] | undefined {
	const found = API_KEY_ENV_VARS[provider]?.filter((name) => readEnv(name, env) !== undefined) ?? [];
	return found.length > 0 ? found : undefined;
}

/**
 * The API key a provider's environment variable holds, e.g. OPENAI_API_KEY, or
 * `AMBIENT_CREDENTIALS_API_KEY` when Google Vertex or Amazon Bedrock ambient credentials are configured.
 */
export function getEnvApiKey(provider: string, env?: Record<string, string>): string | undefined {
	const envKey = findEnvKeys(provider, env)?.[0];
	if (envKey) return readEnv(envKey, env);

	// Vertex AI supports either an explicit API key or Application Default Credentials
	// (`gcloud auth application-default login`) with a project and location.
	if (provider === "google-vertex") {
		const hasProject = !!(readEnv("GOOGLE_CLOUD_PROJECT", env) || readEnv("GCLOUD_PROJECT", env));
		const hasLocation = !!readEnv("GOOGLE_CLOUD_LOCATION", env);
		if (hasProject && hasLocation && hasVertexAdcCredentials(env)) return AMBIENT_CREDENTIALS_API_KEY;
	}

	// Amazon Bedrock authenticates with a named profile, IAM keys, a bearer token, ECS task
	// roles, or IRSA web identity tokens.
	if (
		provider === "amazon-bedrock" &&
		(readEnv("AWS_PROFILE", env) ||
			(readEnv("AWS_ACCESS_KEY_ID", env) && readEnv("AWS_SECRET_ACCESS_KEY", env)) ||
			readEnv("AWS_BEARER_TOKEN_BEDROCK", env) ||
			readEnv("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", env) ||
			readEnv("AWS_CONTAINER_CREDENTIALS_FULL_URI", env) ||
			readEnv("AWS_WEB_IDENTITY_TOKEN_FILE", env))
	) {
		return AMBIENT_CREDENTIALS_API_KEY;
	}

	return undefined;
}
