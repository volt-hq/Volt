package appattest

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/base64"
	"encoding/binary"
	"math/big"
	"testing"
	"time"

	"github.com/fxamacker/cbor/v2"
)

func TestRegression387AppleAttestationAndAssertion(t *testing.T) {
	fixture := makeAttestationFixture(t)
	publicKey, err := fixture.verifier.VerifyAttestation(fixture.keyID, fixture.object, fixture.hash, "4")
	if err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*Verifier){
		func(v *Verifier) { v.rpID[0]++ }, func(v *Verifier) { v.aaguid[0]++ },
		func(v *Verifier) { v.category = 4 }, func(v *Verifier) { v.now = func() time.Time { return fixture.now.Add(48 * time.Hour) } },
		func(v *Verifier) { v.roots = x509.NewCertPool() },
	} {
		changed := *fixture.verifier
		mutate(&changed)
		if _, err := changed.VerifyAttestation(fixture.keyID, fixture.object, fixture.hash, "4"); err == nil {
			t.Fatal("accepted wrong authority")
		}
	}
	if _, err := fixture.verifier.VerifyAttestation(base64.StdEncoding.EncodeToString(make([]byte, 32)), fixture.object, fixture.hash, "4"); err == nil {
		t.Fatal("accepted wrong key ID")
	}
	changedHash := fixture.hash
	changedHash[0]++
	if _, err := fixture.verifier.VerifyAttestation(fixture.keyID, fixture.object, changedHash, "4"); err == nil {
		t.Fatal("accepted wrong nonce")
	}
	for _, counter := range []uint32{1, 2, 4294967295} {
		assertion := fixture.assertion(t, counter, fixture.hash)
		got, err := fixture.verifier.VerifyAssertion(publicKey, assertion, fixture.hash, "4")
		if err != nil || got != counter {
			t.Fatalf("assertion counter %d: %d %v", counter, got, err)
		}
		if _, err = fixture.verifier.VerifyAssertion(publicKey, assertion, changedHash, "4"); err == nil {
			t.Fatal("accepted altered request")
		}
		if _, err = fixture.verifier.VerifyAssertion(publicKey, assertion, fixture.hash, "5"); err == nil {
			t.Fatal("accepted wrong assertion build")
		}
		var object assertionObject
		if err = cbor.Unmarshal(assertion, &object); err != nil {
			t.Fatal(err)
		}
		object.AuthData[33]++
		altered, _ := cbor.Marshal(object)
		if _, err = fixture.verifier.VerifyAssertion(publicKey, altered, fixture.hash, "4"); err == nil {
			t.Fatal("accepted counter tampering")
		}
	}
	if _, err := fixture.verifier.VerifyAssertion(publicKey, fixture.assertion(t, 0, fixture.hash), fixture.hash, "4"); err == nil {
		t.Fatal("accepted zero counter")
	}
}

func TestRegression387MalformedCBOR(t *testing.T) {
	fixture := makeAttestationFixture(t)
	publicKey, err := fixture.verifier.VerifyAttestation(fixture.keyID, fixture.object, fixture.hash, "4")
	if err != nil {
		t.Fatal(err)
	}
	for _, data := range [][]byte{nil, {0xff}, {0xa2, 0x61, 'x', 0x01, 0x61, 'x', 0x02}, bytes.Repeat([]byte{0x81}, 100), append(fixture.object, 0), bytes.Repeat([]byte{0}, maxAttestationBytes+1)} {
		if _, err := fixture.verifier.VerifyAttestation(fixture.keyID, data, fixture.hash, "4"); err == nil {
			t.Fatal("accepted malformed attestation")
		}
		if _, err := fixture.verifier.VerifyAssertion(publicKey, data, fixture.hash, "4"); err == nil {
			t.Fatal("accepted malformed assertion")
		}
	}
}

type attestationFixture struct {
	verifier *Verifier
	key      *ecdsa.PrivateKey
	keyID    string
	object   []byte
	hash     [32]byte
	now      time.Time
}

func makeAttestationFixture(t *testing.T) attestationFixture {
	t.Helper()
	return makeAttestationFixtureWithExtensions(t, fixtureExtensions(t))
}

func makeAttestationFixtureWithExtensions(t *testing.T, extensions []byte) attestationFixture {
	t.Helper()
	now := time.Date(2026, 9, 11, 15, 0, 0, 0, time.UTC)
	generate := func() *ecdsa.PrivateKey {
		key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		return key
	}
	rootKey, intermediateKey, key := generate(), generate(), generate()
	certificate := func(serial int64, ca bool) *x509.Certificate {
		return &x509.Certificate{SerialNumber: big.NewInt(serial), Subject: pkix.Name{CommonName: "test-only App Attest"}, NotBefore: now.Add(-time.Hour), NotAfter: now.Add(24 * time.Hour), IsCA: ca, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign}
	}
	issue := func(template, parent *x509.Certificate, public *ecdsa.PublicKey, signer *ecdsa.PrivateKey) *x509.Certificate {
		der, err := x509.CreateCertificate(rand.Reader, template, parent, public, signer)
		if err != nil {
			t.Fatal(err)
		}
		cert, err := x509.ParseCertificate(der)
		if err != nil {
			t.Fatal(err)
		}
		return cert
	}
	rootTemplate := certificate(1, true)
	root := issue(rootTemplate, rootTemplate, &rootKey.PublicKey, rootKey)
	intermediate := issue(certificate(2, true), root, &intermediateKey.PublicKey, rootKey)
	v, err := newVerifier(root, "1234567890.com.example.myapp", "production", 2, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	public := elliptic.Marshal(key.Curve, key.X, key.Y)
	keyHash := sha256.Sum256(public)
	auth := append([]byte(nil), v.rpID[:]...)
	auth = append(auth, 0x40, 0, 0, 0, 0)
	auth = append(auth, v.aaguid[:]...)
	auth = append(auth, 0, 32)
	auth = append(auth, keyHash[:]...)
	cose, err := cbor.Marshal(coseKey{Type: 2, Algorithm: -7, Curve: 1, X: public[1:33], Y: public[33:]})
	if err != nil {
		t.Fatal(err)
	}
	auth = append(auth, cose...)
	auth = append(auth, extensions...)
	hash := sha256.Sum256([]byte("independently bound request"))
	nonce := sha256.Sum256(append(append([]byte(nil), auth...), hash[:]...))
	extension, err := asn1.Marshal(struct {
		Value []byte `asn1:"explicit,tag:1"`
	}{nonce[:]})
	if err != nil {
		t.Fatal(err)
	}
	leafTemplate := certificate(3, false)
	leafTemplate.KeyUsage = x509.KeyUsageDigitalSignature
	leafTemplate.ExtraExtensions = []pkix.Extension{{Id: asn1.ObjectIdentifier{1, 2, 840, 113635, 100, 8, 2}, Value: extension}}
	leaf := issue(leafTemplate, intermediate, &key.PublicKey, intermediateKey)
	var object attestationObject
	object.Format = "apple-appattest"
	object.AuthData = auth
	object.Statement.Certificates = [][]byte{leaf.Raw, intermediate.Raw}
	object.Statement.Receipt = []byte("test-only receipt")
	encoded, err := cbor.Marshal(object)
	if err != nil {
		t.Fatal(err)
	}
	return attestationFixture{verifier: v, key: key, keyID: base64.StdEncoding.EncodeToString(keyHash[:]), object: encoded, hash: hash, now: now}
}

func fixtureExtensions(t *testing.T) []byte {
	t.Helper()
	data, err := cbor.Marshal(map[string]interface{}{"apple_validation_category_01": []byte{2, 0, 0, 0}, "apple_bundle_version_01": "4"})
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func (f attestationFixture) assertion(t *testing.T, counter uint32, hash [32]byte) []byte {
	t.Helper()
	return f.assertionWithExtensions(t, counter, hash, fixtureExtensions(t))
}

func (f attestationFixture) assertionWithExtensions(t *testing.T, counter uint32, hash [32]byte, extensions []byte) []byte {
	t.Helper()
	auth := append([]byte(nil), f.verifier.rpID[:]...)
	auth = append(auth, 0, 0, 0, 0, 0)
	binary.BigEndian.PutUint32(auth[33:], counter)
	auth = append(auth, extensions...)
	digest := sha256.Sum256(append(append([]byte(nil), auth...), hash[:]...))
	signature, err := ecdsa.SignASN1(rand.Reader, f.key, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	data, err := cbor.Marshal(assertionObject{Signature: signature, AuthData: auth})
	if err != nil {
		t.Fatal(err)
	}
	return data
}
