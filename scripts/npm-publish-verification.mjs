import { BOOTSTRAP_VERSION, INITIAL_BETA_VERSION } from "./verify-npm-package-bootstrap.mjs";

export const NPM_PROVENANCE_PREDICATE_TYPE = "https://slsa.dev/provenance/v1";
export const NPM_PUBLISHED_METADATA_FIELDS = ["name", "version", "gitHead", "repository", "dist-tags", "dist"];
// npm accepted @hansjm10/volt-coding-agent@0.2.2 about 7 minutes before serving
// its metadata (#533); the window keeps roughly 3x margin over that.
const DEFAULT_POST_PUBLISH_VERIFICATION_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_POST_PUBLISH_VERIFICATION_DELAY_MS = 10_000;
const POST_PUBLISH_PROGRESS_INTERVAL_MS = 60_000;

// npm 11 reports these after its own fetch retries. They mean the registry
// query failed, not that the version is missing or mismatched.
export const TRANSIENT_NPM_REGISTRY_FAILURE =
	/^npm error code (?:E408|E429|E5\d\d|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ERR_SOCKET_TIMEOUT|EAI_AGAIN|EAI_FAIL|ENOTFOUND|FETCH_ERROR)$/m;

export class NpmRegistryUnavailableError extends Error {
	constructor(message) {
		super(message);
		this.name = "NpmRegistryUnavailableError";
	}
}

/** `historicalBeta` (default true) says whether the package keeps the 0.1.0 beta dist-tag. */
export function assertPublishedPackageMatchesRelease({
	name,
	version,
	directory,
	sourceCommit,
	packed,
	metadata,
	historicalBeta = true,
}) {
	if (metadata.name !== name || metadata.version !== version) {
		throw new Error(`npm returned unexpected package identity for ${name}@${version}`);
	}
	// npm provenance packages can omit gitHead. When present it must match; the
	// tarball integrity comparison below remains the authoritative byte binding.
	if (metadata.gitHead !== undefined && metadata.gitHead !== sourceCommit) {
		throw new Error(`${name}@${version} was published from git commit ${metadata.gitHead ?? "unknown"}, expected ${sourceCommit}`);
	}
	if (
		metadata.repository?.url !== "git+https://github.com/volt-hq/Volt.git" ||
		metadata.repository?.directory !== directory
	) {
		throw new Error(`${name}@${version} has unexpected repository metadata`);
	}
	if (metadata["dist-tags"]?.latest !== version) {
		throw new Error(`${name}@${version} is published but the latest dist-tag does not point to it`);
	}
	if (metadata["dist-tags"]?.bootstrap !== BOOTSTRAP_VERSION) {
		throw new Error(`${name}@${version} must keep bootstrap on the inert placeholder`);
	}
	if (historicalBeta && metadata["dist-tags"]?.beta !== INITIAL_BETA_VERSION) {
		throw new Error(`${name}@${version} must preserve the historical beta dist-tag on ${INITIAL_BETA_VERSION}`);
	}
	if (!historicalBeta && metadata["dist-tags"]?.beta !== undefined) {
		throw new Error(`${name}@${version} was added after the ${INITIAL_BETA_VERSION} beta and must have no beta dist-tag`);
	}
	if (typeof packed.integrity !== "string" || metadata.dist?.integrity !== packed.integrity) {
		throw new Error(`${name}@${version} registry tarball does not match the package built from the release tag`);
	}
	const attestations = metadata.dist?.attestations;
	if (
		typeof attestations?.url !== "string" ||
		!attestations.url.startsWith("https://registry.npmjs.org/") ||
		attestations.provenance?.predicateType !== NPM_PROVENANCE_PREDICATE_TYPE
	) {
		throw new Error(`${name}@${version} has no valid npm provenance attestation`);
	}
}

function sleepSync(milliseconds) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function verifyPublishedPackageAfterPublish(release, getMetadata, options = {}) {
	const timeoutMs = options.timeoutMs ?? DEFAULT_POST_PUBLISH_VERIFICATION_TIMEOUT_MS;
	const delayMs = options.delayMs ?? DEFAULT_POST_PUBLISH_VERIFICATION_DELAY_MS;
	const sleep = options.sleep ?? sleepSync;
	const now = options.now ?? Date.now;
	const log = options.log ?? ((message) => process.stdout.write(`${message}\n`));
	const label = `${release.name}@${release.version}`;
	const startedAt = now();
	let lastProgressAt;
	let registryError;

	while (true) {
		let metadata;
		try {
			metadata = getMetadata(release.name, release.version);
			registryError = undefined;
		} catch (error) {
			if (!(error instanceof NpmRegistryUnavailableError)) throw error;
			registryError = error;
			log(`${label} registry query failed transiently; retrying.`);
		}
		if (metadata) {
			assertPublishedPackageMatchesRelease({ ...release, metadata });
			return metadata;
		}

		const elapsedMs = now() - startedAt;
		if (elapsedMs >= timeoutMs) break;
		if (lastProgressAt === undefined) {
			log(`${label} publish accepted; waiting up to ${Math.round(timeoutMs / 60_000)} minutes for npm registry metadata to become visible...`);
			lastProgressAt = elapsedMs;
		} else if (elapsedMs - lastProgressAt >= POST_PUBLISH_PROGRESS_INTERVAL_MS) {
			log(`${label} still not visible on npm after ${Math.round(elapsedMs / 60_000)} minutes; waiting...`);
			lastProgressAt = elapsedMs;
		}
		sleep(Math.min(delayMs, timeoutMs - elapsedMs));
	}

	const minutes = Math.round((now() - startedAt) / 60_000);
	throw new Error(
		[
			`npm accepted ${label}, but its registry metadata is not visible after ${minutes} minutes.`,
			"Do not republish, move the tag, or rerun Prepare Release or Approve Release.",
			`Wait until \`npm view ${label} dist.integrity\` answers, then rerun Publish Release at v${release.version}.`,
			...(registryError ? [`Last registry query failed: ${registryError.message}`] : []),
		].join("\n"),
	);
}
