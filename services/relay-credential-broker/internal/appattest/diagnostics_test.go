package appattest

import (
	"errors"
	"fmt"
	"testing"

	"github.com/fxamacker/cbor/v2"
)

func TestRegression387AttestationRejectionDiagnostics(t *testing.T) {
	fixture := makeAttestationFixture(t)
	for _, tc := range []struct {
		name   string
		mutate func(*Verifier, *attestationObject)
	}{
		{"app_identifier", func(v *Verifier, _ *attestationObject) { v.rpID[0]++ }},
		{"attestation_environment", func(v *Verifier, _ *attestationObject) { v.aaguid[0]++ }},
		{"validation_category_mismatch", func(v *Verifier, _ *attestationObject) { v.category = 4 }},
		{"authenticator_flags", func(_ *Verifier, a *attestationObject) { a.AuthData[32] = 0xc0 }},
		{"initial_counter", func(_ *Verifier, a *attestationObject) { a.AuthData[36] = 1 }},
		// Stripping signed extensions cannot turn an attestation into the
		// valid format without extensions: its certificate nonce must fail.
		{"certificate_nonce", func(v *Verifier, a *attestationObject) {
			var key coseKey
			rest, err := v.decode.UnmarshalFirst(a.AuthData[87:], &key)
			if err != nil {
				t.Fatal(err)
			}
			a.AuthData = a.AuthData[:len(a.AuthData)-len(rest)]
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			v := *fixture.verifier
			var object attestationObject
			if err := cbor.Unmarshal(fixture.object, &object); err != nil {
				t.Fatal(err)
			}
			tc.mutate(&v, &object)
			encoded, err := cbor.Marshal(object)
			if err != nil {
				t.Fatal(err)
			}
			_, err = v.VerifyAttestation(fixture.keyID, encoded, fixture.hash, "4")
			if !errors.Is(err, ErrInvalid) || RejectionReason(err) != tc.name {
				t.Fatalf("reason=%s error=%v", RejectionReason(err), err)
			}
			if err.Error() != ErrInvalid.Error() {
				t.Fatal("public error changed")
			}
		})
	}
	_, err := fixture.verifier.VerifyAttestation(fixture.keyID, fixture.object, fixture.hash, "5")
	if RejectionReason(err) != "bundle_version_mismatch" {
		t.Fatal(RejectionReason(err))
	}
	changedHash := fixture.hash
	changedHash[0]++
	_, err = fixture.verifier.VerifyAttestation(fixture.keyID, fixture.object, changedHash, "4")
	if RejectionReason(fmt.Errorf("untrusted secret detail: %w", err)) != "certificate_nonce" {
		t.Fatal(RejectionReason(err))
	}
	if RejectionReason(errors.New("receipt=secret token=secret")) != "unclassified" {
		t.Fatal("arbitrary error exposed")
	}
}
