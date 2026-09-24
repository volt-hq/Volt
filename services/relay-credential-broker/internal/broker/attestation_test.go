package broker

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/appstore"
	"strings"
	"testing"
	"time"

	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/appattest"
	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/testdatabase"
)

// Regression: #387. Request mutation and replay must fail within the transaction.
func TestRegression387ChallengeConsumption(t *testing.T) {
	pool := testdatabase.Open(t)
	now := time.Date(2026, 9, 11, 15, 0, 0, 0, time.UTC)
	b := newPostgresBroker(t, pool, &now)
	b.config.CredentialIssuer = "https://credentials-canary.volt-cli.dev"
	ctx := context.Background()
	claim, err := b.CreateBootstrapPairingClaim(ctx, strings.Repeat("a", 64), postgresTestHash("claim"), postgresTestHash("host"))
	if err != nil {
		t.Fatal(err)
	}
	key := [32]byte{1}
	r := appattest.Request{Issuer: "https://credentials-canary.volt-cli.dev", ClaimID: claim.ClaimID,
		HostNodeID: strings.Repeat("a", 64), AppNodeID: strings.Repeat("b", 64),
		RefreshHash: [32]byte{1}, ProofHash: [32]byte{2}, AppCheckHash: [32]byte{3},
		DeviceID: "11111111-1111-4111-8111-111111111111", KeyID: base64.StdEncoding.EncodeToString(key[:]), BundleVersion: "4"}
	check := postgresTestAppCheck(now, "challenge")
	challenge, err := b.CreateAttestationChallenge(ctx, r, "register", check)
	if err != nil {
		t.Fatal(err)
	}
	if !challenge.ExpiresAt.Equal(now.Add(2 * time.Minute)) {
		t.Fatal("unexpected challenge lifetime")
	}
	if _, err = b.CreateAttestationChallenge(ctx, r, "register", check); !errors.Is(err, ErrAttestationInvalid) {
		t.Fatalf("duplicate challenge: %v", err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer rollback(tx)
	mutated := r
	mutated.AppNodeID = strings.Repeat("c", 64)
	if _, err = consumeAttestationChallenge(ctx, tx, mutated, "register", challenge.Challenge, check, now); !errors.Is(err, ErrAttestationInvalid) {
		t.Fatalf("mutated approval: %v", err)
	}
	if _, err = consumeAttestationChallenge(ctx, tx, r, "approve", challenge.Challenge, check, now); !errors.Is(err, ErrAttestationInvalid) {
		t.Fatalf("wrong purpose: %v", err)
	}
	if _, err = consumeAttestationChallenge(ctx, tx, r, "register", challenge.Challenge, check, challenge.ExpiresAt); !errors.Is(err, ErrAttestationInvalid) {
		t.Fatalf("expired challenge: %v", err)
	}
	if _, err = consumeAttestationChallenge(ctx, tx, r, "register", challenge.Challenge, check, now); err != nil {
		t.Fatal(err)
	}
	if _, err = consumeAttestationChallenge(ctx, tx, r, "register", challenge.Challenge, check, now); !errors.Is(err, ErrAttestationInvalid) {
		t.Fatalf("replay: %v", err)
	}
	if err = tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	retry, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer rollback(retry)
	if _, err = consumeAttestationChallenge(ctx, retry, r, "register", challenge.Challenge, check, now); err != nil {
		t.Fatalf("rollback consumed challenge: %v", err)
	}
	if err = retry.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	last, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer rollback(last)
	if _, err = consumeAttestationChallenge(ctx, last, r, "register", challenge.Challenge, check, now); !errors.Is(err, ErrAttestationInvalid) {
		t.Fatalf("committed replay: %v", err)
	}
}

// Cryptographic validation has independent Apple and certificate-chain fixtures
// in appattest. This boundary double checks exactly the digest the broker passes.
type postgresAttestationVerifier struct{}

func (postgresAttestationVerifier) VerifyAttestation(_ string, object []byte, digest [32]byte, _ string) ([]byte, error) {
	if !bytes.Equal(object, digest[:]) {
		return nil, ErrAttestationInvalid
	}
	return make([]byte, 65), nil
}
func (postgresAttestationVerifier) VerifyAssertion(_ []byte, object []byte, digest [32]byte, _ string) (uint32, error) {
	if len(object) != 36 || !bytes.Equal(object[4:], digest[:]) {
		return 0, ErrAttestationInvalid
	}
	return binary.BigEndian.Uint32(object[:4]), nil
}
func postgresAssertion(t *testing.T, r appattest.Request, challenge AttestationChallenge, counter uint32) []byte {
	t.Helper()
	nonce, err := base64.RawURLEncoding.DecodeString(challenge.Challenge)
	if err != nil {
		t.Fatal(err)
	}
	digest, err := r.Hash("approve", [32]byte(nonce))
	if err != nil {
		t.Fatal(err)
	}
	object := make([]byte, 36)
	binary.BigEndian.PutUint32(object, counter)
	copy(object[4:], digest[:])
	return object
}
func postgresRegisteredRequest(t *testing.T, b *Broker, ctx context.Context, claimID string, check AppCheckProof, entitlement appstore.Entitlement, node string, refresh SecretHash) (appattest.Request, error) {
	t.Helper()
	var host string
	if err := b.pool.QueryRow(ctx, "SELECT host_node_id FROM pairing_claims WHERE id=$1", claimID).Scan(&host); err != nil {
		return appattest.Request{}, ErrClaimNotFound
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		t.Fatal(err)
	}
	r := appattest.Request{Issuer: b.config.CredentialIssuer, ClaimID: claimID, HostNodeID: host, AppNodeID: node,
		RefreshHash: [32]byte(refresh), ProofHash: entitlement.ApprovalProofHash, AppCheckHash: sha256.Sum256(check.JTIHash[:]),
		DeviceID: "11111111-1111-4111-8111-111111111111", KeyID: base64.StdEncoding.EncodeToString(key), BundleVersion: "4"}
	challenge, err := b.CreateAttestationChallenge(ctx, r, "register", check)
	if err != nil {
		return r, err
	}
	nonce, err := base64.RawURLEncoding.DecodeString(challenge.Challenge)
	if err != nil {
		t.Fatal(err)
	}
	digest, err := r.Hash("register", [32]byte(nonce))
	if err != nil {
		t.Fatal(err)
	}
	if err = b.RegisterAttestationKey(ctx, r, challenge.Challenge, digest[:], check, entitlement); err != nil {
		return r, err
	}
	return r, nil
}
func approvePostgresTestClaim(t *testing.T, b *Broker, ctx context.Context, claimID string, check AppCheckProof, entitlement appstore.Entitlement, node string, refresh SecretHash) (Approval, error) {
	t.Helper()
	r, err := postgresRegisteredRequest(t, b, ctx, claimID, check, entitlement, node, refresh)
	if err != nil {
		return Approval{}, err
	}
	challenge, err := b.CreateAttestationChallenge(ctx, r, "approve", check)
	if err != nil {
		return Approval{}, err
	}
	return b.ApprovePairingClaim(ctx, claimID, check, entitlement, node, refresh, ApprovalAttestation{r, challenge.Challenge, postgresAssertion(t, r, challenge, 1)})
}

func TestRegression387AssertionCounterOwnershipAndAtomicRollback(t *testing.T) {
	pool := testdatabase.Open(t)
	now := time.Date(2026, 9, 11, 15, 0, 0, 0, time.UTC)
	b := newPostgresBroker(t, pool, &now)
	ctx := context.Background()
	claim, err := b.CreateBootstrapPairingClaim(ctx, strings.Repeat("a", 64), postgresTestHash("claim"), postgresTestHash("host"))
	if err != nil {
		t.Fatal(err)
	}
	entitlement := postgresTestEntitlement(now, "subscription-attested")
	entitlement.ProofCreatedAt = now.Add(-30 * 24 * time.Hour)
	check := postgresTestAppCheck(now, "first")
	refresh := postgresTestHash("app")
	r, err := postgresRegisteredRequest(t, b, ctx, claim.ClaimID, check, entitlement, strings.Repeat("b", 64), refresh)
	if err != nil {
		t.Fatal(err)
	}
	challenge, err := b.CreateAttestationChallenge(ctx, r, "approve", check)
	if err != nil {
		t.Fatal(err)
	}
	proof := ApprovalAttestation{r, challenge.Challenge, postgresAssertion(t, r, challenge, 1)}
	// Failure after proof validation must roll back its nonce, counter and token.
	b.config.MaxEndpoints = 1
	if _, err = b.ApprovePairingClaim(ctx, claim.ClaimID, check, entitlement, r.AppNodeID, refresh, proof); !errors.Is(err, ErrEndpointCapacity) {
		t.Fatalf("capacity error: %v", err)
	}
	var counter int64
	if err = pool.QueryRow(ctx, "SELECT assertion_counter FROM pairing_attestation_keys WHERE key_id=$1", r.KeyID).Scan(&counter); err != nil || counter != 0 {
		t.Fatalf("failed approval advanced counter: %d %v", counter, err)
	}
	b.config.MaxEndpoints = 200
	first, err := b.ApprovePairingClaim(ctx, claim.ClaimID, check, entitlement, r.AppNodeID, refresh, proof)
	if err != nil {
		t.Fatal(err)
	}
	// A fresh token/challenge cannot legitimize an old counter, even after restart.
	b = newPostgresBroker(t, pool, &now)
	check = postgresTestAppCheck(now, "second")
	r.AppCheckHash = sha256.Sum256(check.JTIHash[:])
	challenge, err = b.CreateAttestationChallenge(ctx, r, "approve", check)
	if err != nil {
		t.Fatal(err)
	}
	proof = ApprovalAttestation{r, challenge.Challenge, postgresAssertion(t, r, challenge, 1)}
	if _, err = b.ApprovePairingClaim(ctx, claim.ClaimID, check, entitlement, r.AppNodeID, refresh, proof); !errors.Is(err, ErrAttestationInvalid) {
		t.Fatalf("old counter accepted: %v", err)
	}
	// A higher, valid counter can reuse the rolled-back challenge and keep endpoint authority.
	proof.Assertion = postgresAssertion(t, r, challenge, 2)
	retry, err := b.ApprovePairingClaim(ctx, claim.ClaimID, check, entitlement, r.AppNodeID, refresh, proof)
	if err != nil {
		t.Fatal(err)
	}
	if retry.EndpointID != first.EndpointID || retry.GrantID != first.GrantID {
		t.Fatal("lost-response retry changed authority")
	}
	check = postgresTestAppCheck(now, "third")
	r.AppCheckHash = sha256.Sum256(check.JTIHash[:])
	r.DeviceID = "22222222-2222-4222-8222-222222222222"
	challenge, err = b.CreateAttestationChallenge(ctx, r, "approve", check)
	if err != nil {
		t.Fatal(err)
	}
	proof = ApprovalAttestation{r, challenge.Challenge, postgresAssertion(t, r, challenge, 3)}
	if _, err = b.ApprovePairingClaim(ctx, claim.ClaimID, check, entitlement, r.AppNodeID, refresh, proof); !errors.Is(err, ErrAttestationInvalid) {
		t.Fatalf("another device used key: %v", err)
	}
}
