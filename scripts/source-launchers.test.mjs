import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptsDir);

for (const { name, args, exitCode } of [
	{ name: "defaults to the full test suite", args: [], exitCode: 0 },
	{
		name: "forwards workspace and shard arguments",
		args: ["test", "--workspace", "packages/coding-agent", "--", "--shard=2/3"],
		exitCode: 0,
	},
	{ name: "forwards other npm scripts", args: ["run", "test:memory-benchmark"], exitCode: 0 },
	{
		name: "preserves argument boundaries and restores auth after failure",
		args: ["test", "--", "path with spaces"],
		exitCode: 17,
	},
]) {
	test(`test.sh ${name}`, () => {
		const home = mkdtempSync(join(tmpdir(), "volt-test-launcher-"));
		const authDir = join(home, ".volt", "agent");
		const authFile = join(authDir, "auth.json");
		const auth = '{"fixture":true}';
		try {
			mkdirSync(authDir, { recursive: true });
			writeFileSync(authFile, auth);
			const result = spawnSync(
				"bash",
				[
					"-c",
					`npm() {
    [[ ! -f "$HOME/.volt/agent/auth.json" ]] || return 90
    [[ -z "\${OPENAI_API_KEY+x}" ]] || return 91
    [[ -z "\${GITHUB_TOKEN+x}" ]] || return 92
    [[ "$VOLT_NO_LOCAL_LLM" == 1 ]] || return 93
    printf 'npm-arg:%s\\n' "$@"
    return "$VOLT_TEST_NPM_EXIT_CODE"
}
export -f npm
exec bash ./test.sh "$@"`,
					"test-launcher",
					...args,
				],
				{
					cwd: repoRoot,
					encoding: "utf8",
					env: {
						...process.env,
						HOME: home.replaceAll("\\", "/"),
						OPENAI_API_KEY: "fixture-key",
						GITHUB_TOKEN: "fixture-token",
						VOLT_TEST_NPM_EXIT_CODE: String(exitCode),
					},
				},
			);
			assert.equal(result.status, exitCode, result.error?.message || result.stderr || result.stdout);
			assert.deepEqual(
				result.stdout
					.split(/\r?\n/)
					.filter((line) => line.startsWith("npm-arg:"))
					.map((line) => line.slice("npm-arg:".length)),
				args.length ? args : ["test"],
			);
			assert.equal(readFileSync(authFile, "utf8"), auth);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
}

const powerShellCandidates = process.platform === "win32" ? ["powershell.exe", "pwsh.exe"] : ["pwsh"];
const powerShell = powerShellCandidates.find((candidate) => {
	const result = spawnSync(candidate, ["-NoProfile", "-Command", "exit 0"], { windowsHide: true });
	return result.status === 0;
});

test(
	"PowerShell source launcher restores the private diagnostics environment setting",
	{ skip: powerShell === undefined ? "PowerShell is unavailable" : false },
	() => {
		const tempDir = mkdtempSync(join(tmpdir(), "volt-source-launcher-"));
		const testScript = join(tempDir, "verify-private-diagnostics.ps1");

		try {
			writeFileSync(
				testScript,
				`param([string]$RepoRoot)
$ErrorActionPreference = "Stop"
$global:SimulateNodeFailure = $false

function node {
	if ($env:VOLT_REVIEW_PRIVATE_DIAGNOSTICS -notin @("1", "0")) {
		throw "Unexpected diagnostics value: $env:VOLT_REVIEW_PRIVATE_DIAGNOSTICS"
	}
	if ($global:SimulateNodeFailure) {
		throw "Simulated node failure"
	}
	$global:LASTEXITCODE = 0
}

$launcher = Join-Path $RepoRoot "volt-test.ps1"
Remove-Item Env:VOLT_REVIEW_PRIVATE_DIAGNOSTICS -ErrorAction SilentlyContinue
& $launcher
if (Test-Path Env:VOLT_REVIEW_PRIVATE_DIAGNOSTICS) {
	throw "Launcher leaked a newly set diagnostics value"
}

$env:VOLT_REVIEW_PRIVATE_DIAGNOSTICS = "0"
& $launcher
if ($env:VOLT_REVIEW_PRIVATE_DIAGNOSTICS -ne "0") {
	throw "Launcher changed an existing diagnostics value"
}

Remove-Item Env:VOLT_REVIEW_PRIVATE_DIAGNOSTICS
$global:SimulateNodeFailure = $true
try {
	& $launcher
	throw "Expected simulated node failure"
} catch {
	if ($_.Exception.Message -ne "Simulated node failure") {
		throw
	}
}
if (Test-Path Env:VOLT_REVIEW_PRIVATE_DIAGNOSTICS) {
	throw "Launcher leaked the diagnostics value after failure"
}

Write-Output "PowerShell launcher diagnostics scoping verified"
`,
			);

			const result = spawnSync(
				powerShell,
				["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", testScript, repoRoot],
				{ encoding: "utf8", windowsHide: true },
			);

			assert.equal(result.status, 0, result.stderr || result.stdout);
			assert.match(result.stdout, /PowerShell launcher diagnostics scoping verified/);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	},
);

for (const setting of [undefined, "0", "true", "disabled"]) {
	test(`Bash source launcher preserves background diagnostics ${setting ?? "default"}`, () => {
		const env = { ...process.env, VOLT_REVIEW_PRIVATE_DIAGNOSTICS: "0" };
		delete env.VOLT_BACKGROUND_JOB_DIAGNOSTICS;
		if (setting !== undefined) env.VOLT_BACKGROUND_JOB_DIAGNOSTICS = setting;
		const result = spawnSync("bash", ["-c", `node() {
  printf 'diagnostics:%s\\n' "$VOLT_BACKGROUND_JOB_DIAGNOSTICS"
  printf 'review:%s\\n' "$VOLT_REVIEW_PRIVATE_DIAGNOSTICS"
  printf 'arg:%s\\n' "$@"
  return 17
}
export -f node
exec bash ./volt-test.sh "$@"`, "source-launcher", "--name", "two words"], { cwd: repoRoot, encoding: "utf8", env });
		assert.equal(result.status, 17, result.stderr);
		assert.ok(result.stdout.includes(`diagnostics:${setting ?? "1"}`), result.stdout);
		assert.match(result.stdout, /review:0/);
		assert.deepEqual(result.stdout.split(/\r?\n/).filter((line) => line.startsWith("arg:")).slice(1), ["arg:--name", "arg:two words"]);
	});
}

test("PowerShell source launcher scopes background diagnostics on success and failure", { skip: powerShell === undefined }, () => {
	const directory = mkdtempSync(join(tmpdir(), "volt-source-background-"));
	try {
		const path = join(directory, "verify.ps1");
		writeFileSync(path, `param([string]$RepoRoot)
$ErrorActionPreference = 'Stop'
$global:Expected = '1'
$global:Fail = $false
function node {
  if ($env:VOLT_BACKGROUND_JOB_DIAGNOSTICS -ne $global:Expected) { throw 'Wrong background diagnostics setting' }
  if ($args[-1] -ne 'two words') { throw 'Argument boundaries changed' }
  if ($global:Fail) { throw 'fixture failure' }
  $global:LASTEXITCODE = 0
}
$launcher = Join-Path $RepoRoot 'volt-test.ps1'
foreach ($value in @($null, '0', 'true', 'disabled')) {
  Remove-Item Env:VOLT_BACKGROUND_JOB_DIAGNOSTICS -ErrorAction SilentlyContinue
  $global:Expected = '1'
  if ($null -ne $value) { $env:VOLT_BACKGROUND_JOB_DIAGNOSTICS = $value; $global:Expected = $value }
  foreach ($fail in @($false, $true)) {
    $global:Fail = $fail
    try { & $launcher --name 'two words'; if ($fail) { throw 'Expected failure' } }
    catch { if (-not $fail -or $_.Exception.Message -ne 'fixture failure') { throw } }
    if ($null -eq $value) {
      if (Test-Path Env:VOLT_BACKGROUND_JOB_DIAGNOSTICS) { throw 'Leaked setting' }
    } elseif ($env:VOLT_BACKGROUND_JOB_DIAGNOSTICS -ne $value) { throw 'Changed existing setting' }
  }
}
Write-Output 'Background diagnostics scoping verified'
`);
		const result = spawnSync(powerShell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path, repoRoot], { encoding: "utf8", windowsHide: true });
		assert.equal(result.status, 0, result.stderr || result.stdout);
		assert.match(result.stdout, /Background diagnostics scoping verified/);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("batch source launcher forwards arguments, defaults diagnostics, and preserves failure exit", { skip: process.platform !== "win32" }, () => {
	const directory = mkdtempSync(join(tmpdir(), "volt-source-batch-"));
	try {
		writeFileSync(join(directory, "node.cmd"), '@echo off\r\necho diagnostics:%VOLT_BACKGROUND_JOB_DIAGNOSTICS%\r\necho arguments:%*\r\nexit /b 17\r\n');
		const env = { ...process.env };
		const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
		env[pathKey] = `${directory};${env[pathKey] ?? ""}`;
		delete env.VOLT_BACKGROUND_JOB_DIAGNOSTICS;
		const result = spawnSync("cmd.exe", ["/d", "/s", "/c", `""${join(repoRoot, "volt-test.bat")}" --name "two words""`], { cwd: repoRoot, encoding: "utf8", env, windowsHide: true, windowsVerbatimArguments: true });
		assert.equal(result.status, 17, result.stderr || result.stdout);
		assert.match(result.stdout, /diagnostics:1/);
		assert.match(result.stdout, /--name "two words"/);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});
