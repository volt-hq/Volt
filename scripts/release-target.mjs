import { spawnSync } from "node:child_process";

export const BUMP_TYPES = new Set(["major", "minor", "patch"]);

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function isReleaseTarget(target) {
	return typeof target === "string" && (BUMP_TYPES.has(target) || SEMVER_RE.test(target));
}

function compareVersions(a, b) {
	const aParts = a.split(".").map(Number);
	const bParts = b.split(".").map(Number);

	for (let i = 0; i < 3; i++) {
		const diff = (aParts[i] || 0) - (bParts[i] || 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

export function planReleaseTarget(target, currentVersion) {
	if (!isReleaseTarget(target)) {
		throw new Error(`Invalid release target: ${String(target)}`);
	}
	if (!SEMVER_RE.test(currentVersion)) {
		throw new Error(`Current package version is not canonical semver: ${currentVersion}`);
	}
	if (BUMP_TYPES.has(target)) {
		return { type: "bump", value: target };
	}

	const comparison = compareVersions(target, currentVersion);
	if (comparison < 0) {
		throw new Error(`explicit version ${target} must not be lower than current version ${currentVersion}`);
	}
	if (comparison === 0) {
		if (target !== "0.1.0") {
			throw new Error("releasing the current version is reserved for the one-time 0.1.0 bootstrap release");
		}
		return { type: "current", value: target };
	}
	return { type: "set", value: target };
}

export function getPlannedReleaseVersion(target, currentVersion) {
	const plan = planReleaseTarget(target, currentVersion);
	if (plan.type !== "bump") return plan.value;

	const [major, minor, patch] = currentVersion.split(".").map(BigInt);
	switch (plan.value) {
		case "major":
			return `${major + 1n}.0.0`;
		case "minor":
			return `${major}.${minor + 1n}.0`;
		case "patch":
			return `${major}.${minor}.${patch + 1n}`;
	}
}

function commandFailure(command, args, result) {
	const detail = result.error?.message || result.stderr?.trim() || `exit code ${result.status ?? "unknown"}`;
	return new Error(`failed to run ${[command, ...args].join(" ")}: ${detail}`);
}

export function assertReleaseTagAvailable(version, run = spawnSync) {
	const tag = `v${version}`;
	const ref = `refs/tags/${tag}`;
	const localArgs = ["show-ref", "--verify", "--quiet", ref];
	const local = run("git", localArgs, { encoding: "utf8" });
	if (local.status === 0) {
		throw new Error(`release tag already exists locally: ${tag}. Refusing to rerun this release.`);
	}
	if (local.status !== 1) {
		throw commandFailure("git", localArgs, local);
	}

	const remoteArgs = ["ls-remote", "--exit-code", "--tags", "origin", ref];
	const remote = run("git", remoteArgs, { encoding: "utf8" });
	if (remote.status === 0) {
		throw new Error(`release tag already exists on origin: ${tag}. Refusing to rerun this release.`);
	}
	if (remote.status !== 2) {
		throw commandFailure("git", remoteArgs, remote);
	}
}
