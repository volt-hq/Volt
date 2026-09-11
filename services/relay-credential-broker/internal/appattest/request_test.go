package appattest

import (
	"encoding/base64"
	"fmt"
	"strings"
	"testing"
)

// Regression: #387. Every authority-bearing field must change the signed hash.
func TestRegression387RequestBinding(t *testing.T) {
	r := testRequest()
	challenge := [32]byte{1}
	original, err := r.Hash("approve", challenge)
	if err != nil {
		t.Fatal(err)
	}
	mutations := []func(*Request){
		func(r *Request) { r.Issuer = "https://credentials.volt-cli.dev" },
		func(r *Request) { r.ClaimID = "another-claim" },
		func(r *Request) { r.HostNodeID = strings.Repeat("c", 64) },
		func(r *Request) { r.AppNodeID = strings.Repeat("d", 64) },
		func(r *Request) { r.RefreshHash[1]++ },
		func(r *Request) { r.ProofHash[1]++ },
		func(r *Request) { r.DeviceID = "22222222-2222-4222-8222-222222222222" },
		func(r *Request) { key := [32]byte{2}; r.KeyID = base64.StdEncoding.EncodeToString(key[:]) },
		func(r *Request) { r.AppCheckHash[1]++ },
		func(r *Request) { r.BundleVersion = "5" },
	}
	for index, mutate := range mutations {
		changed := r
		mutate(&changed)
		digest, err := changed.Hash("approve", challenge)
		if err != nil || digest == original {
			t.Fatalf("mutation %d not bound: %v", index, err)
		}
	}
	registration, err := r.Hash("register", challenge)
	if err != nil || registration == original {
		t.Fatal("purpose not bound")
	}
	other, err := r.Hash("approve", [32]byte{2})
	if err != nil || other == original {
		t.Fatal("challenge not bound")
	}
}

func TestRegression387RejectNoncanonicalRequest(t *testing.T) {
	for _, issuer := range []string{"http://credentials.volt-cli.dev", "https://user@credentials.volt-cli.dev", "https://credentials.volt-cli.dev/", "https://credentials.volt-cli.dev?x=1"} {
		r := testRequest()
		r.Issuer = issuer
		if _, err := r.Hash("approve", [32]byte{1}); err == nil {
			t.Errorf("accepted issuer %q", issuer)
		}
	}
	r := testRequest()
	r.KeyID = strings.TrimRight(r.KeyID, "=")
	if r.Validate() == nil {
		t.Fatal("accepted noncanonical key ID")
	}
	r = testRequest()
	r.ProofHash = [32]byte{}
	if r.Validate() == nil {
		t.Fatal("accepted missing proof binding")
	}
	r = testRequest()
	if _, err := r.Hash("other", [32]byte{1}); err == nil {
		t.Fatal("accepted unknown purpose")
	}
}

func testRequest() Request {
	key := [32]byte{1}
	return Request{Issuer: "https://credentials-canary.volt-cli.dev", ClaimID: "claim-one",
		HostNodeID: strings.Repeat("a", 64), AppNodeID: strings.Repeat("b", 64),
		RefreshHash: [32]byte{1}, ProofHash: [32]byte{2}, AppCheckHash: [32]byte{3},
		DeviceID: "11111111-1111-4111-8111-111111111111", KeyID: base64.StdEncoding.EncodeToString(key[:]), BundleVersion: "4"}
}

// This independently generated length-prefixed vector is also pinned in Swift.
func TestRegression387CrossLanguageRequestVector(t *testing.T) {
	digest, err := testRequest().Hash("approve", [32]byte{1})
	if err != nil || fmt.Sprintf("%x", digest) != "e3af4426c781582e77826bc0a25ca98813cab89abd4286053df3eb514d0b6757" {
		t.Fatalf("cross-language digest: %x %v", digest, err)
	}
}
