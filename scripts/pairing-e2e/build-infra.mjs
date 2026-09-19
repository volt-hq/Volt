#!/usr/bin/env node
// Local-only arm64 infrastructure build; no production build entrypoint is changed.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, realpathSync, statfsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const upstream = 'f2eb930dda3779c6d852b72f3712aacd6e573ab1';
const [outputArg, sourceArg] = process.argv.slice(2);
if (!outputArg || !sourceArg) throw new Error('Usage: node build-infra.mjs <new-/tmp-build-dir> <local-iroh-git-checkout>');
const output = resolve(outputArg);
const parent = realpathSync(dirname(output));
if (parent !== '/tmp' && parent !== '/private/tmp' && !parent.startsWith('/private/tmp/')) throw new Error('Build output must be under /tmp');
const disk = statfsSync(parent);
if (disk.bavail * disk.bsize < 5 * 1024 ** 3) throw new Error('At least 5 GiB free host disk is required before the Docker build; do not risk the shared Colima filesystem');
mkdirSync(output, { mode: 0o700 });
const source = realpathSync(sourceArg);
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed (${result.status})`);
  return result;
}
const patch = join(repo, 'services/relay-credential-broker/relay-patch/iroh-relay-1.0.3-jwt-access.patch');
mkdirSync(join(output, 'iroh'));
run('git', ['-C', source, 'archive', '--format=tar', '-o', join(output, 'source.tar'), upstream]);
run('tar', ['-xf', join(output, 'source.tar'), '-C', join(output, 'iroh')]);
run('git', ['apply', '--check', patch], { cwd: join(output, 'iroh') });
run('git', ['apply', patch], { cwd: join(output, 'iroh') });
copyFileSync(patch, join(output, 'jwt-access.patch'));
run('go', ['build', '-mod=readonly', '-tags', 'volt_e2e', '-trimpath', '-o', join(output, 'relay-credential-e2e'), './cmd/relay-credential-e2e'], {
  cwd: join(repo, 'services/relay-credential-broker'), env: { ...process.env, GOOS: 'linux', GOARCH: 'arm64', CGO_ENABLED: '0' },
});
writeFileSync(join(output, 'Dockerfile'), `FROM rust:1.97.1-bookworm AS relay
WORKDIR /build
COPY iroh/ ./
ENV CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=2
RUN rustup component add rustfmt clippy && cargo fmt --all -- --check && cargo test --locked --release -p iroh-relay --features server --bin iroh-relay && cargo clippy --locked --release -p iroh-relay --features server --bin iroh-relay -- -D warnings && cargo build --locked --release -p iroh-relay --features server --bin iroh-relay && strip target/release/iroh-relay
FROM node:24-bookworm
LABEL dev.volt.profile="pairing-e2e" dev.volt.publishable="false"
COPY --from=relay /build/target/release/iroh-relay /usr/local/bin/iroh-relay
COPY relay-credential-e2e /usr/local/bin/relay-credential-e2e
CMD ["sleep", "infinity"]
`);
run('docker', ['build', '--platform', 'linux/arm64', '-t', 'volt-pairing-infra:local', output]);
const digest = spawnSync('docker', ['image', 'inspect', 'volt-pairing-infra:local', '--format', '{{.Id}}'], { encoding: 'utf8' }).stdout.trim();
writeFileSync(join(output, 'artifact.json'), JSON.stringify({ profile: 'pairing-e2e', publishable: false, upstream, patchSha256: createHash('sha256').update(readFileSync(patch)).digest('hex'), rust: '1.97.1', target: 'aarch64-unknown-linux-gnu', image: digest, brokerSha256: createHash('sha256').update(readFileSync(join(output, 'relay-credential-e2e'))).digest('hex') }, null, 2) + '\n', { mode: 0o600 });
console.log(`Infrastructure image ready; manifest: ${join(output, 'artifact.json')}`);
