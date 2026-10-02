package httpapi

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/appattest"
	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/appstore"
	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/broker"
)

// Test-only trust boundaries. The production Apple and Firebase verifiers have
// separate signed fixture tests; these doubles bind the exact HTTP inputs.
type testLimitedUseVerifier struct{ now func() time.Time }

func (v testLimitedUseVerifier) Verify(r *http.Request) (VerifiedAppCheck, error) {
	token, ok := singleHeaderValue(r.Header, "X-Firebase-AppCheck")
	if !ok || !strings.HasPrefix(token, developmentAppCheckToken) {
		return VerifiedAppCheck{}, broker.ErrAppCheckInvalid
	}
	return VerifiedAppCheck{AppID: "test-app", JTIHash: broker.SecretHash(sha256.Sum256([]byte(token))), ExpiresAt: v.now().Add(time.Hour), ReplayProtected: true}, nil
}

type testAttestationVerifier struct{}

func (testAttestationVerifier) VerifyAttestation(_ string, object []byte, hash [32]byte, _ string) ([]byte, error) {
	if !bytes.Equal(object, hash[:]) {
		return nil, appattest.ErrInvalid
	}
	return make([]byte, 65), nil
}
func (testAttestationVerifier) VerifyAssertion(_ []byte, object []byte, hash [32]byte, _ string) (uint32, error) {
	if len(object) != 36 || !bytes.Equal(object[4:], hash[:]) {
		return 0, appattest.ErrInvalid
	}
	return binary.BigEndian.Uint32(object[:4]), nil
}
func (s *testService) requestWithAttestation(t *testing.T, method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	body, headers = s.attestedBody(t, path, body, headers)
	return s.request(t, method, path, body, headers)
}
func (s *testService) attestedBody(t *testing.T, path, body string, headers map[string]string) (string, map[string]string) {
	t.Helper()
	var fields map[string]string
	if err := json.Unmarshal([]byte(body), &fields); err != nil {
		t.Fatal(err)
	}
	claimID := strings.TrimSuffix(strings.TrimPrefix(path, "/v1/pairing-claims/"), "/approve")
	var host string
	if err := s.pool.QueryRow(context.Background(), "SELECT host_node_id FROM pairing_claims WHERE id=$1", claimID).Scan(&host); err != nil {
		t.Fatal(err)
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		t.Fatal(err)
	}
	token := developmentAppCheckToken + base64.RawURLEncoding.EncodeToString(key)
	headers = map[string]string{"X-Firebase-AppCheck": token}
	fields["keyId"] = base64.StdEncoding.EncodeToString(key)
	fields["hostNodeId"] = host
	fields["bundleVersion"] = "4"
	entitlement, err := s.handler.appStore.VerifyEntitlement(context.Background(), appstore.Proof{SignedAppTransaction: fields["signedAppTransaction"], DeviceVerificationID: fields["appStoreDeviceVerificationId"]})
	if err != nil {
		t.Fatal(err)
	}
	refresh, err := broker.ParseSecretHash(fields["appRefreshTokenHash"])
	if err != nil {
		t.Fatal(err)
	}
	r := appattest.Request{Issuer: "https://credentials.volt.test", ClaimID: claimID, HostNodeID: host, AppNodeID: fields["appNodeId"], RefreshHash: [32]byte(refresh), ProofHash: entitlement.ApprovalProofHash, DeviceID: fields["appStoreDeviceVerificationId"], KeyID: fields["keyId"], AppCheckHash: sha256.Sum256([]byte(token)), BundleVersion: "4"}
	base := strings.TrimSuffix(path, "approve")
	status := s.request(t, http.MethodPost, base+"attestation/status", encodeBody(t, fields), headers)
	if status.Code != http.StatusOK || strings.Contains(status.Body.String(), "true") {
		t.Fatalf("new key status: %d %s", status.Code, status.Body.String())
	}
	for _, purpose := range []string{"register", "approve"} {
		fields["purpose"] = purpose
		response := s.request(t, http.MethodPost, base+"attestation/challenge", encodeBody(t, fields), headers)
		if response.Code != http.StatusOK {
			t.Fatalf("challenge: %d %s", response.Code, response.Body.String())
		}
		var challenge broker.AttestationChallenge
		decodeResponse(t, response, &challenge)
		nonce, err := base64.RawURLEncoding.DecodeString(challenge.Challenge)
		if err != nil {
			t.Fatal(err)
		}
		hash, err := r.Hash(purpose, [32]byte(nonce))
		if err != nil {
			t.Fatal(err)
		}
		delete(fields, "purpose")
		fields["challenge"] = challenge.Challenge
		if purpose == "register" {
			fields["attestation"] = base64.StdEncoding.EncodeToString(hash[:])
			registered := s.request(t, http.MethodPost, base+"attestation/register", encodeBody(t, fields), headers)
			if registered.Code != http.StatusOK {
				t.Fatalf("registration: %d %s", registered.Code, registered.Body.String())
			}
			delete(fields, "attestation")
			delete(fields, "challenge")
		} else {
			assertion := make([]byte, 36)
			binary.BigEndian.PutUint32(assertion, 1)
			copy(assertion[4:], hash[:])
			fields["assertion"] = base64.StdEncoding.EncodeToString(assertion)
		}
	}
	return encodeBody(t, fields), headers
}

func TestRegression387ApprovalRejectsMissingAndReplayedAttestation(t *testing.T) {
	s := newTestService(t)
	claim := s.createBootstrapClaim(t, strings.Repeat("a", 64), testSecret("vpc_", 61), testSecret("vrr_", 62))
	path := "/v1/pairing-claims/" + claim.ClaimID + "/approve"
	body := encodeBody(t, map[string]string{"appNodeId": strings.Repeat("b", 64), "appRefreshTokenHash": secretHash(testSecret("vrr_", 63)), "signedAppTransaction": testSignedAppTransaction(defaultSubscriptionID, claim.ClaimID), "appStoreDeviceVerificationId": testDeviceVerificationID})
	missing := s.request(t, http.MethodPost, path, body, map[string]string{"X-Firebase-AppCheck": developmentAppCheckToken})
	if missing.Code == http.StatusOK {
		t.Fatal("receipt without attestation approved")
	}
	bound, headers := s.attestedBody(t, path, body, nil)
	var mutated map[string]string
	_ = json.Unmarshal([]byte(bound), &mutated)
	mutated["appNodeId"] = strings.Repeat("c", 64)
	response := s.request(t, http.MethodPost, path, encodeBody(t, mutated), headers)
	if response.Code == http.StatusOK {
		t.Fatal("mutated request approved")
	}
	response = s.request(t, http.MethodPost, path, bound, headers)
	if response.Code != http.StatusOK {
		t.Fatalf("failed request consumed proof: %d %s", response.Code, response.Body.String())
	}
	response = s.request(t, http.MethodPost, path, bound, headers)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("replayed assertion: %d", response.Code)
	}
}
