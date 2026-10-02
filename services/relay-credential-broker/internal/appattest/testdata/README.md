# Public Apple attestation fixture

`apple-guide-attestation.cbor` and `apple-guide-input.txt` contain Apple's public
example from https://developer.apple.com/documentation/devicecheck/attestation-object-validation-guide.
They contain no Volt device or account evidence. The fixture chain was valid in
April 2026; its test fixes validation time accordingly.

The example signs the 24 raw bytes `example_server_challenge` as clientDataHash,
although production Volt accepts only the independently computed 32-byte hash.
The fixture has validation category 1 and build version 1; a separate assertion
checks that the TestFlight category-2 verifier rejects it.

## Independent iPhone assertion fixtures

`independent-ios-assertions.json` extracts the four published iOS assertion
vectors from Ian Sampson's AppAttest project, pinned to commit
`f4fc1ea12c712d6833905d9c11c73c1601ae4001`:
https://github.com/iansampson/AppAttest/blob/f4fc1ea12c712d6833905d9c11c73c1601ae4001/Tests/AppAttestTests/TestData.swift

The original MIT notice is retained in `independent-ios-assertions.LICENSE`.
Only app ID, public key, client data, assertion and expected counter are copied;
no Volt user evidence is included. These are assertion-only vectors using the
published public keys, not production registration trust fixtures.

All four independently generated signatures fail the previous zero-flags check.
Changing that check alone to Apple's 0x40 exposes the second failure: Go ECDSA
verification needs SHA256(nonce), where nonce is already
SHA256(authenticatorData || clientDataHash). Both corrections are necessary
for the published signatures to verify; a changed client hash still fails.
