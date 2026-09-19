//go:build volt_e2e

package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/appstore"
	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/broker"
)

const fixtureUUID = "11111111-1111-4111-8111-111111111111"
const fixtureDevice = "22222222-2222-4222-8222-222222222222"

func signedProof(c config, header, payload []byte) string {
	secret, _ := hex.DecodeString(c.ProofSecret)
	input := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(input))
	return input + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func encodeJSON(t *testing.T, value interface{}) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func appCheckToken(t *testing.T, c config, now time.Time, nonce string) string {
	t.Helper()
	return signedProof(c, []byte(`{"alg":"HS256","typ":"VOLT-E2E-APPCHECK"}`), encodeJSON(t, appCheckPayload{c.RunID, nonce, now.Unix(), now.Add(120 * time.Second).Unix()}))
}

func installationToken(t *testing.T, c config, now time.Time) string {
	t.Helper()
	return signedProof(c, []byte(`{"alg":"HS256","typ":"VOLT-E2E-INSTALLATION"}`), encodeJSON(t, installationPayload{c.RunID, fixtureUUID, fixtureDevice, now.Unix(), c.ExpiresAt}))
}

func checkRequest(token string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/", nil)
	r.Header.Set("X-Firebase-AppCheck", token)
	return r
}

func TestAppCheckStableIdentityAndExpiry(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	c := fixtureConfig(now)
	v := newProofVerifier(c, nil, func() time.Time { return now })
	token := appCheckToken(t, c, now, fixtureUUID)
	first, err := v.Verify(checkRequest(token))
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Second)
	second, err := v.Verify(checkRequest(token))
	if err != nil || first != second || !first.ReplayProtected || first.JTIHash != broker.SecretHash(sha256.Sum256([]byte(token))) {
		t.Fatal("reverification changed identity/expiry or consumed token")
	}
	now = first.ExpiresAt
	if _, err := v.Verify(checkRequest(token)); err == nil {
		t.Fatal("expired token accepted")
	}
}

func TestAppCheckRejectsInvalidProofs(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	c := fixtureConfig(now)
	v := newProofVerifier(c, nil, func() time.Time { return now })
	header := []byte(`{"alg":"HS256","typ":"VOLT-E2E-APPCHECK"}`)
	original := appCheckPayload{c.RunID, fixtureUUID, now.Unix(), now.Add(120 * time.Second).Unix()}
	for name, mutate := range map[string]func(*appCheckPayload){
		"wrong run":       func(p *appCheckPayload) { p.RunID = strings.Repeat("c", 32) },
		"bad nonce":       func(p *appCheckPayload) { p.Nonce = "not-a-uuid" },
		"uppercase nonce": func(p *appCheckPayload) { p.Nonce = "aaaaaaaa-AAAA-aaaa-aaaa-aaaaaaaaaaaa" },
		"expired":         func(p *appCheckPayload) { p.IssuedAt -= 121; p.ExpiresAt -= 120 },
		"future iat":      func(p *appCheckPayload) { p.IssuedAt += 31 },
		"zero iat":        func(p *appCheckPayload) { p.IssuedAt = 0 },
		"inverted":        func(p *appCheckPayload) { p.ExpiresAt = p.IssuedAt },
		"long lifetime":   func(p *appCheckPayload) { p.ExpiresAt++ },
		"beyond run":      func(p *appCheckPayload) { p.ExpiresAt = c.ExpiresAt + 1 },
	} {
		t.Run(name, func(t *testing.T) {
			p := original
			mutate(&p)
			if _, err := v.Verify(checkRequest(signedProof(c, header, encodeJSON(t, p)))); err == nil {
				t.Fatal("invalid proof accepted")
			}
		})
	}
	good := appCheckToken(t, c, now, fixtureUUID)
	for name, token := range map[string]string{
		"tampered":              good[:len(good)-4] + "AAAA",
		"padded":                good + "=",
		"extra segment":         good + ".x",
		"oversize":              strings.Repeat("a", maxProofBytes+1),
		"comma header":          good + "," + good,
		"space header":          " " + good,
		"wrong type":            signedProof(c, []byte(`{"alg":"HS256","typ":"VOLT-E2E-INSTALLATION"}`), encodeJSON(t, original)),
		"wrong algorithm":       signedProof(c, []byte(`{"alg":"none","typ":"VOLT-E2E-APPCHECK"}`), encodeJSON(t, original)),
		"duplicate header key":  signedProof(c, []byte(`{"alg":"HS256","alg":"HS256","typ":"VOLT-E2E-APPCHECK"}`), encodeJSON(t, original)),
		"duplicate payload key": signedProof(c, header, append([]byte(`{"runId":"`+c.RunID+`",`), encodeJSON(t, original)[1:]...)),
		"unknown field":         signedProof(c, header, append([]byte(`{"other":1,`), encodeJSON(t, original)[1:]...)),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := v.Verify(checkRequest(token)); err == nil {
				t.Fatal("invalid token accepted")
			}
		})
	}
	r := checkRequest(good)
	r.Header.Add("X-Firebase-AppCheck", good)
	if _, err := v.Verify(r); err == nil {
		t.Fatal("duplicate headers accepted")
	}
	r = checkRequest(good)
	r.Header["x-firebase-appcheck"] = []string{good}
	if _, err := v.Verify(r); err == nil {
		t.Fatal("case-aliased duplicate headers accepted")
	}
	v.expiresAt = now.Unix()
	if _, err := v.Verify(checkRequest(good)); err == nil {
		t.Fatal("expired run accepted")
	}
}

func TestInstallationProofIdentityAndBinding(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	c := fixtureConfig(now)
	v := newProofVerifier(c, nil, func() time.Time { return now })
	token := installationToken(t, c, now)
	proof := appstore.Proof{SignedAppTransaction: token, DeviceVerificationID: fixtureDevice}
	first, err := v.VerifyEntitlement(context.Background(), proof)
	if err != nil {
		t.Fatal(err)
	}
	payload, _ := base64.RawURLEncoding.DecodeString(strings.Split(token, ".")[1])
	if first.AppTransactionID != fixtureUUID || first.ApprovalProofHash != sha256.Sum256(payload) || first.Environment != "Sandbox" || first.EntitledUntil.Unix() != c.ExpiresAt {
		t.Fatal("installation identity/expiry/payload hash mismatch")
	}
	now = now.Add(10 * time.Second)
	second, err := v.VerifyEntitlement(context.Background(), proof)
	if err != nil || first.ApprovalProofHash != second.ApprovalProofHash || first.AppTransactionID != second.AppTransactionID || first.EntitledUntil != second.EntitledUntil || !second.VerifiedAt.Equal(now) || !second.SourceSignedAt.Equal(now) {
		t.Fatal("installation reverify changed stable authority or did not update verification time")
	}
	proof.DeviceVerificationID = fixtureUUID
	if _, err := v.VerifyEntitlement(context.Background(), proof); err == nil {
		t.Fatal("wrong device accepted")
	}
	proof.DeviceVerificationID = fixtureDevice
	now = time.Unix(c.ExpiresAt, 0)
	if _, err := v.VerifyEntitlement(context.Background(), proof); err == nil {
		t.Fatal("expired installation accepted")
	}
	if _, err := v.VerifyNotification(context.Background(), token); err == nil {
		t.Fatal("notification accepted")
	}
	if _, err := v.ReconcileEntitlement(context.Background(), fixtureUUID, "Production"); err == nil {
		t.Fatal("production reconciliation accepted")
	}
}

func TestInstallationRejectsInvalidProofs(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	c := fixtureConfig(now)
	v := newProofVerifier(c, nil, func() time.Time { return now })
	for name, mutate := range map[string]func(*installationPayload){
		"wrong run":        func(p *installationPayload) { p.RunID = strings.Repeat("c", 32) },
		"bad installation": func(p *installationPayload) { p.InstallationID = "installation" },
		"bad device":       func(p *installationPayload) { p.DeviceID = "device" },
		"expired":          func(p *installationPayload) { p.IssuedAt--; p.ExpiresAt = now.Unix() },
		"future":           func(p *installationPayload) { p.IssuedAt = now.Unix() + 31 },
		"beyond config":    func(p *installationPayload) { p.ExpiresAt++ },
	} {
		t.Run(name, func(t *testing.T) {
			p := installationPayload{c.RunID, fixtureUUID, fixtureDevice, now.Unix(), c.ExpiresAt}
			mutate(&p)
			token := signedProof(c, []byte(`{"alg":"HS256","typ":"VOLT-E2E-INSTALLATION"}`), encodeJSON(t, p))
			if _, err := v.VerifyEntitlement(context.Background(), appstore.Proof{SignedAppTransaction: token, DeviceVerificationID: fixtureDevice}); err == nil {
				t.Fatal("invalid installation accepted")
			}
		})
	}
	token := installationToken(t, c, now)
	token = token[:len(token)-4] + "AAAA"
	if _, err := v.VerifyEntitlement(context.Background(), appstore.Proof{SignedAppTransaction: token, DeviceVerificationID: fixtureDevice}); err == nil {
		t.Fatal("tampered installation accepted")
	}
}

func TestSyntheticAttestationIsRequestBound(t *testing.T) {
	v := syntheticAttestationVerifier{}
	key := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 32))
	digest := sha256.Sum256([]byte("request"))
	public, err := v.VerifyAttestation(key, digest[:], digest, "4")
	if err != nil || len(public) != 65 {
		t.Fatal("valid registration rejected")
	}
	repeated, _ := v.VerifyAttestation(key, digest[:], digest, "4")
	other, _ := v.VerifyAttestation(base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{2}, 32)), digest[:], digest, "4")
	if !bytes.Equal(public, repeated) || bytes.Equal(public, other) {
		t.Fatal("pseudo key is not stable and key-ID-specific")
	}
	changed := sha256.Sum256([]byte("changed request"))
	for _, object := range [][]byte{digest[:31], append(digest[:], 0), changed[:]} {
		if _, err := v.VerifyAttestation(key, object, digest, "4"); err == nil {
			t.Fatal("unbound registration accepted")
		}
	}
	assertion := make([]byte, 36)
	binary.BigEndian.PutUint32(assertion[:4], 7)
	copy(assertion[4:], digest[:])
	counter, err := v.VerifyAssertion(public, assertion, digest, "4")
	if err != nil || counter != 7 {
		t.Fatal("valid assertion rejected")
	}
	if _, err := v.VerifyAssertion(public, assertion, changed, "4"); err == nil {
		t.Fatal("changed assertion request accepted")
	}
	if _, err := v.VerifyAssertion(public, assertion[:35], digest, "4"); err == nil {
		t.Fatal("short assertion accepted")
	}
	binary.BigEndian.PutUint32(assertion[:4], 0)
	if _, err := v.VerifyAssertion(public, assertion, digest, "4"); err == nil {
		t.Fatal("zero counter accepted")
	}
}
