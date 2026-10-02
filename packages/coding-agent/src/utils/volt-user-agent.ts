export function getVoltUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `volt/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}
