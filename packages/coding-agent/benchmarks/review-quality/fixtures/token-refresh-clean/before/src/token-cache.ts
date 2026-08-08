export interface CachedToken {
	value: string;
	expiresAt: number;
}

export function getUsableToken(token: CachedToken, now: number): string | undefined {
	if (token.expiresAt <= now) {
		return undefined;
	}
	return token.value;
}
