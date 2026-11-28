package broker

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

// RelayAccessStatus describes cached subscription authority, never relay presence.
type RelayAccessStatus struct {
	SubscriptionState     string    `json:"subscriptionState"`
	ObservedAt            time.Time `json:"observedAt"`
	NextCheckAfterSeconds int       `json:"nextCheckAfterSeconds"`
}

// RelayAccessStatus authenticates and reads one grant in a single database
// snapshot. It never renews inactivity, signs a JWT, or contacts Apple.
func (b *Broker) RelayAccessStatus(ctx context.Context, refreshToken string) (RelayAccessStatus, error) {
	if !validSecret(refreshToken, refreshPrefix) {
		return RelayAccessStatus{}, ErrRefreshInvalid
	}
	hash := sha256.Sum256([]byte(refreshToken))
	var endpointExpiry, hostExpiry time.Time
	var grantRevoked, endpointRevoked, hostRevoked, entitledUntil pgtype.Timestamptz
	var status pgtype.Text
	err := b.pool.QueryRow(ctx, `
        SELECT e.refresh_inactive_expires_at, h.refresh_inactive_expires_at,
               g.revoked_at, e.revoked_at, h.revoked_at, a.status, a.entitled_until
        FROM endpoints e JOIN grants g ON g.id=e.grant_id
        JOIN endpoints h ON h.grant_id=g.id AND h.kind='host'
        LEFT JOIN grant_entitlements ge ON ge.grant_id=g.id
        LEFT JOIN app_store_entitlements a ON a.app_transaction_id=ge.app_transaction_id
        WHERE e.refresh_token_hash=$1
    `, hash[:]).Scan(&endpointExpiry, &hostExpiry, &grantRevoked, &endpointRevoked, &hostRevoked, &status, &entitledUntil)
	if errors.Is(err, pgx.ErrNoRows) {
		return RelayAccessStatus{}, ErrRefreshInvalid
	}
	if err != nil {
		return RelayAccessStatus{}, fmt.Errorf("read relay access status: %w", err)
	}
	if grantRevoked.Valid || endpointRevoked.Valid || hostRevoked.Valid {
		return RelayAccessStatus{}, ErrRefreshInvalid
	}
	now := b.now().UTC()
	if !now.Before(endpointExpiry) || !now.Before(hostExpiry) {
		return RelayAccessStatus{}, ErrRefreshExpired
	}
	result := RelayAccessStatus{SubscriptionState: "inactive", ObservedAt: now, NextCheckAfterSeconds: 15}
	if (status.String == "active" || status.String == "grace") && entitledUntil.Valid && now.Before(entitledUntil.Time) {
		result.SubscriptionState = "active"
	}
	return result, nil
}
