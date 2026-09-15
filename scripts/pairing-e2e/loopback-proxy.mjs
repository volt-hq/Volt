// Docker internal networks deliberately ignore -p. Expose only these two fixed
// TLS byte streams on the Linux VM's loopback; Colima forwards those to macOS.
// This helper has no secrets, Docker socket, mounts, or application protocol logic.
import { createConnection, createServer, isIP } from 'node:net';

const [target, deadlineText] = process.argv.slice(2);
const octets = target?.split('.').map(Number) ?? [];
const privateTarget = isIP(target ?? '') === 4 && (octets[0] === 10 ||
  (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
  (octets[0] === 192 && octets[1] === 168));
const deadline = Number(deadlineText);
if (!privateTarget || !Number.isSafeInteger(deadline) || deadline <= Date.now() / 1000 || deadline > Date.now() / 1000 + 7200) {
  throw new Error('Invalid private proxy destination/deadline');
}
setTimeout(() => process.exit(0), deadline * 1000 - Date.now());
for (const port of [18443, 19443]) {
  const server = createServer(front => {
    const back = createConnection({ host: target, port });
    front.on('error', () => back.destroy());
    back.on('error', () => front.destroy());
    front.on('close', () => back.destroy());
    back.on('close', () => front.destroy());
    front.pipe(back).pipe(front);
  });
  server.on('error', () => process.exit(1));
  server.listen(port, '127.0.0.1', () => console.log(`loopback-only TLS forwarding ready: ${port}`));
}
