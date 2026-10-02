package httpapi

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"testing"
)

func TestRegression387RegistrationLogsOnlyBoundedReason(t *testing.T) {
	s := newTestService(t)
	claim := s.createBootstrapClaim(t, strings.Repeat("a", 64), testSecret("vpc_", 71), testSecret("vrr_", 72))
	path := "/v1/pairing-claims/" + claim.ClaimID + "/approve"
	body := encodeBody(t, map[string]string{"appNodeId": strings.Repeat("b", 64), "appRefreshTokenHash": secretHash(testSecret("vrr_", 73)), "signedAppTransaction": testSignedAppTransaction(defaultSubscriptionID, claim.ClaimID), "appStoreDeviceVerificationId": testDeviceVerificationID})
	bound, headers := s.attestedBody(t, path, body, nil)
	var fields map[string]string
	if err := json.Unmarshal([]byte(bound), &fields); err != nil {
		t.Fatal(err)
	}
	delete(fields, "assertion")
	fields["attestation"] = base64.StdEncoding.EncodeToString([]byte("different sensitive attestation object"))
	var logs bytes.Buffer
	s.handler.logger = slog.New(slog.NewJSONHandler(&logs, nil))
	response := s.request(t, http.MethodPost, strings.TrimSuffix(path, "approve")+"attestation/register", encodeBody(t, fields), headers)
	if response.Code != http.StatusUnauthorized || strings.TrimSpace(response.Body.String()) != `{"error":"app_attest_invalid"}` {
		t.Fatalf("public response changed: %d %s", response.Code, response.Body.String())
	}
	var record map[string]string
	if err := json.Unmarshal(logs.Bytes(), &record); err != nil {
		t.Fatal(err)
	}
	if len(record) != 5 || record["level"] != "WARN" || record["msg"] != "pairing attestation rejected" || record["stage"] != "register" || record["reason"] != "registration_owner" {
		t.Fatalf("unexpected log fields: %v", record)
	}
	for _, secret := range []string{claim.ClaimID, fields["attestation"], fields["signedAppTransaction"], fields["appStoreDeviceVerificationId"], fields["keyId"], headers["X-Firebase-AppCheck"]} {
		if strings.Contains(logs.String(), secret) {
			t.Fatal("sensitive request data appeared in diagnostic")
		}
	}
}

func TestApprovalLogsOnlyBoundedReason(t *testing.T) {
	s := newTestService(t)
	claim := s.createBootstrapClaim(t, strings.Repeat("a", 64), testSecret("vpc_", 81), testSecret("vrr_", 82))
	path := "/v1/pairing-claims/" + claim.ClaimID + "/approve"
	body := encodeBody(t, map[string]string{"appNodeId": strings.Repeat("b", 64), "appRefreshTokenHash": secretHash(testSecret("vrr_", 83)), "signedAppTransaction": testSignedAppTransaction(defaultSubscriptionID, claim.ClaimID), "appStoreDeviceVerificationId": testDeviceVerificationID})
	bound, headers := s.attestedBody(t, path, body, nil)
	var fields map[string]string
	if err := json.Unmarshal([]byte(bound), &fields); err != nil {
		t.Fatal(err)
	}
	fields["challenge"] = base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	var logs bytes.Buffer
	s.handler.logger = slog.New(slog.NewJSONHandler(&logs, nil))
	response := s.request(t, http.MethodPost, path, encodeBody(t, fields), headers)
	if response.Code != http.StatusUnauthorized || strings.TrimSpace(response.Body.String()) != `{"error":"app_attest_invalid"}` {
		t.Fatalf("public response changed: %d %s", response.Code, response.Body.String())
	}
	var record map[string]string
	if err := json.Unmarshal(logs.Bytes(), &record); err != nil {
		t.Fatal(err)
	}
	if len(record) != 5 || record["level"] != "WARN" || record["msg"] != "pairing attestation rejected" || record["stage"] != "approve" || record["reason"] != "approval_challenge" {
		t.Fatalf("unexpected log fields: %v", record)
	}
	for _, secret := range []string{claim.ClaimID, fields["assertion"], fields["signedAppTransaction"], fields["appStoreDeviceVerificationId"], fields["keyId"], headers["X-Firebase-AppCheck"]} {
		if strings.Contains(logs.String(), secret) {
			t.Fatal("sensitive request data appeared in diagnostic")
		}
	}
}
