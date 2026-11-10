// Keep inference and quota requests aligned. This is a protocol compatibility pin,
// not the installed Claude executable's version; do not probe or require that executable.
export const ANTHROPIC_OAUTH_USER_AGENT = "claude-cli/2.1.322 (external, cli)";
export const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";
