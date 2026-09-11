package httpapi

import (
	"crypto/sha256"
	"encoding/base64"
	"net/http"

	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/appattest"
	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/appstore"
	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/broker"
)

type challengeRequest struct {
	approveClaimRequest
	Purpose string `json:"purpose"`
}

type registrationRequest struct {
	approveClaimRequest
	Attestation string `json:"attestation"`
}

func (s *Server) verifyAttestationInput(writer http.ResponseWriter, request *http.Request, body approveClaimRequest) (appattest.Request, broker.AppCheckProof, appstore.Entitlement, bool) {
	fail := func() (appattest.Request, broker.AppCheckProof, appstore.Entitlement, bool) {
		return appattest.Request{}, broker.AppCheckProof{}, appstore.Entitlement{}, false
	}
	check, err := s.appCheck.Verify(request)
	if err != nil || !check.ReplayProtected {
		writeError(writer, http.StatusUnauthorized, "app_check_invalid")
		return fail()
	}
	refreshHash, err := broker.ParseSecretHash(body.AppRefreshTokenHash)
	if err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_app_refresh_token_hash")
		return fail()
	}
	entitlement, err := s.appStore.VerifyEntitlement(request.Context(), appstore.Proof{SignedAppTransaction: body.SignedAppTransaction, DeviceVerificationID: body.AppStoreDeviceVerificationID})
	if err != nil {
		s.writeAppStoreError(writer, err)
		return fail()
	}
	token, _ := singleHeaderValue(request.Header, "X-Firebase-AppCheck")
	bound := appattest.Request{Issuer: s.credentialIssuer, ClaimID: request.PathValue("claimID"), HostNodeID: body.HostNodeID,
		AppNodeID: body.AppNodeID, RefreshHash: [32]byte(refreshHash), ProofHash: entitlement.ApprovalProofHash,
		DeviceID: body.AppStoreDeviceVerificationID, KeyID: body.KeyID, AppCheckHash: sha256.Sum256([]byte(token)), BundleVersion: body.BundleVersion}
	if bound.Validate() != nil {
		writeError(writer, http.StatusBadRequest, "invalid_attestation_request")
		return fail()
	}
	return bound, broker.AppCheckProof{AppID: check.AppID, JTIHash: check.JTIHash, ExpiresAt: check.ExpiresAt, ReplayProtected: check.ReplayProtected}, entitlement, true
}

func (s *Server) handleAttestationChallenge(writer http.ResponseWriter, request *http.Request) {
	if !enforceRequestBudget(writer, s.approvalBudget) {
		return
	}
	var body challengeRequest
	if decodeJSON(writer, request, &body) != nil || (body.Purpose != "register" && body.Purpose != "approve") || body.Challenge != "" || body.Assertion != "" {
		writeError(writer, http.StatusBadRequest, "invalid_request")
		return
	}
	bound, check, _, ok := s.verifyAttestationInput(writer, request, body.approveClaimRequest)
	if !ok {
		return
	}
	challenge, err := s.broker.CreateAttestationChallenge(request.Context(), bound, body.Purpose, check)
	if err != nil {
		s.writeBrokerError(writer, err, "invalid_attestation_request")
		return
	}
	writeJSON(writer, http.StatusOK, challenge)
}

func (s *Server) handleAttestationRegister(writer http.ResponseWriter, request *http.Request) {
	if !enforceRequestBudget(writer, s.approvalBudget) {
		return
	}
	var body registrationRequest
	if decodeJSON(writer, request, &body) != nil || body.Assertion != "" {
		writeError(writer, http.StatusBadRequest, "invalid_request")
		return
	}
	object, err := decodeAttestationObject(body.Attestation, 24*1024)
	if err != nil {
		writeError(writer, http.StatusBadRequest, "invalid_attestation_request")
		return
	}
	bound, check, entitlement, ok := s.verifyAttestationInput(writer, request, body.approveClaimRequest)
	if !ok {
		return
	}
	if err = s.broker.RegisterAttestationKey(request.Context(), bound, body.Challenge, object, check, entitlement); err != nil {
		s.writeBrokerError(writer, err, "invalid_attestation_request")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]string{"status": "registered"})
}

func decodeAttestationObject(value string, limit int) ([]byte, error) {
	if len(value) == 0 || len(value) > base64.StdEncoding.EncodedLen(limit) {
		return nil, appattest.ErrInvalid
	}
	decoded, err := base64.StdEncoding.Strict().DecodeString(value)
	if err != nil || len(decoded) == 0 || len(decoded) > limit || base64.StdEncoding.EncodeToString(decoded) != value {
		return nil, appattest.ErrInvalid
	}
	return decoded, nil
}

func (s *Server) handleAttestationStatus(writer http.ResponseWriter, request *http.Request) {
	if !enforceRequestBudget(writer, s.approvalBudget) {
		return
	}
	var body approveClaimRequest
	if decodeJSON(writer, request, &body) != nil || body.Challenge != "" || body.Assertion != "" {
		writeError(writer, http.StatusBadRequest, "invalid_request")
		return
	}
	bound, check, entitlement, ok := s.verifyAttestationInput(writer, request, body)
	if !ok {
		return
	}
	registered, err := s.broker.AttestationKeyRegistered(request.Context(), bound, check, entitlement)
	if err != nil {
		s.writeBrokerError(writer, err, "invalid_attestation_request")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]bool{"keyRegistered": registered})
}
