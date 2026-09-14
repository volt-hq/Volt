#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, randomBytes, X509Certificate } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { buildPairingCli } from './build-cli.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const profile = 'pairing-e2e';
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
  // Never include captured stderr: infrastructure errors can contain credentials.
  if (result.error || result.status !== 0) throw new Error(`${command} failed (exit ${result.status}); inspect private run artifacts locally`);
  return result.stdout;
}
export function privateFile(path, content) {
  writeFileSync(path, content, { mode: 0o600, flag: 'wx' });
}
export function generateRun(outputArg, now = Math.floor(Date.now() / 1000)) {
  const output = resolve(outputArg);
  const parent = realpathSync(dirname(output));
  if (parent !== '/tmp' && parent !== '/private/tmp' && !parent.startsWith('/private/tmp/')) throw new Error('Run must be outside the checkout, under /tmp');
  mkdirSync(output, { mode: 0o700 });
  const root = realpathSync(output);
  const runId = randomBytes(16).toString('hex');
  const proofSecret = randomBytes(32).toString('hex');
  const expiresAt = now + 7200;
  const prefix = `volt-e2e-${runId.slice(0, 8)}`;
  for (const sub of ['broker', 'relay', 'database', 'cli-context']) mkdirSync(join(root, sub), { mode: 0o700 });
  privateFile(join(root, 'ca.conf'), '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\nCN=Volt private pairing CA\n[ca]\nbasicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n');
  privateFile(join(root, 'server.conf'), '[req]\nprompt=no\ndistinguished_name=dn\n[dn]\nCN=Volt private pairing server\n[server]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\nauthorityKeyIdentifier=keyid,issuer\n');
  run('openssl', ['req', '-new', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', join(root, 'ca.conf'), '-keyout', join(root, 'ca-key.pem'), '-out', join(root, 'ca.pem')]);
  run('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-config', join(root, 'server.conf'), '-keyout', join(root, 'broker/certificate-key.pem'), '-out', join(root, 'server.csr')]);
  run('openssl', ['x509', '-req', '-in', join(root, 'server.csr'), '-CA', join(root, 'ca.pem'), '-CAkey', join(root, 'ca-key.pem'), '-set_serial', '1', '-days', '1', '-extfile', join(root, 'server.conf'), '-extensions', 'server', '-out', join(root, 'broker/certificate.pem')]);
  for (const path of ['ca-key.pem', 'ca.pem', 'server.csr', 'broker/certificate-key.pem', 'broker/certificate.pem']) chmodSync(join(root, path), 0o600);
  privateFile(join(root, 'ca.der'), new X509Certificate(readFileSync(join(root, 'ca.pem'))).raw);
  const seed = randomBytes(32);
  const signingKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(signingKey).export({ format: 'jwk' }).x;
  privateFile(join(root, 'broker/signing-key'), seed.toString('base64url') + '\n');
  const password = randomBytes(32).toString('hex');
  privateFile(join(root, 'database/password'), password + '\n');
  privateFile(join(root, 'broker/config.json'), JSON.stringify({ runId, proofSecret, expiresAt, databaseUrl: `postgres://postgres:${password}@postgres:5432/volt_pairing_e2e?sslmode=disable`, signingKeyPath: '/run/private/signing-key', certificatePath: '/run/private/certificate.pem', certificateKeyPath: '/run/private/certificate-key.pem', listenAddress: '0.0.0.0:18443' }, null, 2) + '\n');
  privateFile(join(root, 'app-proof.json'), JSON.stringify({ runId, proofSecret, expiresAt }, null, 2) + '\n');
  for (const path of ['certificate.pem', 'certificate-key.pem']) copyFileSync(join(root, 'broker', path), join(root, 'relay', path));
  privateFile(join(root, 'relay/config.toml'), `enable_relay = true\nenable_quic_addr_discovery = false\nenable_metrics = true\nhttp_bind_addr = "127.0.0.1:19080"\nmetrics_bind_addr = "127.0.0.1:19090"\n[tls]\nhttps_bind_addr = "0.0.0.0:19443"\ncert_mode = "Manual"\nmanual_cert_path = "/run/private/certificate.pem"\nmanual_key_path = "/run/private/certificate-key.pem"\n[access.jwt]\nissuer = "https://127.0.0.1:18443"\naudience = "volt-iroh-relay-e2e"\nmax_token_lifetime_seconds = 900\nclock_skew_seconds = 30\n[[access.jwt.keys]]\npublic_key = "${publicKey}"\n`);
  return { profile, publishable: false, root, prefix, expiresAt, containers: { namespace: `${prefix}-net`, postgres: `${prefix}-postgres`, broker: `${prefix}-broker`, relay: `${prefix}-relay`, cli: `${prefix}-cli`, proxy: `${prefix}-proxy` }, network: `${prefix}-internal`, volumes: ['broker', 'relay', 'database'].map(name => `${prefix}-${name}`) };
}
async function portAvailable(port) {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolvePromise);
  });
  await new Promise(resolvePromise => server.close(resolvePromise));
}
function docker(args, options) { return run('docker', args, options); }
function remaining(state) {
  const seconds = state.expiresAt - Math.floor(Date.now() / 1000);
  if (seconds < 60) throw new Error('Run deadline too close; generate a fresh run');
  return `${seconds}s`;
}
function owned(state, kind, name) {
  const labels = JSON.parse(docker([kind, 'inspect', name]))[0];
  const marker = kind === 'container' ? labels.Config.Labels : labels.Labels;
  if (marker?.['dev.volt.run'] !== state.prefix) throw new Error('Refusing to modify an unrelated Docker resource');
}
export function down(state) {
  for (const name of Object.values(state.containers).reverse()) {
    if (spawnSync('docker', ['container', 'inspect', name], { stdio: 'ignore' }).status !== 0) continue;
    owned(state, 'container', name);
    docker(['rm', '-f', '-v', name]);
  }
  for (const name of state.volumes) {
    if (spawnSync('docker', ['volume', 'inspect', name], { stdio: 'ignore' }).status !== 0) continue;
    owned(state, 'volume', name);
    docker(['volume', 'rm', name]);
  }
  if (spawnSync('docker', ['network', 'inspect', state.network], { stdio: 'ignore' }).status === 0) {
    owned(state, 'network', state.network);
    docker(['network', 'rm', state.network]);
  }
}
export async function up(output, infraManifest, cliManifest) {
  for (const port of [18443, 19443]) await portAvailable(port);
  const infra = JSON.parse(readFileSync(infraManifest, 'utf8'));
  const cli = JSON.parse(readFileSync(cliManifest, 'utf8'));
  for (const artifact of [infra, cli]) {
    if (artifact.profile !== profile || artifact.publishable !== false || !/^sha256:[a-f0-9]{64}$/.test(artifact.image)) throw new Error('Expected explicit private artifact manifests');
    const image = JSON.parse(docker(['image', 'inspect', artifact.image]))[0];
    if (image.Config.Labels?.['dev.volt.publishable'] !== 'false') throw new Error('Image is not marked private');
  }
  const state = generateRun(output);
  privateFile(join(state.root, 'rig.json'), JSON.stringify(state, null, 2) + '\n');
  const labels = ['--label', `dev.volt.run=${state.prefix}`, '--label', 'dev.volt.publishable=false'];
  try {
    // This context contains only public trust material and the private-profile JS bundle.
    await buildPairingCli(join(state.root, 'ca.pem'), join(state.root, 'cli-context/bundle'));
    copyFileSync(join(state.root, 'ca.pem'), join(state.root, 'cli-context/ca.pem'));
    copyFileSync(join(state.root, 'ca.der'), join(state.root, 'cli-context/ca.der'));
    copyFileSync(join(scriptDir, 'probe-relay.mjs'), join(state.root, 'cli-context/probe-relay.mjs'));
    copyFileSync(join(scriptDir, 'loopback-proxy.mjs'), join(state.root, 'cli-context/loopback-proxy.mjs'));
    privateFile(join(state.root, 'cli-context/artifact.json'), JSON.stringify({ ...cli, baseImage: cli.image, image: undefined, infra, caSha256: new X509Certificate(readFileSync(join(state.root, 'ca.pem'))).fingerprint256 }, null, 2) + '\n');
    privateFile(join(state.root, 'cli-context/Dockerfile'), `FROM ${cli.image}\nUSER root\nRUN rm -rf /opt/volt/node_modules/@hansjm10/volt-coding-agent/dist/core/npm && mkdir -p /opt/volt/node_modules/@hansjm10/volt-coding-agent/dist/core/npm\nCOPY bundle/ /opt/private-bundle/\nRUN cp /opt/private-bundle/*.js /opt/volt/node_modules/@hansjm10/volt-coding-agent/dist/core/npm/ && chmod 755 /opt/volt/node_modules/@hansjm10/volt-coding-agent/dist/core/npm/cli.js\nCOPY ca.pem ca.der probe-relay.mjs loopback-proxy.mjs artifact.json /opt/volt-e2e/\nRUN chmod -R a+rX /opt/volt-e2e /opt/private-bundle\nUSER node\n`);
    docker(['build', '-t', `${state.prefix}-cli:private`, join(state.root, 'cli-context')]);
    privateFile(join(state.root, 'images.json'), JSON.stringify({ profile, publishable: false, cli: docker(['image', 'inspect', `${state.prefix}-cli:private`, '--format', '{{.Id}}']).trim(), infra: infra.image, postgres: docker(['image', 'inspect', 'postgres:16', '--format', '{{.Id}}']).trim() }, null, 2) + '\n');
    docker(['network', 'create', '--internal', ...labels, state.network]);
    for (const [index, area] of ['broker', 'relay', 'database'].entries()) {
      docker(['volume', 'create', ...labels, state.volumes[index]]);
      // Transfer over Docker's API: Colima does not mount arbitrary host /tmp paths.
      const staging = docker(['create', '--network', 'none', '--user', '0', ...labels, '--mount', `type=volume,src=${state.volumes[index]},dst=/run/private`, infra.image, 'sh', '-c', 'chown -R 0:0 /run/private && chmod 700 /run/private && chmod 600 /run/private/*']).trim();
      try {
        docker(['cp', `${join(state.root, area)}/.`, `${staging}:/run/private/`]);
        docker(['start', '-a', staging]);
      } finally {
        docker(['rm', '-f', staging]);
      }
    }
    docker(['run', '-d', '--name', state.containers.namespace, ...labels, '--network', state.network, infra.image, 'sleep', remaining(state)]);
    docker(['run', '-d', '--name', state.containers.postgres, ...labels, '--network', state.network, '--network-alias', 'postgres', '--mount', `type=volume,src=${state.volumes[2]},dst=/run/private,readonly`, '-e', 'POSTGRES_PASSWORD_FILE=/run/private/password', '-e', 'POSTGRES_DB=volt_pairing_e2e', '--entrypoint', 'timeout', 'postgres:16', remaining(state), 'docker-entrypoint.sh', 'postgres']);
    for (let attempt = 0; attempt < 40; attempt++) {
      if (spawnSync('docker', ['exec', state.containers.postgres, 'pg_isready', '-U', 'postgres', '-d', 'volt_pairing_e2e'], { stdio: 'ignore' }).status === 0) break;
      if (attempt === 39) throw new Error('Private PostgreSQL did not become ready');
      await delay(500);
    }
    for (const [index, area, executable, args] of [[0, 'broker', 'relay-credential-e2e', ['--config', '/run/private/config.json']], [1, 'relay', 'iroh-relay', ['--config-path', '/run/private/config.toml']]]) {
      docker(['run', '-d', '--name', state.containers[area], ...labels, '--network', `container:${state.containers.namespace}`, '--mount', `type=volume,src=${state.volumes[index]},dst=/run/private,readonly`, ...(area === 'relay' ? ['-e', 'RUST_LOG=info,iroh_relay::jwt_access=debug'] : []), infra.image, 'timeout', remaining(state), executable, ...args]);
    }
    docker(['run', '-d', '--name', state.containers.cli, ...labels, '--network', `container:${state.containers.namespace}`, `${state.prefix}-cli:private`]);
    const namespaceIP = JSON.parse(docker(['container', 'inspect', state.containers.namespace]))[0].NetworkSettings.Networks[state.network].IPAddress;
    docker(['run', '-d', '--name', state.containers.proxy, ...labels, '--network', 'host', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', `${state.prefix}-cli:private`, 'node', '/opt/volt-e2e/loopback-proxy.mjs', namespaceIP, String(state.expiresAt)]);
    await verify(state);
    console.log(`Rig ready (Volt has NOT been launched): ${join(state.root, 'rig.json')}`);
    console.log(`CLI container: ${state.containers.cli}; HOME=/home/volt; workspace=/workspace`);
    console.log(`Public CA: ${join(state.root, 'ca.pem')} and ${join(state.root, 'ca.der')}`);
    console.log(`Private app proof config: ${join(state.root, 'app-proof.json')}`);
  } catch (error) {
    const dns = spawnSync('docker', ['exec', state.containers.namespace, 'getent', 'hosts', 'postgres'], { encoding: 'utf8' });
    const tcp = spawnSync('docker', ['exec', state.containers.namespace, 'bash', '-c', 'timeout 5 bash -c "echo > /dev/tcp/postgres/5432"'], { encoding: 'utf8' });
    privateFile(join(state.root, 'connectivity.json'), JSON.stringify({ dnsStatus: dns.status, dns: dns.stdout.trim(), databaseTcpStatus: tcp.status }, null, 2));
    for (const [area, name] of Object.entries(state.containers)) {
      const logs = spawnSync('docker', ['logs', name], { encoding: 'utf8' });
      if (logs.status === 0) privateFile(join(state.root, `${area}.log`), logs.stdout + logs.stderr);
    }
    down(state);
    throw error;
  }
  return state;
}
export async function verify(state) {
  for (const [port, route] of [[18443, '/readyz'], [19443, '/']]) {
    let result;
    for (let attempt = 0; attempt < 40; attempt++) {
      result = spawnSync('curl', ['--silent', '--fail', '--max-time', '3', '--cacert', join(state.root, 'ca.pem'), `https://127.0.0.1:${port}${route}`], { stdio: 'ignore' });
      if (result.status === 0) break;
      await delay(500);
    }
    if (result.status !== 0) {
      const local = spawnSync('docker', ['exec', state.containers.cli, 'curl', '--silent', '--fail', '--max-time', '3', '--cacert', '/opt/volt-e2e/ca.pem', `https://127.0.0.1:${port}${route}`], { stdio: 'ignore' });
      throw new Error(`Verified HTTPS endpoint failed: ${port} (host curl=${result.status}, namespace curl=${local.status})`);
    }
    const untrusted = spawnSync('curl', ['--silent', '--max-time', '3', `https://127.0.0.1:${port}${route}`], { stdio: 'ignore' });
    if (untrusted.status !== 60) throw new Error('Private CA unexpectedly trusted without explicit CA');
  }
  const info = JSON.parse(docker(['container', 'inspect', state.containers.namespace]))[0];
  if (Object.keys(info.HostConfig.PortBindings ?? {}).length) throw new Error('Internal namespace must not publish ports');
  const proxy = JSON.parse(docker(['container', 'inspect', state.containers.proxy]))[0];
  if (proxy.HostConfig.NetworkMode !== 'host' || !proxy.HostConfig.ReadonlyRootfs || proxy.Config.User !== 'node' || proxy.Mounts.length !== 0) throw new Error('Unexpected loopback proxy authority');
  const proxyLog = docker(['logs', state.containers.proxy]);
  if (![18443, 19443].every(port => proxyLog.includes(`loopback-only TLS forwarding ready: ${port}`))) throw new Error('Loopback proxy listeners unavailable');
  const network = JSON.parse(docker(['network', 'inspect', state.network]))[0];
  if (!network.Internal) throw new Error('Network allows external routing');
  const db = JSON.parse(docker(['container', 'inspect', state.containers.postgres]))[0];
  if (Object.keys(db.HostConfig.PortBindings ?? {}).length) throw new Error('Database ports are exposed');
  docker(['exec', state.containers.cli, 'sh', '-c', 'test -z "$(ls -A "$HOME")" && test "$PWD" = /workspace && test -z "$(env | grep "^VOLT_")"']);
  const since = new Date().toISOString();
  docker(['exec', state.containers.cli, 'node', '/opt/volt-e2e/probe-relay.mjs']);
  const relayLogs = spawnSync('docker', ['logs', '--since', since, state.containers.relay], { encoding: 'utf8' });
  if (relayLogs.status !== 0) throw new Error('Cannot collect independent relay evidence');
  const logs = relayLogs.stdout + relayLogs.stderr;
  const denials = logs.split('\n').filter(line => line.includes('denied relay JWT access') && line.includes('authorization header missing')).length;
  if (!denials) throw new Error('No independent relay JWT admission-denial evidence');
  const result = { profile, publishable: false, checkedAt: new Date().toISOString(), hostTls: 'verified', defaultTrust: 'rejected', internalNetwork: true, loopbackOnly: true, postgresUnpublished: true, cliHomePristine: true, noVoltRuntimeOverrides: true, nativeUnauthenticatedAdmission: 'denied', relayDenials: denials, pairing: 'not attempted' };
  writeFileSync(join(state.root, 'verification.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log('Verified private TLS, isolated topology, pristine CLI HOME, and native unauthenticated JWT denial.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, path, infra, cli] = process.argv.slice(2);
  if (command === 'up' && path && infra && cli) await up(path, infra, cli);
  else if (command === 'down' && path) down(JSON.parse(readFileSync(join(path, 'rig.json'), 'utf8')));
  else if (command === 'verify' && path) await verify(JSON.parse(readFileSync(join(path, 'rig.json'), 'utf8')));
  else throw new Error('Usage: rig.mjs up <new-/tmp-run> <infra-artifact.json> <cli-artifact.json> | verify|down <run-dir>');
}
