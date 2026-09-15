//go:build volt_e2e

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/appattest"
	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/broker"
	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/credential"
	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/testdatabase"
)

func TestPostgreSQLHTTPApprovalReplayAndCounters(t *testing.T) {
	// Never point the schema-creating helper at an inherited production database.
	if value := os.Getenv("VOLT_TEST_DATABASE_URL"); value != "" && validateDatabaseURL(value) != nil {
		t.Fatal("VOLT_TEST_DATABASE_URL must select the isolated local volt_pairing_e2e database")
	}
	pool := testdatabase.Open(t)
	var clock atomic.Int64
	clock.Store(time.Now().UTC().Truncate(time.Second).Unix())
	now := func() time.Time { return time.Unix(clock.Load(), 0).UTC() }
	c := fixtureConfig(now())
	signer, err := credential.LoadOrCreateSigner(issuer, audience, filepath.Join(t.TempDir(), "signing-key"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = signer.Close() })
	handler, err := newHandler(c, pool, signer, now)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewTLSServer(handler)
	t.Cleanup(server.Close)
	// httptest's client trusts only its test certificate; no InsecureSkipVerify.
	client := server.Client()
	post := func(path string, fields map[string]string, token, bearer string, want int) []byte {
		t.Helper()
		var body []byte
		if fields != nil {
			body = encodeJSON(t, fields)
		}
		r, err := http.NewRequest(http.MethodPost, server.URL+path, bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		if fields != nil {
			r.Header.Set("Content-Type", "application/json")
		}
		if token != "" {
			r.Header.Set("X-Firebase-AppCheck", token)
		}
		if bearer != "" {
			r.Header.Set("Authorization", "Bearer "+bearer)
		}
		response, err := client.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		data, err := io.ReadAll(io.LimitReader(response.Body, 16*1024+1))
		if err != nil || len(data) > 16*1024 {
			t.Fatal("invalid HTTP response")
		}
		if response.StatusCode != want {
			t.Fatalf("%s status=%d want=%d body=%s", path, response.StatusCode, want, data)
		}
		return data
	}
	secret := func(prefix string, fill byte) string {
		return prefix + base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{fill}, 32))
	}
	hash := func(value string) string {
		digest := sha256.Sum256([]byte(value))
		return base64.RawURLEncoding.EncodeToString(digest[:])
	}
	claimSecret, hostRefresh, appRefresh := secret("vpc_", 1), secret("vrr_", 2), secret("vrr_", 3)
	var claim broker.PairingClaim
	if err := json.Unmarshal(post("/v1/pairing-claims", map[string]string{
		"hostNodeId": strings.Repeat("a", 64), "claimSecretHash": hash(claimSecret), "hostRefreshTokenHash": hash(hostRefresh),
	}, "", "", http.StatusCreated), &claim); err != nil {
		t.Fatal(err)
	}
	base := "/v1/pairing-claims/" + claim.ClaimID + "/"
	post(base+"exchange", nil, "", claimSecret, http.StatusAccepted)
	token := appCheckToken(t, c, now(), fixtureUUID)
	fields := map[string]string{
		"hostNodeId": strings.Repeat("a", 64), "appNodeId": strings.Repeat("b", 64),
		"appRefreshTokenHash": hash(appRefresh), "signedAppTransaction": installationToken(t, c, now()),
		"appStoreDeviceVerificationId": fixtureDevice,
		"keyId":                        base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{5}, 32)), "bundleVersion": "4",
	}
	post(base+"attestation/status", fields, "", "", http.StatusUnauthorized)
	var status struct {
		KeyRegistered bool `json:"keyRegistered"`
	}
	if err := json.Unmarshal(post(base+"attestation/status", fields, token, "", http.StatusOK), &status); err != nil || status.KeyRegistered {
		t.Fatal("new key already registered")
	}
	challenge := func(purpose string, counter uint32) {
		t.Helper()
		delete(fields, "challenge")
		delete(fields, "attestation")
		delete(fields, "assertion")
		fields["purpose"] = purpose
		var nonce broker.AttestationChallenge
		if err := json.Unmarshal(post(base+"attestation/challenge", fields, token, "", http.StatusOK), &nonce); err != nil {
			t.Fatal(err)
		}
		delete(fields, "purpose")
		fields["challenge"] = nonce.Challenge
		decoded, err := base64.RawURLEncoding.DecodeString(nonce.Challenge)
		if err != nil || len(decoded) != 32 {
			t.Fatal("invalid challenge")
		}
		proof, err := base64.RawURLEncoding.DecodeString(strings.Split(fields["signedAppTransaction"], ".")[1])
		if err != nil {
			t.Fatal(err)
		}
		refresh, err := broker.ParseSecretHash(fields["appRefreshTokenHash"])
		if err != nil {
			t.Fatal(err)
		}
		bound := appattest.Request{
			Issuer: issuer, ClaimID: claim.ClaimID, HostNodeID: fields["hostNodeId"], AppNodeID: fields["appNodeId"],
			RefreshHash: [32]byte(refresh), ProofHash: sha256.Sum256(proof), DeviceID: fields["appStoreDeviceVerificationId"],
			KeyID: fields["keyId"], AppCheckHash: sha256.Sum256([]byte(token)), BundleVersion: fields["bundleVersion"],
		}
		digest, err := bound.Hash(purpose, [32]byte(decoded))
		if err != nil {
			t.Fatal(err)
		}
		if purpose == "register" {
			fields["attestation"] = base64.StdEncoding.EncodeToString(digest[:])
		} else {
			object := make([]byte, 36)
			binary.BigEndian.PutUint32(object[:4], counter)
			copy(object[4:], digest[:])
			fields["assertion"] = base64.StdEncoding.EncodeToString(object)
		}
	}
	challenge("register", 0)
	registration := fields["attestation"]
	fields["attestation"] = base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0}, 32))
	post(base+"attestation/register", fields, token, "", http.StatusUnauthorized)
	fields["attestation"] = registration
	post(base+"attestation/register", fields, token, "", http.StatusOK)
	delete(fields, "challenge")
	delete(fields, "attestation")
	if err := json.Unmarshal(post(base+"attestation/status", fields, token, "", http.StatusOK), &status); err != nil || !status.KeyRegistered {
		t.Fatal("registered key not durable")
	}
	if testdatabase.Count(t, pool, "consumed_app_check_tokens") != 0 {
		t.Fatal("registration consumed App Check")
	}
	challenge("approve", 1)
	fields["appNodeId"] = strings.Repeat("c", 64)
	post(base+"approve", fields, token, "", http.StatusUnauthorized)
	fields["appNodeId"] = strings.Repeat("b", 64)
	var approval broker.Approval
	if err := json.Unmarshal(post(base+"approve", fields, token, "", http.StatusOK), &approval); err != nil {
		t.Fatal(err)
	}
	claims, err := signer.Verify(approval.Credential.AccessToken, now())
	if err != nil || claims.Issuer != issuer || claims.Audience != audience || claims.Subject != fields["appNodeId"] || claims.EndpointKind != "app" {
		t.Fatal("invalid real app JWT")
	}
	post(base+"approve", fields, token, "", http.StatusUnauthorized)
	delete(fields, "challenge")
	delete(fields, "assertion")
	fields["purpose"] = "approve"
	post(base+"attestation/challenge", fields, token, "", http.StatusUnauthorized)
	delete(fields, "purpose")
	if testdatabase.Count(t, pool, "grants") != 1 || testdatabase.Count(t, pool, "endpoints") != 2 || testdatabase.Count(t, pool, "consumed_app_check_tokens") != 1 {
		t.Fatal("approval/replay changed durable counts")
	}

	// A fresh token/challenge cannot reuse a committed counter. Failure must
	// roll back both challenge and token, allowing a corrected higher counter.
	token = appCheckToken(t, c, now(), "33333333-3333-4333-8333-333333333333")
	challenge("approve", 1)
	post(base+"approve", fields, token, "", http.StatusUnauthorized)
	assertion, err := base64.StdEncoding.DecodeString(fields["assertion"])
	if err != nil {
		t.Fatal(err)
	}
	binary.BigEndian.PutUint32(assertion[:4], 2)
	fields["assertion"] = base64.StdEncoding.EncodeToString(assertion)
	var retry broker.Approval
	if err := json.Unmarshal(post(base+"approve", fields, token, "", http.StatusOK), &retry); err != nil {
		t.Fatal(err)
	}
	if retry.GrantID != approval.GrantID || retry.EndpointID != approval.EndpointID || retry.Credential.AccessToken == approval.Credential.AccessToken {
		t.Fatal("exact retry did not retain authority and mint fresh JWT")
	}
	var counter int64
	if err := pool.QueryRow(context.Background(), "SELECT assertion_counter FROM pairing_attestation_keys WHERE key_id=$1", fields["keyId"]).Scan(&counter); err != nil || counter != 2 {
		t.Fatal("counter not durably advanced")
	}
	var exchange broker.Exchange
	if err := json.Unmarshal(post(base+"exchange", nil, "", claimSecret, http.StatusOK), &exchange); err != nil {
		t.Fatal(err)
	}
	hostClaims, err := signer.Verify(exchange.Credential.AccessToken, now())
	if err != nil || hostClaims.Subject != strings.Repeat("a", 64) || hostClaims.EndpointKind != "host" || hostClaims.GrantID != approval.GrantID {
		t.Fatal("invalid real host JWT")
	}
	post("/v1/tokens/refresh", nil, "", hostRefresh, http.StatusOK)
	post("/v1/tokens/refresh", nil, "", appRefresh, http.StatusOK)

	// Reconciliation after a verifier restart must preserve the stored proof
	// expiry, identity and environment, not manufacture an extra hour of access.
	verifier := newProofVerifier(c, pool, now)
	entitlement, err := verifier.ReconcileEntitlement(context.Background(), fixtureUUID, "Sandbox")
	if err != nil || entitlement.AppTransactionID != fixtureUUID || entitlement.Environment != "Sandbox" || entitlement.EntitledUntil.Unix() != c.ExpiresAt {
		t.Fatal("reconciliation changed authority")
	}
	if _, err := verifier.ReconcileEntitlement(context.Background(), fixtureDevice, "Sandbox"); err == nil {
		t.Fatal("unknown identity reconciled")
	}
	post("/v1/app-store/notifications", map[string]string{"signedPayload": installationToken(t, c, now())}, "", "", http.StatusUnauthorized)
	clock.Store(c.ExpiresAt)
	post("/v1/tokens/refresh", nil, "", hostRefresh, http.StatusServiceUnavailable)
}
