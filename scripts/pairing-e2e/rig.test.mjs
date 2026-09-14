import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer, get } from 'node:https';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { generateRun, privateFile } from './rig.mjs';

function request(port, ca) {
  return new Promise((resolve, reject) => {
    const req = get(`https://127.0.0.1:${port}/`, { ca }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
}
test('fresh run has exact private broker/proof contracts and genuine IP-valid TLS', async () => {
  // macOS tmpdir() may live under /var; rig artifacts deliberately use /tmp.
  const parent = mkdtempSync('/tmp/volt-rig-test-');
  try {
    const now = Math.floor(Date.now() / 1000);
    const first = generateRun(join(parent, 'first'), now);
    const second = generateRun(join(parent, 'second'), now);
    const proof = JSON.parse(readFileSync(join(first.root, 'app-proof.json'), 'utf8'));
    const other = JSON.parse(readFileSync(join(second.root, 'app-proof.json'), 'utf8'));
    assert.match(proof.runId, /^[a-f0-9]{32}$/);
    assert.ok(/^[a-f0-9]{64}$/.test(proof.proofSecret));
    assert.equal(proof.expiresAt, now + 7200);
    assert.ok(proof.runId !== other.runId && proof.proofSecret !== other.proofSecret);
    assert.deepEqual(Object.keys(proof).sort(), ['expiresAt', 'proofSecret', 'runId']);
    const config = JSON.parse(readFileSync(join(first.root, 'broker/config.json'), 'utf8'));
    assert.deepEqual(Object.keys(config).sort(), ['certificateKeyPath', 'certificatePath', 'databaseUrl', 'expiresAt', 'listenAddress', 'proofSecret', 'runId', 'signingKeyPath']);
    assert.ok(config.proofSecret === proof.proofSecret && config.runId === proof.runId);
    assert.ok(/^postgres:\/\/postgres:[a-f0-9]{64}@postgres:5432\/volt_pairing_e2e\?sslmode=disable$/.test(config.databaseUrl));
    assert.equal(config.listenAddress, '0.0.0.0:18443');
    for (const key of ['certificatePath', 'certificateKeyPath', 'signingKeyPath']) assert.equal(dirname(config[key]), '/run/private');
    function inspect(path) {
      const stat = statSync(path);
      assert.equal(stat.mode & 0o777, stat.isDirectory() ? 0o700 : 0o600);
      if (stat.isDirectory()) for (const name of readdirSync(path)) inspect(join(path, name));
      else assert.equal(stat.nlink, 1);
    }
    inspect(first.root);
    const ca = readFileSync(join(first.root, 'ca.pem'));
    const certificate = new X509Certificate(readFileSync(join(first.root, 'broker/certificate.pem')));
    assert.equal(certificate.checkIP('127.0.0.1'), '127.0.0.1');
    assert.equal(certificate.checkIP('127.0.0.2'), undefined);
    assert.ok(certificate.verify(new X509Certificate(ca).publicKey));
    assert.ok(!ca.equals(readFileSync(join(second.root, 'ca.pem'))));
    assert.ok(new X509Certificate(ca).raw.equals(readFileSync(join(first.root, 'ca.der'))));
    const server = createServer({ cert: certificate.toString(), key: readFileSync(join(first.root, 'broker/certificate-key.pem')) }, (_req, res) => { res.end('ok'); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      assert.equal(await request(server.address().port, ca), 200);
      await assert.rejects(request(server.address().port, readFileSync(join(second.root, 'ca.pem'))));
      await assert.rejects(request(server.address().port));
    } finally { await new Promise(resolve => server.close(resolve)); }
    assert.throws(() => generateRun(join(parent, 'first')), /EEXIST/);
    assert.throws(() => privateFile(join(first.root, 'app-proof.json'), 'overwrite'), /EEXIST/);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
test('run generation refuses checkout output before writing', () => {
  const path = join(dirname(fileURLToPath(import.meta.url)), 'forbidden-test-output');
  assert.throws(() => generateRun(path), /under \/tmp/);
});
