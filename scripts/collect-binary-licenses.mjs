#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const overrideConfigPath = join(repoRoot, "compliance", "npm-license-overrides.json");
const LICENSE_FILE_PATTERN = /^(?:licen[cs]e|copying|copyright|notice)(?:$|[._-])/i;

function parseArgs(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (!["--metafile", "--out", "--manifest"].includes(argument)) {
			throw new Error(`Unknown argument: ${argument}`);
		}
		const value = argv[index + 1];
		if (!value || value.startsWith("--")) {
			throw new Error(`${argument} requires a value`);
		}
		options[argument.slice(2)] = resolve(value);
		index += 1;
	}
	for (const required of ["metafile", "out", "manifest"]) {
		if (!options[required]) throw new Error(`Missing --${required}`);
	}
	return options;
}

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function isPathInside(parent, child) {
	const path = relative(parent, child);
	return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function canonicalProspectivePath(path) {
	let existingAncestor = path;
	const missingParts = [];
	while (!existsSync(existingAncestor)) {
		const parent = dirname(existingAncestor);
		if (parent === existingAncestor) throw new Error(`Cannot resolve output path: ${path}`);
		missingParts.unshift(existingAncestor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
		existingAncestor = parent;
	}
	return resolve(realpathSync(existingAncestor), ...missingParts);
}

function validateOutputPaths(outputDirectory, manifestPath) {
	if (existsSync(outputDirectory) && lstatSync(outputDirectory).isSymbolicLink()) {
		throw new Error(`Refusing symlink license output directory: ${outputDirectory}`);
	}
	if (existsSync(manifestPath) && lstatSync(manifestPath).isSymbolicLink()) {
		throw new Error(`Refusing symlink license manifest: ${manifestPath}`);
	}
	const safeOutput = canonicalProspectivePath(outputDirectory);
	const safeManifest = canonicalProspectivePath(manifestPath);
	const manifestDirectory = dirname(safeManifest);
	const licenseDirectory = dirname(safeOutput);
	if (
		basename(safeOutput) !== "npm" ||
		basename(licenseDirectory) !== "LICENSES" ||
		dirname(licenseDirectory) !== manifestDirectory ||
		basename(safeManifest) !== "binary-license-manifest.json"
	) {
		throw new Error(
			"License output must be the owned LICENSES/npm directory beside binary-license-manifest.json",
		);
	}
	if (safeOutput === sep || safeOutput === manifestDirectory || !isPathInside(manifestDirectory, safeOutput)) {
		throw new Error("License output directory must be a child of the manifest directory");
	}
	if (safeOutput === repoRoot || isPathInside(safeOutput, repoRoot)) {
		throw new Error(`Refusing license output directory that contains the repository: ${safeOutput}`);
	}
	if (isPathInside(safeOutput, safeManifest)) {
		throw new Error("License manifest must not be inside the removable license output directory");
	}
	return { outputDirectory: safeOutput, manifestPath: safeManifest };
}

function packageRootFromInput(input) {
	const normalized = input.replaceAll("\\", "/");
	const marker = "node_modules/";
	const markerIndex = normalized.lastIndexOf(marker);
	if (markerIndex === -1) return undefined;
	const prefix = normalized.slice(0, markerIndex + marker.length);
	const parts = normalized.slice(markerIndex + marker.length).split("/");
	if (!parts[0]) return undefined;
	const packageName = parts[0].startsWith("@") ? `${parts[0]}/${parts[1] ?? ""}` : parts[0];
	if (packageName.endsWith("/")) return undefined;
	return {
		packageName,
		root: resolve(repoRoot, prefix, ...packageName.split("/")),
	};
}

function packageLicenseFiles(packageRoot) {
	const realPackageRoot = realpathSync(packageRoot);
	return readdirSync(packageRoot)
		.filter((name) => LICENSE_FILE_PATTERN.test(name))
		.map((name) => join(packageRoot, name))
		.filter((path) => {
			const stat = lstatSync(path);
			if (stat.isSymbolicLink() || !stat.isFile()) return false;
			return isPathInside(realPackageRoot, realpathSync(path));
		})
		.map((path) => ({ path, source: null }))
		.sort((a, b) => a.path.localeCompare(b.path));
}

function loadLicenseOverrides() {
	const config = JSON.parse(readFileSync(overrideConfigPath, "utf8"));
	if (config.schemaVersion !== 1 || !config.packages || typeof config.packages !== "object") {
		throw new Error(`Invalid license override configuration: ${overrideConfigPath}`);
	}
	const overrides = new Map();
	for (const [identity, entries] of Object.entries(config.packages)) {
		if (!Array.isArray(entries) || entries.length === 0) {
			throw new Error(`License override must contain at least one file: ${identity}`);
		}
		const licenseFiles = entries.map((entry) => {
			if (
				!entry ||
				typeof entry.path !== "string" ||
				typeof entry.source !== "string" ||
				typeof entry.sha256 !== "string"
			) {
				throw new Error(`Invalid license override entry: ${identity}`);
			}
			const path = resolve(repoRoot, entry.path);
			if (!isPathInside(repoRoot, path) || !existsSync(path) || !statSync(path).isFile()) {
				throw new Error(`License override is missing or escapes the repository: ${entry.path}`);
			}
			const actualSha256 = sha256(readFileSync(path));
			if (actualSha256 !== entry.sha256) {
				throw new Error(
					`License override checksum mismatch for ${identity}: expected ${entry.sha256}, got ${actualSha256}`,
				);
			}
			return { path, source: entry.source };
		});
		overrides.set(identity, licenseFiles);
	}
	return overrides;
}

function safePackageDirectory(name, version) {
	return `${name.replaceAll("/", "__").replaceAll("@", "")}-${version}`;
}

export function collectBinaryLicenses({ metafilePath, outputDirectory, manifestPath }) {
	({ outputDirectory, manifestPath } = validateOutputPaths(outputDirectory, manifestPath));
	const metafileBytes = readFileSync(metafilePath);
	const metafile = JSON.parse(metafileBytes.toString("utf8"));
	const inputs = Object.keys(metafile.inputs ?? {}).sort((a, b) => a.localeCompare(b));
	const packagesByIdentity = new Map();
	const missingLicenses = new Set();
	const licenseOverrides = loadLicenseOverrides();

	for (const input of inputs) {
		const packageLocation = packageRootFromInput(input);
		if (!packageLocation) continue;
		const packageJsonPath = join(packageLocation.root, "package.json");
		if (!existsSync(packageJsonPath)) {
			throw new Error(`Bundled npm input has no package.json: ${input}`);
		}
		const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
		if (packageJson.name !== packageLocation.packageName || typeof packageJson.version !== "string") {
			throw new Error(`Invalid package identity for bundled input: ${input}`);
		}
		const identity = `${packageJson.name}@${packageJson.version}`;
		const existing = packagesByIdentity.get(identity);
		if (existing) {
			existing.inputs += 1;
			continue;
		}
		const licenseFiles = packageLicenseFiles(packageLocation.root);
		if (licenseFiles.length === 0) {
			const overrides = licenseOverrides.get(identity);
			if (!overrides) {
				missingLicenses.add(identity);
				continue;
			}
			licenseFiles.push(...overrides);
		}
		packagesByIdentity.set(identity, {
			name: packageJson.name,
			version: packageJson.version,
			declaredLicense: packageJson.license ?? packageJson.licenses ?? null,
			inputs: 1,
			licenseFiles,
		});
	}
	if (missingLicenses.size > 0) {
		throw new Error(
			`Bundled npm packages have no authoritative license file:\n${[...missingLicenses]
				.sort((a, b) => a.localeCompare(b))
				.map((identity) => `- ${identity}`)
				.join("\n")}`,
		);
	}

	rmSync(outputDirectory, { recursive: true, force: true });
	mkdirSync(outputDirectory, { recursive: true, mode: 0o755 });
	const packages = [];
	for (const packageRecord of [...packagesByIdentity.values()].sort((a, b) =>
		`${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
	)) {
		const packageDirectory = safePackageDirectory(packageRecord.name, packageRecord.version);
		const destinationDirectory = join(outputDirectory, packageDirectory);
		mkdirSync(destinationDirectory, { recursive: true, mode: 0o755 });
		const copiedLicenses = packageRecord.licenseFiles.map(({ path: sourcePath, source }) => {
			const name = sourcePath.slice(sourcePath.lastIndexOf(sep) + 1);
			const destination = join(destinationDirectory, name);
			cpSync(sourcePath, destination, { dereference: true });
			const bytes = readFileSync(destination);
			return {
				path: relative(dirname(manifestPath), destination).replaceAll("\\", "/"),
				sha256: sha256(bytes),
				size: statSync(destination).size,
				...(source ? { source } : {}),
			};
		});
		packages.push({
			name: packageRecord.name,
			version: packageRecord.version,
			declaredLicense: packageRecord.declaredLicense,
			bundledInputCount: packageRecord.inputs,
			licenseFiles: copiedLicenses,
		});
	}

	const manifest = {
		schemaVersion: 1,
		metafileSha256: sha256(metafileBytes),
		bundledInputCount: inputs.length,
		npmPackageCount: packages.length,
		packages,
	};
	mkdirSync(dirname(manifestPath), { recursive: true, mode: 0o755 });
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
	return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const options = parseArgs(process.argv.slice(2));
		const manifest = collectBinaryLicenses({
			metafilePath: options.metafile,
			outputDirectory: options.out,
			manifestPath: options.manifest,
		});
		console.log(`Collected ${manifest.npmPackageCount} bundled npm package license sets.`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
