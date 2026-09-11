# Public Apple attestation fixture

`apple-guide-attestation.cbor` and `apple-guide-input.txt` contain Apple's public
example from https://developer.apple.com/documentation/devicecheck/attestation-object-validation-guide.
They contain no Volt device or account evidence. The fixture chain was valid in
April 2026; its test fixes validation time accordingly.

The example signs the 24 raw bytes `example_server_challenge` as clientDataHash,
although production Volt accepts only the independently computed 32-byte hash.
The fixture has validation category 1 and build version 1; a separate assertion
checks that the TestFlight category-2 verifier rejects it.
