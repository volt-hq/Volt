import { afterEach, describe, expect, it } from "vitest";
import { findEnvKeys, getEnvApiKey } from "../src/core/env-api-keys.ts";

const originalCopilotGitHubToken = process.env.COPILOT_GITHUB_TOKEN;
const originalGhToken = process.env.GH_TOKEN;
const originalGitHubToken = process.env.GITHUB_TOKEN;
const originalZaiCodingCnApiKey = process.env.ZAI_CODING_CN_API_KEY;
const originalTogetherApiKey = process.env.TOGETHER_API_KEY;
const originalFireworksApiKey = process.env.FIREWORKS_API_KEY;

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
	} else {
		process.env[name] = value;
	}
}

afterEach(() => {
	if (originalCopilotGitHubToken === undefined) {
		delete process.env.COPILOT_GITHUB_TOKEN;
	} else {
		process.env.COPILOT_GITHUB_TOKEN = originalCopilotGitHubToken;
	}

	if (originalGhToken === undefined) {
		delete process.env.GH_TOKEN;
	} else {
		process.env.GH_TOKEN = originalGhToken;
	}

	if (originalGitHubToken === undefined) {
		delete process.env.GITHUB_TOKEN;
	} else {
		process.env.GITHUB_TOKEN = originalGitHubToken;
	}

	if (originalZaiCodingCnApiKey === undefined) {
		delete process.env.ZAI_CODING_CN_API_KEY;
	} else {
		process.env.ZAI_CODING_CN_API_KEY = originalZaiCodingCnApiKey;
	}

	restoreEnv("TOGETHER_API_KEY", originalTogetherApiKey);
	restoreEnv("FIREWORKS_API_KEY", originalFireworksApiKey);
});

describe("environment API keys", () => {
	it("does not treat generic GitHub tokens as GitHub Copilot credentials", () => {
		delete process.env.COPILOT_GITHUB_TOKEN;
		process.env.GH_TOKEN = "gh-token";
		process.env.GITHUB_TOKEN = "github-token";

		expect(findEnvKeys("github-copilot")).toBeUndefined();
		expect(getEnvApiKey("github-copilot")).toBeUndefined();
	});

	it("resolves GitHub Copilot credentials from COPILOT_GITHUB_TOKEN", () => {
		process.env.COPILOT_GITHUB_TOKEN = "copilot-token";
		process.env.GH_TOKEN = "gh-token";
		process.env.GITHUB_TOKEN = "github-token";

		expect(findEnvKeys("github-copilot")).toEqual(["COPILOT_GITHUB_TOKEN"]);
		expect(getEnvApiKey("github-copilot")).toBe("copilot-token");
	});

	it("resolves ZAI China Coding Plan credentials from ZAI_CODING_CN_API_KEY", () => {
		process.env.ZAI_CODING_CN_API_KEY = "zai-coding-cn-token";

		expect(findEnvKeys("zai-coding-cn")).toEqual(["ZAI_CODING_CN_API_KEY"]);
		expect(getEnvApiKey("zai-coding-cn")).toBe("zai-coding-cn-token");
	});

	it("resolves TOGETHER_API_KEY from the environment", () => {
		process.env.TOGETHER_API_KEY = "test-together-key";

		expect(findEnvKeys("together")).toEqual(["TOGETHER_API_KEY"]);
		expect(getEnvApiKey("together")).toBe("test-together-key");
	});

	it("resolves FIREWORKS_API_KEY from the environment", () => {
		process.env.FIREWORKS_API_KEY = "test-fireworks-key";

		expect(findEnvKeys("fireworks")).toEqual(["FIREWORKS_API_KEY"]);
		expect(getEnvApiKey("fireworks")).toBe("test-fireworks-key");
	});

	it("prefers scoped values over the process environment", () => {
		process.env.TOGETHER_API_KEY = "process-key";

		expect(getEnvApiKey("together", { TOGETHER_API_KEY: "scoped-key" })).toBe("scoped-key");
	});

	it("reports ambient Amazon Bedrock credentials without an API key variable", () => {
		const env = { AWS_ACCESS_KEY_ID: "id", AWS_SECRET_ACCESS_KEY: "secret" };

		expect(findEnvKeys("amazon-bedrock", env)).toBeUndefined();
		expect(getEnvApiKey("amazon-bedrock", env)).toBe("<authenticated>");
	});
});
