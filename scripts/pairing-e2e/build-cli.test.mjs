import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:https";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { runInNewContext } from "node:vm";
import { promisify } from "node:util";
import esbuild from "esbuild";
import { brokerOrigin, buildPairingCli, createPairingDeploymentPlugin, relayOrigin } from "./build-cli.mjs";

const directory = mkdtempSync(join(tmpdir(), "volt-e2e-build-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=Volt ephemeral build test", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", join(directory, "ca.key"), "-out", join(directory, "ca.pem")], { stdio: "ignore" });
const caPem = readFileSync(join(directory, "ca.pem"), "utf8");

async function deployment(plugins = []) {
	const result = await esbuild.build({
		entryPoints: [resolve("packages/coding-agent/src/remote/iroh-deployment.ts")],
		bundle: true,
		write: false,
		format: "cjs",
		platform: "node",
		plugins,
	});
	const context = { module: { exports: {} } };
	runInNewContext(result.outputFiles[0].text, context);
	return JSON.parse(JSON.stringify(context.module.exports.IROH_DEPLOYMENT_PROFILE));
}

test("ordinary builds retain only production/canary authority and default TLS roots", async () => {
	const profile = await deployment();
	assert.deepEqual(profile.deployments.map((entry) => entry.name), ["production", "canary"]);
	assert.equal(profile.deployments[0].credentialServiceUrl, "https://credentials.volt-cli.dev");
	assert.equal(profile.caRootsDer, undefined);
	assert.equal(profile.brokerCaPem, undefined);
});

test("explicit private build substitutes exact loopback authority and public CA only", async () => {
	const profile = await deployment([createPairingDeploymentPlugin(caPem)]);
	assert.deepEqual(profile.deployments, [{ name: "pairing-e2e", relayUrls: [relayOrigin], credentialServiceUrl: brokerOrigin }]);
	assert.equal(profile.caRootsDer.length, 1);
	assert.match(profile.brokerCaPem, /BEGIN CERTIFICATE/);
	assert.doesNotMatch(JSON.stringify(profile), /PRIVATE KEY/);
});

test("build rejects private keys, duplicate roots, and malformed certificates", () => {
	for (const value of ["invalid", `${caPem}${caPem}`, readFileSync(join(directory, "ca.key"), "utf8"), "x".repeat(24_001)]) {
		assert.throws(() => createPairingDeploymentPlugin(value));
	}
});

test("stale input without the deployment seam cannot silently build production defaults", async () => {
	await assert.rejects(esbuild.build({ stdin: { contents: "export const stale = true" }, write: false, plugins: [createPairingDeploymentPlugin(caPem)], logLevel: "silent" }), /Missing deployment module/);
});

test("private HTTPS trust survives dispatcher reconfiguration without disabling verification", async () => {
	const server = createServer({ cert: caPem, key: readFileSync(join(directory, "ca.key")) }, (_request, response) => response.end("verified"));
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const url = `https://127.0.0.1:${server.address().port}`;
		for (const privateBuild of [false, true]) {
			const result = await esbuild.build({
				stdin: { contents: `import { configureHttpDispatcher } from "./packages/coding-agent/src/core/http-dispatcher.ts";
					(async () => {
						for (const timeout of [300000, 30000]) {
							configureHttpDispatcher(timeout);
							const response = await fetch(${JSON.stringify(url)});
							if (await response.text() !== "verified") throw new Error("unexpected response");
						}
					})().catch(() => { process.exitCode = 1; });`, resolveDir: process.cwd(), loader: "ts" },
				bundle: true, write: false, platform: "node", format: "cjs", packages: "external",
				plugins: privateBuild ? [createPairingDeploymentPlugin(caPem)] : [],
			});
			const child = promisify(execFile)(process.execPath, ["-e", result.outputFiles[0].text], { timeout: 10000 });
			if (privateBuild) await child;
			else await assert.rejects(child, (error) => error.code === 1);
		}
	} finally {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
});

test("test build cannot overwrite checkout/release outputs or an existing directory", async () => {
	// The parent must exist; this guard test must also run in an unbuilt checkout.
	await assert.rejects(buildPairingCli(join(directory, "ca.pem"), "packages/coding-agent/private-test"), /outside the checkout/);
	await assert.rejects(buildPairingCli(join(directory, "ca.pem"), directory), /new directory/);
});
