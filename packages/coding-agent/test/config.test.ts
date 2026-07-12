import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { delimiter, join } from "path";
import { afterEach, describe, expect, test } from "vitest";
import {
	detectInstallMethod,
	getPackageSourceOrDistDir,
	getSelfUpdateCommand,
	getSelfUpdateUnavailableInstruction,
	getUpdateInstruction,
	VERSION,
} from "../src/config.ts";

const execPathDescriptor = Object.getOwnPropertyDescriptor(process, "execPath");
const pathEnvKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
const originalPath = process.env[pathEnvKey];
const originalVoltPackageDir = process.env.VOLT_PACKAGE_DIR;
const originalArgv1 = process.argv[1];
let tempDir: string | undefined;

function setExecPath(value: string): void {
	Object.defineProperty(process, "execPath", {
		value,
		configurable: true,
	});
}

afterEach(() => {
	if (execPathDescriptor) {
		Object.defineProperty(process, "execPath", execPathDescriptor);
	}
	if (originalPath === undefined) {
		delete process.env[pathEnvKey];
	} else {
		process.env[pathEnvKey] = originalPath;
	}
	if (originalVoltPackageDir === undefined) {
		delete process.env.VOLT_PACKAGE_DIR;
	} else {
		process.env.VOLT_PACKAGE_DIR = originalVoltPackageDir;
	}
	if (originalArgv1 === undefined) {
		process.argv.splice(1, 1);
	} else {
		process.argv[1] = originalArgv1;
	}
	if (tempDir) {
		chmodSync(tempDir, 0o700);
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function createNpmPrefixInstall(template = "volt-prefix-"): { prefix: string; packageDir: string } {
	const prefix = mkdtempSync(join(tmpdir(), template));
	const root = join(prefix, "lib", "node_modules");
	const scopeDir = join(root, "@hansjm10");
	const packageDir = join(scopeDir, "volt-coding-agent");
	mkdirSync(packageDir, { recursive: true });
	tempDir = prefix;
	process.env.VOLT_PACKAGE_DIR = packageDir;
	setExecPath(join(packageDir, "dist", "cli.js"));
	return { prefix, packageDir };
}

function createPnpmGlobalInstall(): { root: string; packageDir: string } {
	const temp = mkdtempSync(join(tmpdir(), "volt-pnpm-"));
	const binDir = join(temp, "bin");
	const root = join(temp, "pnpm", "global", "5", "node_modules");
	const packageDir = join(root, "@hansjm10", "volt-coding-agent");
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	writeFileSync(join(binDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm"), createFakePnpmScript(root));
	chmodSync(join(binDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm"), 0o755);
	tempDir = temp;
	process.env[pathEnvKey] = `${binDir}${delimiter}${originalPath ?? ""}`;
	process.env.VOLT_PACKAGE_DIR = packageDir;
	setExecPath(
		join(
			root,
			".pnpm",
			"@hansjm10+volt-coding-agent@0.0.0",
			"node_modules",
			"@hansjm10",
			"volt-coding-agent",
			"dist",
			"cli.js",
		),
	);
	return { root, packageDir };
}

function createYarnGlobalInstall(): { globalDir: string; packageDir: string } {
	const temp = mkdtempSync(join(tmpdir(), "volt-yarn-"));
	const binDir = join(temp, "bin");
	const globalDir = join(temp, "yarn", "global");
	const packageDir = join(globalDir, "node_modules", "@hansjm10", "volt-coding-agent");
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	writeFileSync(join(binDir, process.platform === "win32" ? "yarn.cmd" : "yarn"), createFakeYarnScript(globalDir));
	chmodSync(join(binDir, process.platform === "win32" ? "yarn.cmd" : "yarn"), 0o755);
	tempDir = temp;
	process.env[pathEnvKey] = `${binDir}${delimiter}${originalPath ?? ""}`;
	process.env.VOLT_PACKAGE_DIR = packageDir;
	setExecPath(join(globalDir, ".yarn", "@hansjm10", "volt-coding-agent", "dist", "cli.js"));
	return { globalDir, packageDir };
}

function createBunGlobalInstall(): { packageDir: string } {
	const temp = mkdtempSync(join(tmpdir(), "volt-bun-"));
	const prefix = join(temp, ".bun");
	const bunBin = join(prefix, "bin");
	const root = join(prefix, "install", "global", "node_modules");
	const scopeDir = join(root, "@hansjm10");
	const packageDir = join(scopeDir, "volt-coding-agent");
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(bunBin, { recursive: true });
	writeFileSync(join(bunBin, process.platform === "win32" ? "bun.cmd" : "bun"), createFakeBunScript(bunBin));
	chmodSync(join(bunBin, process.platform === "win32" ? "bun.cmd" : "bun"), 0o755);
	tempDir = temp;
	process.env[pathEnvKey] = `${bunBin}${delimiter}${originalPath ?? ""}`;
	process.env.VOLT_PACKAGE_DIR = packageDir;
	setExecPath(join(packageDir, "dist", "cli.js"));
	return { packageDir };
}

function createFakePnpmScript(root: string): string {
	if (process.platform === "win32") {
		return `@echo off\r\nif "%1"=="root" if "%2"=="-g" echo ${root}\r\n`;
	}
	const escapedRoot = root.replaceAll("'", "'\\''");
	return `#!/bin/sh\nif [ "$1" = "root" ] && [ "$2" = "-g" ]; then\n\tprintf '%s\\n' '${escapedRoot}'\n\texit 0\nfi\nexit 1\n`;
}

function createFakeYarnScript(globalDir: string): string {
	if (process.platform === "win32") {
		return `@echo off\r\nif "%1"=="global" if "%2"=="dir" echo ${globalDir}\r\n`;
	}
	const escapedGlobalDir = globalDir.replaceAll("'", "'\\''");
	return `#!/bin/sh\nif [ "$1" = "global" ] && [ "$2" = "dir" ]; then\n\tprintf '%s\\n' '${escapedGlobalDir}'\n\texit 0\nfi\nexit 1\n`;
}

function createFakeBunScript(bunBin: string): string {
	if (process.platform === "win32") {
		return `@echo off\r\nif "%1"=="pm" if "%2"=="bin" if "%3"=="-g" echo ${bunBin}\r\n`;
	}
	const escapedBunBin = bunBin.replaceAll("'", "'\\''");
	return `#!/bin/sh\nif [ "$1" = "pm" ] && [ "$2" = "bin" ] && [ "$3" = "-g" ]; then\n\tprintf '%s\\n' '${escapedBunBin}'\n\texit 0\nfi\nexit 1\n`;
}

describe("package asset paths", () => {
	test("resolves package assets from the runtime dist directory in linked source checkouts", () => {
		const packageDir = mkdtempSync(join(tmpdir(), "volt-linked-package-"));
		tempDir = packageDir;
		mkdirSync(join(packageDir, "src"), { recursive: true });
		mkdirSync(join(packageDir, "dist"), { recursive: true });

		expect(getPackageSourceOrDistDir(packageDir, join(packageDir, "dist"))).toBe(join(packageDir, "dist"));
		expect(getPackageSourceOrDistDir(packageDir, join(packageDir, "src"))).toBe(join(packageDir, "src"));
	});
});

describe("detectInstallMethod", () => {
	test("detects pnpm from Windows .pnpm install paths", () => {
		setExecPath(
			"C:\\Users\\Admin\\Documents\\pnpm-repository\\global\\5\\.pnpm\\@hansjm10+volt-coding-agent@0.67.68\\node_modules\\@hansjm10\\volt-coding-agent\\dist\\cli.js",
		);

		expect(detectInstallMethod()).toBe("pnpm");
		expect(getUpdateInstruction("@hansjm10/volt-coding-agent")).toBe(
			"Run: pnpm install -g --ignore-scripts --config.minimumReleaseAge=0 @hansjm10/volt-coding-agent",
		);
	});

	test("does not self-update unknown wrapper installs", () => {
		setExecPath("/usr/local/bin/node");

		expect(detectInstallMethod()).toBe("unknown");
		expect(getSelfUpdateCommand("@hansjm10/volt-coding-agent")).toBeUndefined();
		expect(getUpdateInstruction("@hansjm10/volt-coding-agent")).toBe(
			"Update @hansjm10/volt-coding-agent using the package manager, wrapper, or source checkout that provides this installation.",
		);
	});

	test("self-updates npm installs from custom prefixes", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("@hansjm10/volt-coding-agent");

		expect(detectInstallMethod()).toBe("npm");
		expect(command).toEqual({
			command: "npm",
			args: [
				"--prefix",
				prefix,
				"install",
				"-g",
				"--ignore-scripts",
				"--min-release-age=0",
				"@hansjm10/volt-coding-agent",
			],
			display: `npm --prefix ${prefix} install -g --ignore-scripts --min-release-age=0 @hansjm10/volt-coding-agent`,
		});
	});

	test("installs a tagged scoped package without mistaking it for a renamed package", () => {
		const { prefix } = createNpmPrefixInstall();
		const packageName = "@hansjm10/volt-coding-agent";

		const command = getSelfUpdateCommand(packageName, undefined, `${packageName}@beta`);

		expect(command).toEqual({
			command: "npm",
			args: ["--prefix", prefix, "install", "-g", "--ignore-scripts", "--min-release-age=0", `${packageName}@beta`],
			display: `npm --prefix ${prefix} install -g --ignore-scripts --min-release-age=0 ${packageName}@beta`,
		});
	});

	test("rolls back renamed package migrations to the exact installed version", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("@hansjm10/volt-coding-agent", undefined, "@new-scope/volt");

		expect(command).toEqual({
			command: "npm",
			args: ["--prefix", prefix, "install", "-g", "--ignore-scripts", "--min-release-age=0", "@new-scope/volt"],
			display: `npm --prefix ${prefix} uninstall -g @hansjm10/volt-coding-agent && npm --prefix ${prefix} install -g --ignore-scripts --min-release-age=0 @new-scope/volt`,
			steps: [
				{
					command: "npm",
					args: ["--prefix", prefix, "uninstall", "-g", "@hansjm10/volt-coding-agent"],
					display: `npm --prefix ${prefix} uninstall -g @hansjm10/volt-coding-agent`,
				},
				{
					command: "npm",
					args: [
						"--prefix",
						prefix,
						"install",
						"-g",
						"--ignore-scripts",
						"--min-release-age=0",
						"@new-scope/volt",
					],
					display: `npm --prefix ${prefix} install -g --ignore-scripts --min-release-age=0 @new-scope/volt`,
				},
			],
			rollbackStep: {
				command: "npm",
				args: [
					"--prefix",
					prefix,
					"install",
					"-g",
					"--ignore-scripts",
					"--min-release-age=0",
					`@hansjm10/volt-coding-agent@${VERSION}`,
				],
				display: `npm --prefix ${prefix} install -g --ignore-scripts --min-release-age=0 @hansjm10/volt-coding-agent@${VERSION}`,
			},
		});
	});

	test("self-update respects configured npmCommand", () => {
		const { prefix } = createNpmPrefixInstall();
		const configuredPrefix = process.platform === "win32" ? join(prefix, "lib") : prefix;

		const command = getSelfUpdateCommand("@hansjm10/volt-coding-agent", ["npm", "--prefix", configuredPrefix]);

		expect(command).toEqual({
			command: "npm",
			args: [
				"--prefix",
				configuredPrefix,
				"install",
				"-g",
				"--ignore-scripts",
				"--min-release-age=0",
				"@hansjm10/volt-coding-agent",
			],
			display: `npm --prefix ${configuredPrefix} install -g --ignore-scripts --min-release-age=0 @hansjm10/volt-coding-agent`,
		});
	});

	test("self-update treats empty npmCommand as unset", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("@hansjm10/volt-coding-agent", []);

		expect(command?.args).toEqual([
			"--prefix",
			prefix,
			"install",
			"-g",
			"--ignore-scripts",
			"--min-release-age=0",
			"@hansjm10/volt-coding-agent",
		]);
	});

	test("quotes npm self-update display paths", () => {
		const { prefix } = createNpmPrefixInstall("volt prefix ");

		const command = getSelfUpdateCommand("@hansjm10/volt-coding-agent");

		expect(command?.display).toBe(
			`npm --prefix "${prefix}" install -g --ignore-scripts --min-release-age=0 @hansjm10/volt-coding-agent`,
		);
	});

	test("does not infer Windows npm custom prefixes from package paths", () => {
		const packageDir = "C:\\Users\\Admin\\npm prefix\\node_modules\\@hansjm10\\volt-coding-agent";
		process.env.VOLT_PACKAGE_DIR = packageDir;
		setExecPath(`${packageDir}\\dist\\cli.js`);

		expect(detectInstallMethod()).toBe("npm");
		expect(getUpdateInstruction("@hansjm10/volt-coding-agent")).toBe(
			"Run: npm install -g --ignore-scripts --min-release-age=0 @hansjm10/volt-coding-agent",
		);
	});

	test.runIf(process.platform !== "win32")("self-updates bun global installs from bun pm bin", () => {
		createBunGlobalInstall();

		const command = getSelfUpdateCommand("@hansjm10/volt-coding-agent");

		expect(detectInstallMethod()).toBe("bun");
		expect(command).toEqual({
			command: "bun",
			args: ["install", "-g", "--ignore-scripts", "--minimum-release-age=0", "@hansjm10/volt-coding-agent"],
			display: "bun install -g --ignore-scripts --minimum-release-age=0 @hansjm10/volt-coding-agent",
		});
	});

	test.runIf(process.platform !== "win32")(
		"self-updates renamed pnpm global installs with exact-version rollback",
		() => {
			createPnpmGlobalInstall();

			const command = getSelfUpdateCommand("@hansjm10/volt-coding-agent", undefined, "@new-scope/volt");

			expect(detectInstallMethod()).toBe("pnpm");
			expect(command).toEqual({
				command: "pnpm",
				args: ["install", "-g", "--ignore-scripts", "--config.minimumReleaseAge=0", "@new-scope/volt"],
				display:
					"pnpm remove -g @hansjm10/volt-coding-agent && pnpm install -g --ignore-scripts --config.minimumReleaseAge=0 @new-scope/volt",
				steps: [
					{
						command: "pnpm",
						args: ["remove", "-g", "@hansjm10/volt-coding-agent"],
						display: "pnpm remove -g @hansjm10/volt-coding-agent",
					},
					{
						command: "pnpm",
						args: ["install", "-g", "--ignore-scripts", "--config.minimumReleaseAge=0", "@new-scope/volt"],
						display: "pnpm install -g --ignore-scripts --config.minimumReleaseAge=0 @new-scope/volt",
					},
				],
				rollbackStep: {
					command: "pnpm",
					args: [
						"install",
						"-g",
						"--ignore-scripts",
						"--config.minimumReleaseAge=0",
						`@hansjm10/volt-coding-agent@${VERSION}`,
					],
					display: `pnpm install -g --ignore-scripts --config.minimumReleaseAge=0 @hansjm10/volt-coding-agent@${VERSION}`,
				},
			});
		},
	);

	test.runIf(process.platform !== "win32")("self-updates pnpm v11 global installs resolved through the store", () => {
		const temp = mkdtempSync(join(tmpdir(), "volt-pnpm11-"));
		const binDir = join(temp, "bin");
		const root = join(temp, "Library", "pnpm", "global", "v11");
		const packageName = "@hansjm10/volt-coding-agent";
		const globalPackageDir = join(root, "11e9a", "node_modules", "@hansjm10", "volt-coding-agent");
		const storePackageDir = join(
			temp,
			"Library",
			"pnpm",
			"store",
			"v11",
			"links",
			"@hansjm10",
			"volt-coding-agent",
			"0.75.0",
			"hash",
			"node_modules",
			"@hansjm10",
			"volt-coding-agent",
		);
		mkdirSync(globalPackageDir, { recursive: true });
		mkdirSync(storePackageDir, { recursive: true });
		mkdirSync(binDir, { recursive: true });
		writeFileSync(join(globalPackageDir, "package.json"), "{}");
		writeFileSync(join(binDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm"), createFakePnpmScript(root));
		chmodSync(join(binDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm"), 0o755);
		tempDir = temp;
		process.env[pathEnvKey] = `${binDir}${delimiter}${originalPath ?? ""}`;
		process.env.VOLT_PACKAGE_DIR = storePackageDir;
		process.argv[1] = join(globalPackageDir, "dist", "cli.js");
		setExecPath(join(storePackageDir, "dist", "cli.js"));

		const command = getSelfUpdateCommand(packageName);

		expect(detectInstallMethod()).toBe("pnpm");
		expect(command).toEqual({
			command: "pnpm",
			args: ["install", "-g", "--ignore-scripts", "--config.minimumReleaseAge=0", packageName],
			display: `pnpm install -g --ignore-scripts --config.minimumReleaseAge=0 ${packageName}`,
		});
	});

	test.runIf(process.platform !== "win32")(
		"self-updates renamed yarn global installs with exact-version rollback",
		() => {
			createYarnGlobalInstall();

			const command = getSelfUpdateCommand("@hansjm10/volt-coding-agent", undefined, "@new-scope/volt");

			expect(detectInstallMethod()).toBe("yarn");
			expect(command).toEqual({
				command: "yarn",
				args: ["global", "add", "--ignore-scripts", "@new-scope/volt"],
				display:
					"yarn global remove @hansjm10/volt-coding-agent && yarn global add --ignore-scripts @new-scope/volt",
				steps: [
					{
						command: "yarn",
						args: ["global", "remove", "@hansjm10/volt-coding-agent"],
						display: "yarn global remove @hansjm10/volt-coding-agent",
					},
					{
						command: "yarn",
						args: ["global", "add", "--ignore-scripts", "@new-scope/volt"],
						display: "yarn global add --ignore-scripts @new-scope/volt",
					},
				],
				rollbackStep: {
					command: "yarn",
					args: ["global", "add", "--ignore-scripts", `@hansjm10/volt-coding-agent@${VERSION}`],
					display: `yarn global add --ignore-scripts @hansjm10/volt-coding-agent@${VERSION}`,
				},
			});
		},
	);

	test.runIf(process.platform !== "win32")(
		"self-updates renamed bun global installs with exact-version rollback",
		() => {
			createBunGlobalInstall();

			const command = getSelfUpdateCommand("@hansjm10/volt-coding-agent", undefined, "@new-scope/volt");

			expect(detectInstallMethod()).toBe("bun");
			expect(command).toEqual({
				command: "bun",
				args: ["install", "-g", "--ignore-scripts", "--minimum-release-age=0", "@new-scope/volt"],
				display:
					"bun uninstall -g @hansjm10/volt-coding-agent && bun install -g --ignore-scripts --minimum-release-age=0 @new-scope/volt",
				steps: [
					{
						command: "bun",
						args: ["uninstall", "-g", "@hansjm10/volt-coding-agent"],
						display: "bun uninstall -g @hansjm10/volt-coding-agent",
					},
					{
						command: "bun",
						args: ["install", "-g", "--ignore-scripts", "--minimum-release-age=0", "@new-scope/volt"],
						display: "bun install -g --ignore-scripts --minimum-release-age=0 @new-scope/volt",
					},
				],
				rollbackStep: {
					command: "bun",
					args: [
						"install",
						"-g",
						"--ignore-scripts",
						"--minimum-release-age=0",
						`@hansjm10/volt-coding-agent@${VERSION}`,
					],
					display: `bun install -g --ignore-scripts --minimum-release-age=0 @hansjm10/volt-coding-agent@${VERSION}`,
				},
			});
		},
	);

	test.runIf(process.platform !== "win32")("does not self-update when npm install path is not writable", () => {
		const { packageDir } = createNpmPrefixInstall();
		chmodSync(packageDir, 0o500);

		expect(getSelfUpdateCommand("@hansjm10/volt-coding-agent")).toBeUndefined();
		expect(getSelfUpdateUnavailableInstruction("@hansjm10/volt-coding-agent")).toContain(
			"the install path is not writable",
		);
	});
});
