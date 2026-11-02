package broker

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/testdatabase"
)

// Regression: #1004. Approving a phone whose node already had an app endpoint
// in the grant, even a revoked one, failed with ErrClaimConflict, so a failed
// pairing could only be recovered by resetting the computer's whole grant.
func TestRegression1004ReapprovingAnEnrolledPhoneReplacesItsEndpoint(t *testing.T) {
	pool := testdatabase.Open(t)
	now := time.Date(2026, time.November, 2, 15, 0, 0, 0, time.UTC)
	service := newPostgresBroker(t, pool, &now)
	ctx := context.Background()
	phone := strings.Repeat("f", 64)
	hostRefresh := postgresTestSecret("vrr_", 41)
	first := reapprovalBootstrap(t, service, now, hostRefresh, phone, postgresTestSecret("vrr_", 42))

	// A pairing that fails after approval revokes its new app credential.
	if err := service.RevokeRefreshToken(ctx, postgresTestSecret("vrr_", 42)); err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Minute)
	afterRevoke := reapprovalForGrant(t, service, now, hostRefresh, phone, postgresTestSecret("vrr_", 43), "after-revoke")
	if afterRevoke.GrantID != first.GrantID || afterRevoke.EndpointID == first.EndpointID {
		t.Fatalf("re-approval after revoke = %+v, first = %+v", afterRevoke, first)
	}
	if _, err := service.RefreshAccessToken(ctx, postgresTestSecret("vrr_", 43)); err != nil {
		t.Fatalf("refresh replacement endpoint: %v", err)
	}

	// Pairing the same phone again while its endpoint is active replaces it.
	now = now.Add(time.Minute)
	replacement := reapprovalForGrant(t, service, now, hostRefresh, phone, postgresTestSecret("vrr_", 44), "while-active")
	if replacement.GrantID != first.GrantID || replacement.EndpointID == afterRevoke.EndpointID {
		t.Fatalf("re-approval while active = %+v, previous = %+v", replacement, afterRevoke)
	}
	if _, err := service.RefreshAccessToken(ctx, postgresTestSecret("vrr_", 43)); !errors.Is(err, ErrRefreshInvalid) {
		t.Fatalf("replaced endpoint refresh error = %v, want %v", err, ErrRefreshInvalid)
	}
	if _, err := service.RefreshAccessToken(ctx, postgresTestSecret("vrr_", 44)); err != nil {
		t.Fatalf("refresh latest endpoint: %v", err)
	}
	if active := activeAppEndpoints(t, pool, first.GrantID, phone); active != 1 {
		t.Fatalf("active app endpoints for the phone = %d, want 1", active)
	}

	// The schema still forbids two active endpoints for one node in a grant.
	duplicate := postgresTestHash("duplicate")
	if _, err := pool.Exec(ctx, `
		INSERT INTO endpoints (grant_id, kind, node_id, refresh_token_hash, refresh_inactive_expires_at, created_at)
		VALUES ($1, 'app', $2, $3, $4, $4)
	`, first.GrantID, phone, duplicate[:], now); err == nil {
		t.Fatal("inserted a second active endpoint for the same node")
	}
}

func TestRegression1004ReplacedEndpointDoesNotCountAgainstGrantCapacity(t *testing.T) {
	pool := testdatabase.Open(t)
	now := time.Date(2026, time.November, 2, 15, 0, 0, 0, time.UTC)
	service := newPostgresBroker(t, pool, &now)
	service.config.MaxAppEndpointsPerGrant = 1
	phone := strings.Repeat("f", 64)
	hostRefresh := postgresTestSecret("vrr_", 51)
	reapprovalBootstrap(t, service, now, hostRefresh, phone, postgresTestSecret("vrr_", 52))

	now = now.Add(time.Minute)
	reapprovalForGrant(t, service, now, hostRefresh, phone, postgresTestSecret("vrr_", 53), "same-phone")

	now = now.Add(time.Minute)
	claim, err := service.CreatePairingClaimForGrant(context.Background(), hostRefresh, postgresTestHash("claim-other-phone"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := approvePostgresTestClaim(t, service, context.Background(), claim.ClaimID,
		postgresTestAppCheck(now, "other-phone"),
		postgresTestEntitlement(now, "subscription-1004"),
		strings.Repeat("e", 64),
		postgresTestHash(postgresTestSecret("vrr_", 54)),
	); !errors.Is(err, ErrAppEndpointCapacity) {
		t.Fatalf("second phone approval error = %v, want %v", err, ErrAppEndpointCapacity)
	}
}

func reapprovalBootstrap(t *testing.T, service *Broker, now time.Time, hostRefresh, phone, appRefresh string) Approval {
	t.Helper()
	claim, err := service.CreateBootstrapPairingClaim(
		context.Background(),
		strings.Repeat("a", 64),
		postgresTestHash("claim-bootstrap"),
		postgresTestHash(hostRefresh),
	)
	if err != nil {
		t.Fatal(err)
	}
	approval, err := approvePostgresTestClaim(t, service, context.Background(), claim.ClaimID,
		postgresTestAppCheck(now, "bootstrap"),
		postgresTestEntitlement(now, "subscription-1004"),
		phone,
		postgresTestHash(appRefresh),
	)
	if err != nil {
		t.Fatalf("bootstrap approval: %v", err)
	}
	return approval
}

func reapprovalForGrant(t *testing.T, service *Broker, now time.Time, hostRefresh, phone, appRefresh, label string) Approval {
	t.Helper()
	claim, err := service.CreatePairingClaimForGrant(context.Background(), hostRefresh, postgresTestHash("claim-"+label))
	if err != nil {
		t.Fatalf("create claim %s: %v", label, err)
	}
	approval, err := approvePostgresTestClaim(t, service, context.Background(), claim.ClaimID,
		postgresTestAppCheck(now, label),
		postgresTestEntitlement(now, "subscription-1004"),
		phone,
		postgresTestHash(appRefresh),
	)
	if err != nil {
		t.Fatalf("re-approval %s: %v", label, err)
	}
	return approval
}

func activeAppEndpoints(t *testing.T, pool *pgxpool.Pool, grantID, node string) int {
	t.Helper()
	var count int
	if err := pool.QueryRow(context.Background(), `
		SELECT count(*) FROM endpoints
		WHERE grant_id = $1 AND kind = 'app' AND node_id = $2 AND revoked_at IS NULL
	`, grantID, node).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}
