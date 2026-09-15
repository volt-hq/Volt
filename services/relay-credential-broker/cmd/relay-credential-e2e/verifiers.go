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
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/appattest"
	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/appstore"
	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/broker"
	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/httpapi"
)

const (
	appCheckType     = "VOLT-E2E-APPCHECK"
	installationType = "VOLT-E2E-INSTALLATION"
	maxProofBytes    = 4096
)

type proofVerifier struct {
	runID     string
	secret    []byte
	expiresAt int64
	now       func() time.Time
	pool      *pgxpool.Pool
}

type appCheckPayload struct {
	RunID     string `json:"runId"`
	Nonce     string `json:"nonce"`
	IssuedAt  int64  `json:"iat"`
	ExpiresAt int64  `json:"exp"`
}

type installationPayload struct {
	RunID          string `json:"runId"`
	InstallationID string `json:"installationId"`
	DeviceID       string `json:"deviceId"`
	IssuedAt       int64  `json:"iat"`
	ExpiresAt      int64  `json:"exp"`
}

func newProofVerifier(c config, pool *pgxpool.Pool, now func() time.Time) *proofVerifier {
	secret, _ := hex.DecodeString(c.ProofSecret) // validated before construction
	return &proofVerifier{runID: c.RunID, secret: secret, expiresAt: c.ExpiresAt, now: now, pool: pool}
}

func canonicalSegment(segment string, limit int) ([]byte, bool) {
	if segment == "" || len(segment) > limit {
		return nil, false
	}
	decoded, err := base64.RawURLEncoding.Strict().DecodeString(segment)
	return decoded, err == nil && base64.RawURLEncoding.EncodeToString(decoded) == segment
}

func (v *proofVerifier) payload(token, typ string) ([]byte, bool) {
	if len(token) > maxProofBytes || v.now().Unix() >= v.expiresAt || len(v.secret) != 32 {
		return nil, false
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, false
	}
	header, ok := canonicalSegment(parts[0], 256)
	if !ok {
		return nil, false
	}
	var h struct {
		Algorithm string `json:"alg"`
		Type      string `json:"typ"`
	}
	if strictObject(header, &h, "alg", "typ") != nil || h.Algorithm != "HS256" || h.Type != typ {
		return nil, false
	}
	payload, ok := canonicalSegment(parts[1], 2048)
	if !ok {
		return nil, false
	}
	signature, ok := canonicalSegment(parts[2], 43)
	if !ok || len(signature) != sha256.Size {
		return nil, false
	}
	mac := hmac.New(sha256.New, v.secret)
	mac.Write([]byte(parts[0] + "." + parts[1]))
	return payload, hmac.Equal(signature, mac.Sum(nil))
}

func (v *proofVerifier) validTimes(runID string, issuedAt, expiresAt int64) bool {
	now := v.now().Unix()
	return runID == v.runID && canonicalHex(runID, 16) && issuedAt > 0 && issuedAt <= now+30 && expiresAt > issuedAt && expiresAt > now && expiresAt <= v.expiresAt && now < v.expiresAt
}

func (v *proofVerifier) Verify(request *http.Request) (httpapi.VerifiedAppCheck, error) {
	// Count case-insensitively as well, including manually constructed Header maps.
	var tokens []string
	for name, values := range request.Header {
		if strings.EqualFold(name, "X-Firebase-AppCheck") {
			tokens = append(tokens, values...)
		}
	}
	if len(tokens) != 1 {
		return httpapi.VerifiedAppCheck{}, broker.ErrAppCheckInvalid
	}
	data, ok := v.payload(tokens[0], appCheckType)
	var p appCheckPayload
	if !ok || strictObject(data, &p, "runId", "nonce", "iat", "exp") != nil || !uuidPattern.MatchString(p.Nonce) || !v.validTimes(p.RunID, p.IssuedAt, p.ExpiresAt) || p.ExpiresAt-p.IssuedAt > 120 {
		return httpapi.VerifiedAppCheck{}, broker.ErrAppCheckInvalid
	}
	// Reverification must return exactly this identity and expiry. Consumption
	// belongs only to the real broker approval transaction, not this verifier.
	return httpapi.VerifiedAppCheck{
		AppID:           "volt-e2e:" + v.runID,
		JTIHash:         broker.SecretHash(sha256.Sum256([]byte(tokens[0]))),
		ExpiresAt:       time.Unix(p.ExpiresAt, 0).UTC(),
		ReplayProtected: true,
	}, nil
}

func (v *proofVerifier) VerifyEntitlement(_ context.Context, proof appstore.Proof) (appstore.Entitlement, error) {
	data, ok := v.payload(proof.SignedAppTransaction, installationType)
	var p installationPayload
	if !ok || strictObject(data, &p, "runId", "installationId", "deviceId", "iat", "exp") != nil || !v.validTimes(p.RunID, p.IssuedAt, p.ExpiresAt) || !uuidPattern.MatchString(p.InstallationID) || !uuidPattern.MatchString(p.DeviceID) || p.DeviceID != proof.DeviceVerificationID {
		return appstore.Entitlement{}, appstore.ErrProofInvalid
	}
	entitlement := v.entitlement(p.InstallationID, time.Unix(p.ExpiresAt, 0).UTC())
	entitlement.ApprovalProofHash = sha256.Sum256(data)
	entitlement.ProofCreatedAt = time.Unix(p.IssuedAt, 0).UTC()
	return entitlement, nil
}

func (v *proofVerifier) entitlement(identity string, until time.Time) appstore.Entitlement {
	now := v.now().UTC()
	return appstore.Entitlement{
		AppTransactionID:    identity,
		Environment:         "Sandbox",
		ProductID:           "volt.e2e.synthetic.pro",
		SubscriptionGroupID: "volt-e2e-synthetic",
		Status:              appstore.StatusActive,
		EntitledUntil:       until,
		SourceSignedAt:      now,
		VerifiedAt:          now,
	}
}

func (v *proofVerifier) ReconcileEntitlement(ctx context.Context, identity, environment string) (appstore.Entitlement, error) {
	if !uuidPattern.MatchString(identity) || environment != "Sandbox" || v.now().Unix() >= v.expiresAt || v.pool == nil {
		return appstore.Entitlement{}, appstore.ErrProofInvalid
	}
	// Read the real durable authority, never extend an expired fixture or invent
	// an identity during reconciliation. This also works after broker restart.
	var until time.Time
	err := v.pool.QueryRow(ctx, `SELECT entitled_until FROM app_store_entitlements
		WHERE app_transaction_id=$1 AND environment=$2 AND product_id='volt.e2e.synthetic.pro'
		AND subscription_group_id='volt-e2e-synthetic'`, identity, environment).Scan(&until)
	if err != nil {
		return appstore.Entitlement{}, appstore.ErrProofInvalid
	}
	if until.Unix() > v.expiresAt {
		until = time.Unix(v.expiresAt, 0).UTC()
	}
	return v.entitlement(identity, until), nil
}

func (*proofVerifier) VerifyNotification(context.Context, string) (appstore.Notification, error) {
	return appstore.Notification{}, appstore.ErrProofInvalid
}

type syntheticAttestationVerifier struct{}

func (syntheticAttestationVerifier) VerifyAttestation(keyID string, object []byte, digest [32]byte, _ string) ([]byte, error) {
	key, err := base64.StdEncoding.Strict().DecodeString(keyID)
	if err != nil || len(key) != 32 || base64.StdEncoding.EncodeToString(key) != keyID || len(object) != 32 || !bytes.Equal(object, digest[:]) {
		return nil, appattest.ErrInvalid
	}
	// Deliberately not a real P-256 point/signature. Only the tagged executable
	// understands these objects; the database still owns key identity/counters.
	x := sha256.Sum256(append([]byte("volt-e2e-key-x\x00"), key...))
	y := sha256.Sum256(append([]byte("volt-e2e-key-y\x00"), key...))
	public := make([]byte, 65)
	public[0] = 4
	copy(public[1:33], x[:])
	copy(public[33:], y[:])
	return public, nil
}

func (syntheticAttestationVerifier) VerifyAssertion(public, object []byte, digest [32]byte, _ string) (uint32, error) {
	if len(public) != 65 || public[0] != 4 || len(object) != 36 || !bytes.Equal(object[4:], digest[:]) {
		return 0, appattest.ErrInvalid
	}
	counter := binary.BigEndian.Uint32(object[:4])
	if counter == 0 {
		return 0, appattest.ErrInvalid
	}
	return counter, nil
}
