package appattest

import (
	"crypto/sha256"
	"crypto/x509"
	"encoding/pem"
	"os"
	"testing"
	"time"
)

// Apple's fixture signs 24 raw example challenge bytes, despite its prose
// recommending a SHA256 digest. Test the published crypto vector through the
// private byte-slice helper. The production API requires a 32-byte request hash.
func TestApplePublishedAttestationFixture(t *testing.T) {
	data, err := os.ReadFile("testdata/apple-guide-attestation.cbor")
	if err != nil {
		t.Fatal(err)
	}
	block, _ := pem.Decode(appleRootPEM)
	root, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	now := func() time.Time { return time.Date(2026, 4, 21, 0, 0, 0, 0, time.UTC) }
	v, err := newVerifier(root, "1234567890.com.example.myapp", "production", 1, now)
	if err != nil {
		t.Fatal(err)
	}
	keyID := "zgSY9YSD+7TaDXssY6WlOPVS1K3Lmk+pFhlcSWE+ZV0="
	challenge := []byte("example_server_challenge")
	if _, err = v.verifyAttestation(keyID, data, challenge, "1"); err != nil {
		t.Fatal(err)
	}
	if _, err = v.VerifyAttestation(keyID, data, sha256.Sum256(challenge), "1"); err == nil {
		t.Fatal("accepted a different challenge hash")
	}
	if _, err = v.verifyAttestation(keyID, data, challenge, "2"); err == nil {
		t.Fatal("accepted incorrect bundle version")
	}
	production, err := NewAppleVerifier("1234567890.com.example.myapp", "production", 2, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = production.verifyAttestation(keyID, data, challenge, "1"); err == nil {
		t.Fatal("accepted OS executable as TestFlight")
	}
}
