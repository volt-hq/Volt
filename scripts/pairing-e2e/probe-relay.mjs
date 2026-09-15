#!/usr/bin/env node
// A real native Iroh handshake with no JWT. The host harness separately requires
// the relay's precise missing-Authorization denial; a timeout alone is not proof.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { get } from 'node:https';

const require = createRequire('/opt/volt/package.json');
const { Endpoint, RelayMode } = require('@hansjm10/volt-iroh');
const ca = readFileSync('/opt/volt-e2e/ca.pem');
for (const port of [18443, 19443]) {
  await new Promise((resolve, reject) => {
    const request = get(`https://127.0.0.1:${port}${port === 18443 ? '/readyz' : '/'}`, { ca, timeout: 3000 }, response => {
      response.resume();
      if (response.statusCode === 200) resolve();
      else reject(new Error('Namespace HTTPS health failed'));
    });
    request.on('timeout', () => request.destroy(new Error('Namespace HTTPS timeout')));
    request.on('error', reject);
  });
}
const builder = Endpoint.builder();
builder.applyMinimal();
if (typeof builder.caRoots !== 'function') throw new Error('Local native CA binding missing');
builder.caRoots([[...readFileSync('/opt/volt-e2e/ca.der')]]);
builder.relayMode(RelayMode.customFromUrls(['https://127.0.0.1:19443']));
const deadline = setTimeout(() => process.exit(1), 25000);
const endpoint = await builder.bind();
let admitted = false;
const watch = endpoint.watchHomeRelay((errorOrUrls, urls) => {
  const current = Array.isArray(errorOrUrls) ? errorOrUrls : urls;
  if (Array.isArray(current) && current.length > 0) admitted = true;
});
try {
  // Unlike online(), the watch can be stopped before closing an endpoint that
  // must never become online; an unresolved online future pins native shutdown.
  await new Promise(resolve => setTimeout(resolve, 8000));
  if (admitted) throw new Error('Unauthenticated native endpoint was admitted');
} finally {
  await watch.stop();
  await endpoint.close();
  clearTimeout(deadline);
}
console.log('Namespace HTTPS verified; native unauthenticated endpoint remained offline.');
