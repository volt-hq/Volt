# Isolated pairing credential E2E broker

Test-only Apple/Firebase boundary for the local simulator rig. Every Go file is
behind `//go:build volt_e2e`; ordinary broker builds contain no fixture verifier.
Never deploy this executable or expose its Docker ports outside loopback.
It does not validate real Apple receipts, App Attest objects, or Firebase tokens.

The normal `database.Migrate`, `credential.LoadOrCreateSigner`, `broker.New`, and
`httpapi.NewServer` implementations remain unchanged. HTTPS requests, SQL grants,
key ownership, request-bound challenge consumption, App Check replay records,
assertion counters, refresh/revocation, and Ed25519 access JWT signing are real.
There are no extra HTTP success/approval endpoints. Notifications fail closed.
The relay and simulator/native harness are separate components.

## Launch contract

From `services/relay-credential-broker`:

```sh
go run -tags volt_e2e ./cmd/relay-credential-e2e --config /absolute/private-run/config.json
```

Supply exactly these JSON fields (replace the placeholders):

```json
{
  "runId": "<32 lowercase hex characters>",
  "proofSecret": "<64 lowercase hex characters, freshly random>",
  "expiresAt": 0,
  "databaseUrl": "postgres://postgres:<run-local-password>@postgres:5432/volt_pairing_e2e?sslmode=disable",
  "signingKeyPath": "/absolute/private-run/signing-key",
  "certificatePath": "/absolute/private-run/certificate.pem",
  "certificateKeyPath": "/absolute/private-run/certificate-key.pem",
  "listenAddress": "0.0.0.0:18443"
}
```

`expiresAt` is an integer Unix second strictly after startup and at most two
hours ahead. It is rechecked during verification and before every HTTP request;
the listener shuts down when the run expires. Already-issued access JWTs retain
the normal 15-minute lifetime; the rig must tear down the relay at run end.

Issuer is pinned to **`https://127.0.0.1:18443`** and audience to
**`volt-iroh-relay-e2e`**. Neither has a configuration or environment override.
The executable discards its inherited environment before loading configuration,
never initializes KMS/Apple/Firebase verifiers, and disables pgx's default
password-file read. Do not log the config, proofs, tokens, or pairing secrets.

The database URL must use `postgres` or `postgresql`, explicit nonempty username
and password, database `volt_pairing_e2e`, host exactly `127.0.0.1` or `postgres`,
and query exactly `sslmode=disable`. An optional canonical port is allowed.
No service files, alternate hosts, query overrides, cloud hosts, or other
databases are accepted. `postgres` DNS answers must be private or loopback.
PostgreSQL is plaintext only within the disposable local/Docker rig; the broker
HTTP listener always uses TLS 1.2 or later. Listeners are restricted to
`127.0.0.1:18443` and `0.0.0.0:18443`; the latter is for a Docker-internal network
with **host publishing restricted to loopback**. The rig owns network isolation.

### Private-file policy

A simple same-owner policy is intentional:

- Config path and all asset paths are absolute, clean paths to **distinct sibling
  files in the same run directory** (no asset subdirectories).
- Run directory: mode `0700`, owned by the effective UID, not a symlink.
- Config: regular file, mode exactly `0600`, same owner, one hard link, no symlink,
  at most 16 KiB. All fields are required; duplicate, unknown, case-aliased, null,
  and trailing JSON fields/values are rejected.
- Existing signing seed, TLS certificate, and TLS private key have the same
  regular-file/owner/0600/single-link requirements and 16 KiB limit. The signing
  seed alone may be absent and is created by the existing signer implementation.
- Config and certificate reads use `O_NOFOLLOW` plus file identity checks.
  Ancestor aliases such as macOS `/tmp` are resolved once. The run directory and
  its trusted ancestors must not be renamed or edited concurrently. Same-UID
  malicious processes and root are outside this private fixture boundary; the
  existing signer reopens its validated path. Do not reuse production files.

The rig must supply a certificate valid for `127.0.0.1` and install its test CA in
its clients. No client trust checks or hostname verification are relaxed here.

## Synthetic proof contract

Both proofs have three **canonical, unpadded base64url** segments:

```text
base64url(header JSON).base64url(payload JSON).base64url(HMAC-SHA256)
```

HMAC input is the exact first two segments joined by `.`; its key is the 32 raw
bytes decoded from `proofSecret`. MAC length is exactly 32 bytes. Total token
limit is 4096 bytes; encoded header and payload limits are 256 and 2048 bytes.
JSON key order/whitespace is not prescribed, but fields are exact and unique.

App Check header and payload:

```json
{"alg":"HS256","typ":"VOLT-E2E-APPCHECK"}
{"runId":"<runId>","nonce":"<lowercase UUID>","iat":0,"exp":0}
```

Installation header and payload:

```json
{"alg":"HS256","typ":"VOLT-E2E-INSTALLATION"}
{"runId":"<runId>","installationId":"<lowercase UUID>","deviceId":"<lowercase UUID>","iat":0,"exp":0}
```

For both: exact run ID, positive integer `iat`, `iat <= now + 30 seconds`, and
`iat < exp <= config.expiresAt`, with `exp > now`. App Check additionally requires
`exp <= iat + 120 seconds`. Installation `deviceId` must equal the incoming
`appStoreDeviceVerificationId` byte-for-byte. UUIDs use lowercase 8-4-4-4-12 hex.

App Check requires exactly one `X-Firebase-AppCheck` header. Reverification does
not consume anything: it returns `ReplayProtected: true`, the original `exp`,
and `JTIHash = SHA256(raw compact token UTF-8 bytes)`. Keep that token stable
through status, registration challenge/register, approval challenge/approve.
An approval retry needs a new token/nonce and challenge and a higher counter.

Installation `ApprovalProofHash = SHA256(raw decoded payload bytes)`, matching
the Swift coordinator. `installationId` is the stable entitlement identity;
`Sandbox`, product `volt.e2e.synthetic.pro`, and group `volt-e2e-synthetic` are
fixed. Entitlement expiry is the signed proof expiry, never a sliding window.
Verification/source timestamps are current; proof creation time is its `iat`.
Reconciliation reads the already-persisted synthetic entitlement and preserves
identity, environment, and expiry (bounded by the current run deadline), even
after verifier restart. Unknown identities and all notifications are denied.

Synthetic App Attest objects reuse the normal request hash from
`internal/appattest.Request.Hash`:

- Registration: exactly the 32 raw request-digest bytes, padded standard base64
  in the HTTP `attestation` field.
- Assertion: four-byte big-endian nonzero counter followed by the 32 request
  digest bytes, padded standard base64 in `assertion` (36 decoded bytes).
- Key ID: the normal canonical padded base64 encoding of 32 bytes.
- Pseudo public key: `0x04 || SHA256("volt-e2e-key-x\0" || decodedKeyID) ||
  SHA256("volt-e2e-key-y\0" || decodedKeyID)` (65 bytes; not a P-256 point).

The database, not the synthetic verifier, enforces increasing counters and
immutable key ownership. Request hashing still binds issuer, claim, host/app
node IDs, refresh hash, installation payload hash, device ID, key ID, raw App
Check hash, bundle version, purpose, and the server-issued challenge.

## Validation

```sh
go test -tags volt_e2e -v ./cmd/relay-credential-e2e
VOLT_TEST_DATABASE_URL='postgres://postgres:<disposable-password>@127.0.0.1:15433/volt_pairing_e2e?sslmode=disable' \
  go test -tags volt_e2e -race -v ./cmd/relay-credential-e2e
go vet -tags volt_e2e ./cmd/relay-credential-e2e
```

Without `VOLT_TEST_DATABASE_URL`, the PostgreSQL test explicitly skips. With it,
`internal/testdatabase.Open` creates and drops only its random test schema.
The URL is first checked against the fixture database allowlist. Tests exercise
actual HTTPS with normal certificate trust, registration and failed-registration
rollback, request mutation rejection, atomic approval/replay, counter rollback
and advance, idempotent authority on retry, real app/host JWTs, exchange,
refresh, reconciliation, and expiry. These tests do not claim real Apple,
Firebase, simulator, or relay acceptance.
