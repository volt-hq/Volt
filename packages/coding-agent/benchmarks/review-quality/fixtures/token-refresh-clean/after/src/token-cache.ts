export interface CachedToken {
	value: string;
	expiresAt: number;
}

export function getUsableToken(token: CachedToken, now: number, refreshSkewMs = 30_000): string | undefined {
	if (token.expiresAt - refreshSkewMs <= now) {
		return undefined;
	}
	return token.value;
}
