package appattest

import (
	"crypto/x509"
	"testing"

	"github.com/fxamacker/cbor/v2"
)

func TestAttestationWithoutIOS27Extensions(t *testing.T) {
	f := makeAttestationFixtureWithExtensions(t, nil)
	public, err := f.verifier.VerifyAttestation(f.keyID, f.object, f.hash, "4")
	if err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*Verifier){
		func(v *Verifier) { v.rpID[0]++ },
		func(v *Verifier) { v.aaguid[0]++ },
		func(v *Verifier) { v.roots = x509.NewCertPool() },
	} {
		v := *f.verifier
		mutate(&v)
		if _, err := v.VerifyAttestation(f.keyID, f.object, f.hash, "4"); err == nil {
			t.Fatal("accepted wrong authority without extensions")
		}
	}
	changedHash := f.hash
	changedHash[0]++
	if _, err := f.verifier.VerifyAttestation(f.keyID, f.object, changedHash, "4"); RejectionReason(err) != "certificate_nonce" {
		t.Fatal("nonce check missing without extensions")
	}
	assertion := f.assertionWithExtensions(t, 1, f.hash, nil)
	var object assertionObject
	if err := cbor.Unmarshal(assertion, &object); err != nil {
		t.Fatal(err)
	}
	if len(object.AuthData) != 37 {
		t.Fatal("fixture must have exactly 37 authenticator bytes")
	}
	if counter, err := f.verifier.VerifyAssertion(public, assertion, f.hash, "4"); err != nil || counter != 1 {
		t.Fatalf("assertion without extensions: counter=%d error=%v", counter, err)
	}
	if _, err := f.verifier.VerifyAssertion(public, assertion, changedHash, "4"); err == nil {
		t.Fatal("accepted changed request without extensions")
	}
	if _, err := f.verifier.VerifyAssertion(public, f.assertionWithExtensions(t, 0, f.hash, nil), f.hash, "4"); err == nil {
		t.Fatal("accepted zero counter without extensions")
	}
	for _, mutate := range []func(*assertionObject){
		func(a *assertionObject) { a.AuthData = a.AuthData[:36] },
		func(a *assertionObject) { a.AuthData[36]++ },
		func(a *assertionObject) { a.Signature[0] ^= 1 },
	} {
		var a assertionObject
		if err := cbor.Unmarshal(assertion, &a); err != nil {
			t.Fatal(err)
		}
		mutate(&a)
		encoded, err := cbor.Marshal(a)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.verifier.VerifyAssertion(public, encoded, f.hash, "4"); err == nil {
			t.Fatal("accepted tampered assertion without extensions")
		}
	}
}

func TestSignedNonemptyExtensionsRemainStrict(t *testing.T) {
	for name, extensions := range map[string][]byte{
		"empty map": {0xa0},
		"malformed": {0xff},
		"null":      {0xf6},
		"partial":   {0xa1, 0x78, 0x17, 'a', 'p', 'p', 'l', 'e', '_', 'b', 'u', 'n', 'd', 'l', 'e', '_', 'v', 'e', 'r', 's', 'i', 'o', 'n', '_', '0', '1', 0x61, '4'},
	} {
		t.Run(name, func(t *testing.T) {
			// Sign the invalid metadata itself so rejection cannot be attributed
			// to a stale certificate nonce or assertion signature.
			f := makeAttestationFixtureWithExtensions(t, extensions)
			if _, err := f.verifier.VerifyAttestation(f.keyID, f.object, f.hash, "4"); err == nil {
				t.Fatal("accepted invalid signed attestation metadata")
			}
			valid := makeAttestationFixtureWithExtensions(t, nil)
			public, err := valid.verifier.VerifyAttestation(valid.keyID, valid.object, valid.hash, "4")
			if err != nil {
				t.Fatal(err)
			}
			assertion := valid.assertionWithExtensions(t, 1, valid.hash, extensions)
			if _, err := valid.verifier.VerifyAssertion(public, assertion, valid.hash, "4"); err == nil {
				t.Fatal("accepted invalid signed assertion metadata")
			}
		})
	}
}

func TestStrippedAssertionExtensionsRejectSignature(t *testing.T) {
	f := makeAttestationFixture(t)
	public, err := f.verifier.VerifyAttestation(f.keyID, f.object, f.hash, "4")
	if err != nil {
		t.Fatal(err)
	}
	var a assertionObject
	if err := cbor.Unmarshal(f.assertion(t, 1, f.hash), &a); err != nil {
		t.Fatal(err)
	}
	a.AuthData = a.AuthData[:37]
	encoded, err := cbor.Marshal(a)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.verifier.VerifyAssertion(public, encoded, f.hash, "4"); err == nil {
		t.Fatal("accepted stripped signed assertion metadata")
	}
}
