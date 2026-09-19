#!/usr/bin/env node
// Stage fresh workspace packages outside the checkout. Never executes Volt.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, realpathSync, statfsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [outputArg, nativeArg] = process.argv.slice(2);
if (!outputArg || !nativeArg) throw new Error('Usage: node build-cli-image.mjs <new-/tmp-build-dir> <linux-arm64-gnu.node>');
const output = resolve(outputArg);
const parent = realpathSync(dirname(output));
if (parent !== '/tmp' && parent !== '/private/tmp' && !parent.startsWith('/private/tmp/')) throw new Error('Output must be under /tmp');
const disk = statfsSync(parent);
if (disk.bavail * disk.bsize < 5 * 1024 ** 3) throw new Error('At least 5 GiB free host disk is required before the Docker build; do not risk the shared Colima filesystem');
mkdirSync(output, { mode: 0o700 });
mkdirSync(join(output, 'tarballs'));
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stderr || ''}`);
  return result.stdout;
}
const dependencies = {};
const packages = [];
for (const area of ['tui', 'ai', 'agent', 'coding-agent']) {
  const pack = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', join(output, 'tarballs')], { cwd: join(repo, 'packages', area) }))[0];
  const stage = join(output, area);
  mkdirSync(stage);
  run('tar', ['-xf', join(output, 'tarballs', pack.filename), '-C', stage]);
  const metadataPath = join(stage, 'package/package.json');
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  metadata.private = true;
  metadata.voltBuildProfile = 'pairing-e2e';
  delete metadata.publishConfig;
  metadata.scripts = { ...metadata.scripts, prepublishOnly: 'node -e "throw new Error(\'Private pairing E2E artifact; publication forbidden\')"' };
  writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + '\n');
  run('tar', ['-czf', join(output, 'tarballs', pack.filename), '-C', stage, 'package']);
  dependencies[metadata.name] = `file:/opt/tarballs/${pack.filename}`;
  packages.push({ name: metadata.name, version: metadata.version, sha256: createHash('sha256').update(readFileSync(join(output, 'tarballs', pack.filename))).digest('hex') });
}
copyFileSync(nativeArg, join(output, 'iroh.linux-arm64-gnu.node'));
writeFileSync(join(output, 'package.json'), JSON.stringify({ name: 'volt-pairing-private-install', version: '0.0.0', private: true, voltBuildProfile: 'pairing-e2e', dependencies }, null, 2) + '\n');
writeFileSync(join(output, 'Dockerfile'), `FROM node:24-bookworm
LABEL dev.volt.profile="pairing-e2e" dev.volt.publishable="false"
WORKDIR /opt/volt
COPY package.json ./
COPY tarballs/ /opt/tarballs/
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund && ln -s /opt/volt/node_modules/.bin/volt /usr/local/bin/volt
COPY iroh.linux-arm64-gnu.node /opt/volt/node_modules/@hansjm10/volt-iroh/iroh.linux-arm64-gnu.node
RUN mkdir -p /workspace /home/volt && chown node:node /workspace /home/volt
USER node
ENV HOME=/home/volt TERM=xterm-256color
WORKDIR /workspace
CMD ["sleep", "infinity"]
`);
run('docker', ['build', '--platform', 'linux/arm64', '-t', 'volt-pairing-cli-base:local', output], { stdio: 'inherit' });
const image = run('docker', ['image', 'inspect', 'volt-pairing-cli-base:local', '--format', '{{.Id}}']).trim();
writeFileSync(join(output, 'artifact.json'), JSON.stringify({ profile: 'pairing-e2e', publishable: false, sourceCommit: run('git', ['rev-parse', 'HEAD'], { cwd: repo }).trim(), packages, nativeSha256: createHash('sha256').update(readFileSync(nativeArg)).digest('hex'), image }, null, 2) + '\n', { mode: 0o600 });
console.log(`Private base image ready; manifest: ${join(output, 'artifact.json')}`);
