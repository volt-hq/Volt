#!/usr/bin/env node

// Deliberately separate from all release entrypoints. Outputs are private, local test artifacts.
import { X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import {
	VOLT_CANARY_RELAY_CREDENTIAL_SERVICE_URL,
	VOLT_CANARY_RELAY_URLS,
	VOLT_PRODUCTION_RELAY_CREDENTIAL_SERVICE_URL,
	VOLT_PRODUCTION_RELAY_URLS,
} from "../../packages/coding-agent/src/remote/iroh-deployment.ts";

const repoRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
export const brokerOrigin = "https://127.0.0.1:18443";
export const relayOrigin = "https://127.0.0.1:19443";

export function createPairingDeploymentPlugin(caPem) {
	if (typeof caPem !== "string" || Buffer.byteLength(caPem) > 24_000 || caPem.includes("PRIVATE KEY")) {
		throw new Error("Expected one public CA certificate, not private key material");
	}
	if (!/^\s*-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/.test(caPem)) {
		throw new Error("Expected exactly one PEM certificate");
	}
	const certificate = new X509Certificate(caPem);
	if (
		!certificate.ca ||
		certificate.raw.length > 16_384 ||
		!certificate.verify(certificate.publicKey) ||
		Date.parse(certificate.validFrom) > Date.now() ||
		Date.parse(certificate.validTo) <= Date.now()
	) {
		throw new Error("Expected a currently valid self-signed test CA");
	}
	const exports = {
		VOLT_CANARY_RELAY_CREDENTIAL_SERVICE_URL,
		VOLT_CANARY_RELAY_URLS,
		VOLT_PRODUCTION_RELAY_CREDENTIAL_SERVICE_URL,
		VOLT_PRODUCTION_RELAY_URLS,
		IROH_DEPLOYMENT_PROFILE: {
			deployments: [{ name: "pairing-e2e", relayUrls: [relayOrigin], credentialServiceUrl: brokerOrigin }],
			caRootsDer: [Array.from(certificate.raw)],
			brokerCaPem: certificate.toString(),
		},
	};
	return {
		name: "volt-private-pairing-deployment",
		setup(build) {
			let substituted = false;
			build.onLoad({ filter: /[/\\]remote[/\\]iroh-deployment\.(?:ts|js)$/ }, () => {
				substituted = true;
				return {
					contents: Object.entries(exports).map(([name, value]) => `export const ${name} = ${JSON.stringify(value)};`).join("\n"),
					loader: "js",
				};
			});
			build.onEnd(() => {
				if (!substituted) return { errors: [{ text: "Missing deployment module: rebuild source before producing test artifacts" }] };
			});
		},
	};
}

export async function buildPairingCli(caPath, outputPath) {
	const output = resolve(outputPath);
	const parent = realpathSync(dirname(output));
	const fromRepo = relative(repoRoot, parent);
	if (fromRepo !== ".." && !fromRepo.startsWith("../") && !isAbsolute(fromRepo)) {
		throw new Error("Test artifacts must be outside the checkout and release output directories");
	}
	if (existsSync(output)) throw new Error("Test output must be a new directory");
	const caPem = readFileSync(caPath, "utf8");
	const plugin = createPairingDeploymentPlugin(caPem);
	const root = join(repoRoot, "packages/coding-agent");
	mkdirSync(output, { mode: 0o700 });
	await esbuild.build({
		absWorkingDir: repoRoot,
		entryPoints: [
			{ in: join(root, "dist/cli.js"), out: "cli" },
			{ in: join(root, "dist/utils/image-resize-worker.js"), out: "image-resize-worker" },
			{ in: join(root, "dist/core/session-store/worker.js"), out: "session-store-worker" },
			{ in: join(repoRoot, "packages/ai/dist/providers/amazon-bedrock.js"), out: "amazon-bedrock" },
		],
		outdir: output,
		bundle: true,
		splitting: true,
		platform: "node",
		format: "esm",
		target: "node22",
		tsconfigRaw: { compilerOptions: {} },
		legalComments: "none",
		banner: { js: 'import { createRequire as __voltCreateRequire } from "node:module"; const require = __voltCreateRequire(import.meta.url);' },
		define: { __VOLT_BUNDLED_CLI__: "true", __VOLT_STANDALONE__: "false" },
		external: ["@hansjm10/volt-tui", "@hansjm10/volt-tui/*", "@hansjm10/volt-iroh", "@hansjm10/volt-iroh/*", "bufferutil", "supports-color", "utf-8-validate"],
		plugins: [plugin],
	});
	chmodSync(join(output, "cli.js"), 0o755);
	writeFileSync(join(output, "package.json"), `${JSON.stringify({ private: true, type: "module", voltBuildProfile: "pairing-e2e" }, null, 2)}\n`);
	writeFileSync(join(output, "pairing-e2e-artifact.json"), `${JSON.stringify({ profile: "pairing-e2e", publishable: false, brokerOrigin, relayOrigin, caSha256: new X509Certificate(caPem).fingerprint256 }, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.argv.length !== 4) throw new Error("Usage: node scripts/pairing-e2e/build-cli.mjs <public-ca.pem> <new-output-directory>");
	await buildPairingCli(process.argv[2], process.argv[3]);
}
