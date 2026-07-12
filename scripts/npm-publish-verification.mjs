import { BOOTSTRAP_VERSION } from "./verify-npm-package-bootstrap.mjs";

export const NPM_PROVENANCE_PREDICATE_TYPE = "https://slsa.dev/provenance/v1";
export const NPM_PUBLISHED_METADATA_FIELDS = ["name", "version", "gitHead", "repository", "dist-tags", "dist"];

export function assertPublishedPackageMatchesRelease({
	name,
	version,
	directory,
	sourceCommit,
	packed,
	metadata,
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
		metadata.repository?.url !== "git+https://github.com/hansjm10/Volt.git" ||
		metadata.repository?.directory !== directory
	) {
		throw new Error(`${name}@${version} has unexpected repository metadata`);
	}
	if (metadata["dist-tags"]?.beta !== version) {
		throw new Error(`${name}@${version} is published but the beta dist-tag does not point to it`);
	}
	if (
		metadata["dist-tags"]?.bootstrap !== BOOTSTRAP_VERSION ||
		metadata["dist-tags"]?.latest !== BOOTSTRAP_VERSION
	) {
		throw new Error(`${name}@${version} must keep bootstrap and latest on the inert placeholder`);
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
