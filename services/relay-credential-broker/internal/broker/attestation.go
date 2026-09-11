package broker

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/appattest"
	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/appstore"
)

type AttestationVerifier interface {
	VerifyAttestation(string, []byte, [32]byte, string) ([]byte, error)
	VerifyAssertion([]byte, []byte, [32]byte, string) (uint32, error)
}

type ApprovalAttestation struct {
	Request   appattest.Request
	Challenge string
	Assertion []byte
}

var ErrAttestationInvalid = errors.New("pairing attestation is invalid")
var ErrAttestationCapacity = errors.New("pairing attestation capacity reached")

const attestationCapacityLockID int64 = 8_606_146_524_991_413_124
const attestationChallengeTTL = 2 * time.Minute

type AttestationChallenge struct {
	Challenge     string    `json:"challenge"`
	ExpiresAt     time.Time `json:"expiresAt"`
	KeyRegistered bool      `json:"keyRegistered"`
}

// CreateAttestationChallenge persists a single-use challenge bound to the exact
// request and verified App Check token. Challenge issuance does not consume the
// token: final approval consumes it in the credential transaction.
func (b *Broker) CreateAttestationChallenge(ctx context.Context, request appattest.Request, purpose string, appCheck AppCheckProof) (AttestationChallenge, error) {
	if request.Validate() != nil || (purpose != "register" && purpose != "approve") ||
		!appCheck.ReplayProtected || appCheck.JTIHash == (SecretHash{}) || appCheck.AppID == "" || request.Issuer != b.config.CredentialIssuer {
		return AttestationChallenge{}, ErrAttestationInvalid
	}
	tx, err := b.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return AttestationChallenge{}, err
	}
	defer rollback(tx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", attestationCapacityLockID); err != nil {
		return AttestationChallenge{}, err
	}
	now := b.now().UTC()
	if !now.Before(appCheck.ExpiresAt) {
		return AttestationChallenge{}, ErrAppCheckInvalid
	}
	var consumed bool
	if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM consumed_app_check_tokens WHERE jti_hash = $1)", appCheck.JTIHash[:]).Scan(&consumed); err != nil {
		return AttestationChallenge{}, err
	}
	if consumed {
		return AttestationChallenge{}, ErrAppCheckReplay
	}
	claim, err := lockPairingClaim(ctx, tx, request.ClaimID)
	if err != nil {
		return AttestationChallenge{}, err
	}
	if claim.HostNodeID != request.HostNodeID {
		return AttestationChallenge{}, ErrAttestationInvalid
	}
	if !now.Before(claim.ExpiresAt) {
		return AttestationChallenge{}, ErrClaimExpired
	}
	if _, err = tx.Exec(ctx, "DELETE FROM pairing_attestation_challenges WHERE expires_at <= $1", now); err != nil {
		return AttestationChallenge{}, err
	}
	var count int
	if err = tx.QueryRow(ctx, "SELECT count(*) FROM pairing_attestation_challenges").Scan(&count); err != nil {
		return AttestationChallenge{}, err
	}
	if count >= b.config.MaxClaims*4 {
		return AttestationChallenge{}, ErrAttestationCapacity
	}
	var registered bool
	if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pairing_attestation_keys WHERE key_id = $1)", request.KeyID).Scan(&registered); err != nil {
		return AttestationChallenge{}, err
	}
	if purpose == "register" && registered {
		return AttestationChallenge{KeyRegistered: true}, nil
	}
	if purpose == "approve" && !registered {
		return AttestationChallenge{}, ErrAttestationInvalid
	}
	var nonce [32]byte
	if _, err = rand.Read(nonce[:]); err != nil {
		return AttestationChallenge{}, err
	}
	requestHash, err := request.Hash(purpose, nonce)
	if err != nil {
		return AttestationChallenge{}, ErrAttestationInvalid
	}
	expires := now.Add(attestationChallengeTTL)
	if claim.ExpiresAt.Before(expires) {
		expires = claim.ExpiresAt
	}
	if appCheck.ExpiresAt.Before(expires) {
		expires = appCheck.ExpiresAt
	}
	nonceHash := sha256.Sum256(nonce[:])
	result, err := tx.Exec(ctx, `
		INSERT INTO pairing_attestation_challenges
		(nonce_hash, purpose, claim_id, key_id, request_hash, app_check_jti_hash, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING
	`, nonceHash[:], purpose, request.ClaimID, request.KeyID, requestHash[:], appCheck.JTIHash[:], expires)
	if err != nil {
		return AttestationChallenge{}, fmt.Errorf("create attestation challenge: %w", err)
	}
	if result.RowsAffected() != 1 {
		return AttestationChallenge{}, ErrAttestationInvalid
	}
	if err = tx.Commit(ctx); err != nil {
		return AttestationChallenge{}, err
	}
	return AttestationChallenge{Challenge: base64.RawURLEncoding.EncodeToString(nonce[:]), ExpiresAt: expires, KeyRegistered: registered}, nil
}

// RegisterAttestationKey consumes a registration challenge and records immutable
// key ownership. A lost-response retry can confirm the exact committed object;
// it cannot overwrite a public key, counter, subscription, or device binding.
func (b *Broker) RegisterAttestationKey(ctx context.Context, request appattest.Request, challenge string, object []byte, appCheck AppCheckProof, entitlement appstore.Entitlement) (resultErr error) {
	stage := "registration_request"
	defer func() {
		if errors.Is(resultErr, ErrAttestationInvalid) {
			resultErr = &attestationRejection{reason: stage, cause: resultErr}
		}
	}()
	if b.config.AttestationVerifier == nil || request.Issuer != b.config.CredentialIssuer ||
		request.Validate() != nil || request.ProofHash != entitlement.ApprovalProofHash ||
		!appCheck.ReplayProtected || appCheck.JTIHash == (SecretHash{}) || len(object) == 0 || len(object) > 24*1024 {
		return ErrAttestationInvalid
	}
	tx, err := b.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(tx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", attestationCapacityLockID); err != nil {
		return err
	}
	now := b.now().UTC()
	stage = "registration_validity"
	if !now.Before(appCheck.ExpiresAt) || !entitlement.Active(now) {
		return ErrAttestationInvalid
	}
	current, err := upsertAndLockEntitlement(ctx, tx, entitlement, now)
	if err != nil {
		return err
	}
	if !current.active(now) {
		return ErrSubscriptionRequired
	}
	claim, err := lockPairingClaim(ctx, tx, request.ClaimID)
	if err != nil {
		return err
	}
	stage = "registration_claim"
	if !now.Before(claim.ExpiresAt) || claim.HostNodeID != request.HostNodeID {
		return ErrAttestationInvalid
	}
	registrationHash := sha256.Sum256(object)
	deviceHash := sha256.Sum256([]byte(request.DeviceID))
	var existingHash, existingDevice []byte
	var existingSubscription string
	err = tx.QueryRow(ctx, "SELECT registration_hash, app_transaction_id, device_id_hash FROM pairing_attestation_keys WHERE key_id=$1 FOR UPDATE", request.KeyID).Scan(&existingHash, &existingSubscription, &existingDevice)
	stage = "registration_owner"
	if err == nil {
		if !bytes.Equal(existingHash, registrationHash[:]) || existingSubscription != entitlement.AppTransactionID || !bytes.Equal(existingDevice, deviceHash[:]) {
			return ErrAttestationInvalid
		}
		return nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	// Keys are never pruned to forget a counter; capacity exhaustion fails closed.
	var count int
	if err = tx.QueryRow(ctx, "SELECT count(*) FROM pairing_attestation_keys").Scan(&count); err != nil {
		return err
	}
	if count >= b.config.MaxEndpoints*2 {
		return ErrAttestationCapacity
	}
	stage = "registration_challenge"
	digest, err := consumeAttestationChallenge(ctx, tx, request, "register", challenge, appCheck, now)
	if err != nil {
		return err
	}
	stage = "apple_verification"
	publicKey, err := b.config.AttestationVerifier.VerifyAttestation(request.KeyID, object, digest, request.BundleVersion)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrAttestationInvalid, err)
	}
	stage = "registration_public_key"
	if len(publicKey) != 65 {
		return ErrAttestationInvalid
	}
	if _, err = tx.Exec(ctx, `INSERT INTO pairing_attestation_keys
		(key_id,public_key,registration_hash,app_transaction_id,device_id_hash,created_at,last_used_at)
		VALUES ($1,$2,$3,$4,$5,$6,$6)`, request.KeyID, publicKey, registrationHash[:], entitlement.AppTransactionID, deviceHash[:], now); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (b *Broker) consumeApprovalAttestation(ctx context.Context, tx pgx.Tx, claim pairingClaim, appCheck AppCheckProof, entitlement appstore.Entitlement, appNodeID string, refreshHash SecretHash, proof ApprovalAttestation, now time.Time) (resultErr error) {
	stage := "approval_request"
	defer func() {
		if errors.Is(resultErr, ErrAttestationInvalid) {
			resultErr = &attestationRejection{reason: stage, cause: resultErr}
		}
	}()
	r := proof.Request
	if b.config.AttestationVerifier == nil || r.Issuer != b.config.CredentialIssuer ||
		r.ClaimID != claim.ID || r.HostNodeID != claim.HostNodeID || r.AppNodeID != appNodeID ||
		r.RefreshHash != [32]byte(refreshHash) || r.ProofHash != entitlement.ApprovalProofHash ||
		!appCheck.ReplayProtected || appCheck.JTIHash == (SecretHash{}) {
		return ErrAttestationInvalid
	}
	var publicKey, deviceHash []byte
	var subscription string
	var previousCounter int64
	stage = "approval_key"
	err := tx.QueryRow(ctx, `SELECT public_key, assertion_counter, app_transaction_id, device_id_hash
		FROM pairing_attestation_keys WHERE key_id=$1 FOR UPDATE`, r.KeyID).Scan(&publicKey, &previousCounter, &subscription, &deviceHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrAttestationInvalid
	}
	if err != nil {
		return err
	}
	expectedDevice := sha256.Sum256([]byte(r.DeviceID))
	stage = "approval_owner"
	if subscription != entitlement.AppTransactionID || !bytes.Equal(deviceHash, expectedDevice[:]) {
		return ErrAttestationInvalid
	}
	stage = "approval_challenge"
	digest, err := consumeAttestationChallenge(ctx, tx, r, "approve", proof.Challenge, appCheck, now)
	if err != nil {
		return err
	}
	stage = "apple_verification"
	counter, err := b.config.AttestationVerifier.VerifyAssertion(publicKey, proof.Assertion, digest, r.BundleVersion)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrAttestationInvalid, err)
	}
	stage = "approval_counter"
	if int64(counter) <= previousCounter {
		return ErrAttestationInvalid
	}
	_, err = tx.Exec(ctx, "UPDATE pairing_attestation_keys SET assertion_counter=$2,last_used_at=$3 WHERE key_id=$1", r.KeyID, int64(counter), now)
	return err
}

func consumeAttestationChallenge(ctx context.Context, tx pgx.Tx, request appattest.Request, purpose, challenge string, appCheck AppCheckProof, now time.Time) ([32]byte, error) {
	var nonce [32]byte
	decoded, err := base64.RawURLEncoding.Strict().DecodeString(challenge)
	if err != nil || len(decoded) != 32 || base64.RawURLEncoding.EncodeToString(decoded) != challenge {
		return [32]byte{}, ErrAttestationInvalid
	}
	copy(nonce[:], decoded)
	digest, err := request.Hash(purpose, nonce)
	if err != nil {
		return [32]byte{}, ErrAttestationInvalid
	}
	nonceHash := sha256.Sum256(nonce[:])
	result, err := tx.Exec(ctx, `
		UPDATE pairing_attestation_challenges SET consumed_at = $1
		WHERE nonce_hash = $2 AND purpose = $3 AND claim_id = $4 AND key_id = $5
		AND request_hash = $6 AND app_check_jti_hash = $7 AND expires_at > $1 AND consumed_at IS NULL
	`, now, nonceHash[:], purpose, request.ClaimID, request.KeyID, digest[:], appCheck.JTIHash[:])
	if err != nil {
		return [32]byte{}, err
	}
	if result.RowsAffected() != 1 {
		return [32]byte{}, ErrAttestationInvalid
	}
	return digest, nil
}

// AttestationKeyRegistered lets an installation recover after losing the
// registration response, without attesting the same one-time key twice.
func (b *Broker) AttestationKeyRegistered(ctx context.Context, request appattest.Request, check AppCheckProof, entitlement appstore.Entitlement) (bool, error) {
	if request.Validate() != nil || request.Issuer != b.config.CredentialIssuer ||
		request.ProofHash != entitlement.ApprovalProofHash || !check.ReplayProtected ||
		check.JTIHash == (SecretHash{}) || !b.now().Before(check.ExpiresAt) || !entitlement.Active(b.now()) {
		return false, ErrAttestationInvalid
	}
	deviceHash := sha256.Sum256([]byte(request.DeviceID))
	var registered bool
	err := b.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pairing_attestation_keys k
		JOIN pairing_claims c ON c.id=$4 AND c.host_node_id=$5 AND c.expires_at > $6
		WHERE k.key_id=$1 AND k.app_transaction_id=$2 AND k.device_id_hash=$3)`,
		request.KeyID, entitlement.AppTransactionID, deviceHash[:], request.ClaimID, request.HostNodeID, b.now()).Scan(&registered)
	return registered, err
}

// Recheck after all potentially blocking row locks and immediately before
// commit. Queueing behind another transaction cannot extend a proof's lifetime.
func (b *Broker) checkApprovalExpiry(ctx context.Context, tx pgx.Tx, proof ApprovalAttestation, check AppCheckProof, claim pairingClaim, entitlement entitlementRecord) error {
	now := b.now().UTC()
	if !now.Before(check.ExpiresAt) || !now.Before(claim.ExpiresAt) || !entitlement.active(now) {
		return ErrAttestationInvalid
	}
	nonce, err := base64.RawURLEncoding.Strict().DecodeString(proof.Challenge)
	if err != nil || len(nonce) != 32 {
		return ErrAttestationInvalid
	}
	nonceHash := sha256.Sum256(nonce)
	var fresh bool
	err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pairing_attestation_challenges WHERE nonce_hash=$1 AND consumed_at IS NOT NULL AND expires_at > $2)", nonceHash[:], now).Scan(&fresh)
	if err != nil {
		return err
	}
	if !fresh {
		return ErrAttestationInvalid
	}
	return nil
}
