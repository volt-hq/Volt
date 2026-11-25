package httpapi

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/appstore"
	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/broker"
)

// Regression: #1100. Status remains independent of relay presence and token minting.
func TestRegression1100RelayStatusIsReadOnly(t *testing.T) {
	for _, state := range []appstore.Status{appstore.StatusActive, appstore.StatusGrace, appstore.StatusInactive, appstore.StatusExpired} {
		t.Run(string(state), func(t *testing.T) {
			f := newReconciliationFixture(t, state, 0)
			snapshot := func() string {
				var data string
				err := f.service.pool.QueryRow(context.Background(), `SELECT json_build_object(
      'endpoints',(SELECT json_agg(e ORDER BY id) FROM endpoints e),
      'grants',(SELECT json_agg(g ORDER BY id) FROM grants g),
      'entitlements',(SELECT json_agg(a ORDER BY app_transaction_id) FROM app_store_entitlements a)
    )::text`).Scan(&data)
				if err != nil {
					t.Fatal(err)
				}
				return data
			}
			before := snapshot()
			for _, token := range []string{f.appRefresh, f.hostRefresh} {
				response := f.service.request(t, http.MethodPost, "/v1/relay-access/status", "", map[string]string{"Authorization": "Bearer " + token})
				if response.Code != http.StatusOK {
					t.Fatalf("status=%d", response.Code)
				}
				var status broker.RelayAccessStatus
				decodeResponse(t, response, &status)
				want := "inactive"
				if state == appstore.StatusActive || state == appstore.StatusGrace {
					want = "active"
				}
				if status.SubscriptionState != want || status.NextCheckAfterSeconds != 15 || !status.ObservedAt.Equal(f.service.now) {
					t.Fatalf("unexpected status: %+v", status)
				}
				if strings.Contains(response.Body.String(), "accessToken") || response.Header().Get("Cache-Control") != "no-store" {
					t.Fatal("status leaked a token or was cacheable")
				}
			}
			if before != snapshot() {
				t.Fatal("status mutated authority or inactivity")
			}
			if f.verifier.calls.Load() != 0 {
				t.Fatal("status called Apple")
			}
		})
	}
}

func TestRegression1100RelayStatusRejectsInvalidAuthority(t *testing.T) {
	for _, reason := range []string{"unknown", "revoked app", "revoked host", "expired app", "expired host", "body"} {
		t.Run(reason, func(t *testing.T) {
			f := newReconciliationFixture(t, appstore.StatusInactive, 0)
			token, body, want := f.appRefresh, "", http.StatusUnauthorized
			switch reason {
			case "unknown":
				token = testSecret("vrr_", 99)
			case "revoked app":
				if err := f.service.handler.broker.RevokeRefreshToken(context.Background(), token); err != nil {
					t.Fatal(err)
				}
			case "revoked host":
				if err := f.service.handler.broker.RevokeRefreshToken(context.Background(), f.hostRefresh); err != nil {
					t.Fatal(err)
				}
			case "expired app", "expired host":
				kind := "app"
				if reason == "expired host" {
					kind = "host"
				}
				if _, err := f.service.pool.Exec(context.Background(), "UPDATE endpoints SET refresh_inactive_expires_at=$1 WHERE kind=$2", f.service.now, kind); err != nil {
					t.Fatal(err)
				}
				want = http.StatusGone
			case "body":
				body = `{"grantId":"another-grant"}`
				want = http.StatusBadRequest
			}
			response := f.service.request(t, http.MethodPost, "/v1/relay-access/status", body, map[string]string{"Authorization": "Bearer " + token})
			if response.Code != want {
				t.Fatalf("status=%d want=%d", response.Code, want)
			}
			if f.verifier.calls.Load() != 0 {
				t.Fatal("rejected status called Apple")
			}
		})
	}
}

func TestRegression1100RelayStatusIsGrantScoped(t *testing.T) {
	f := newReconciliationFixture(t, appstore.StatusInactive, 0)
	claim := f.service.createBootstrapClaim(t, strings.Repeat("c", 64), testSecret("vpc_", 8), testSecret("vrr_", 9))
	other := testSecret("vrr_", 10)
	f.service.approveClaimWithSubscription(t, claim.ClaimID, strings.Repeat("d", 64), other, "other-subscription")
	for _, item := range []struct{ token, state string }{{f.appRefresh, "inactive"}, {other, "active"}} {
		response := f.service.request(t, http.MethodPost, "/v1/relay-access/status", "", map[string]string{"Authorization": "Bearer " + item.token})
		if response.Code != 200 {
			t.Fatalf("status=%d", response.Code)
		}
		var status broker.RelayAccessStatus
		decodeResponse(t, response, &status)
		if status.SubscriptionState != item.state {
			t.Fatal("status read another grant")
		}
	}
}

func TestRegression1100LongLapseNotificationRestoresNextPoll(t *testing.T) {
	for _, lapse := range []time.Duration{time.Hour, 25 * time.Hour, 8 * 24 * time.Hour} {
		t.Run(lapse.String(), func(t *testing.T) {
			f := newReconciliationFixture(t, appstore.StatusInactive, 0)
			f.service.now = f.service.now.Add(lapse)
			f.verifier.status = appstore.StatusInactive
			headers := map[string]string{"Authorization": "Bearer " + f.hostRefresh}
			assertRefreshResponse(t, f.service.request(t, http.MethodPost, "/v1/tokens/refresh", "", headers), 402, "15")
			restored := f.service.now.Add(time.Second)
			entitlement := appstore.Entitlement{AppTransactionID: defaultSubscriptionID, Environment: "Sandbox", Status: appstore.StatusActive, EntitledUntil: restored.Add(time.Hour), SourceSignedAt: restored, VerifiedAt: restored}
			if err := f.service.handler.broker.ApplyEntitlementNotification(context.Background(), appstore.Notification{UUID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Entitlement: entitlement}); err != nil {
				t.Fatal(err)
			}
			f.service.now = f.service.now.Add(15 * time.Second)
			assertRefreshResponse(t, f.service.request(t, http.MethodPost, "/v1/tokens/refresh", "", headers), 200, "")
			if f.verifier.calls.Load() != 1 {
				t.Fatal("cached recovery called Apple again")
			}
		})
	}
}
