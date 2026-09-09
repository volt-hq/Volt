// Package privacyrequest implements reviewed, offline privacy operations. It is
// not exposed by the broker HTTP service and cannot authenticate a requester.
package privacyrequest

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Scope struct {
	CaseID                string   `json:"caseID"`
	VerificationReference string   `json:"verificationReference"`
	Database              string   `json:"database"`
	Schema                string   `json:"schema"`
	GrantIDs              []string `json:"grantIDs"`
	AppTransactionIDs     []string `json:"appTransactionIDs"`
	ClaimIDs              []string `json:"claimIDs"`
}

type Plan struct {
	Scope       Scope          `json:"scope"`
	Counts      map[string]int `json:"counts"`
	Fingerprint string         `json:"fingerprint"`
}

var uuid = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var transactionID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

func (s Scope) Validate() error {
	if s.CaseID == "" || s.VerificationReference == "" || s.Database == "" || s.Schema == "" {
		return errors.New("case ID, verification reference, database and schema are required")
	}
	if len(s.GrantIDs)+len(s.AppTransactionIDs)+len(s.ClaimIDs) == 0 {
		return errors.New("explicit record IDs are required")
	}
	for _, list := range [][]string{s.GrantIDs, s.AppTransactionIDs, s.ClaimIDs} {
		seen := make(map[string]bool)
		if len(list) > 100 {
			return errors.New("review at most 100 identifiers of each type per case")
		}
		for _, id := range list {
			if id == "" || len(id) > 512 || seen[id] {
				return errors.New("empty, duplicate or oversized identifier")
			}
			seen[id] = true
		}
	}
	for _, id := range s.GrantIDs {
		if !uuid.MatchString(id) {
			return errors.New("grant ID must be a lowercase UUID")
		}
	}
	for _, id := range s.AppTransactionIDs {
		if !transactionID.MatchString(id) {
			return errors.New("invalid app transaction ID")
		}
	}
	return nil
}

const scopeSQL = `WITH scope AS (SELECT COALESCE($1::uuid[], '{}') AS grants, COALESCE($2::text[], '{}') AS transactions, COALESCE($3::text[], '{}') AS claims) `
const selectedClaims = `(SELECT c.id FROM pairing_claims c, scope s WHERE c.grant_id = ANY(s.grants) OR c.id = ANY(s.claims))`

// Delete in dependency order; each predicate is also used to fingerprint the
// exact rows. Row contents, including credential hashes, never leave the plan.
var tables = []struct{ name, predicate string }{
	{"app_store_approval_proofs", `t.app_transaction_id = ANY(s.transactions) OR t.claim_id IN ` + selectedClaims},
	{"app_store_notifications", `t.app_transaction_id = ANY(s.transactions)`},
	{"grant_entitlements", `t.grant_id = ANY(s.grants) OR t.app_transaction_id = ANY(s.transactions)`},
	{"pairing_claims", `t.id IN ` + selectedClaims},
	{"endpoints", `t.grant_id = ANY(s.grants)`},
	{"grants", `t.id = ANY(s.grants)`},
	{"app_store_entitlements", `t.app_transaction_id = ANY(s.transactions)`},
}

func Preview(ctx context.Context, pool *pgxpool.Pool, scope Scope) (Plan, error) {
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return Plan{}, err
	}
	defer tx.Rollback(context.Background())
	return preview(ctx, tx, scope)
}

func preview(ctx context.Context, tx pgx.Tx, scope Scope) (Plan, error) {
	if err := scope.Validate(); err != nil {
		return Plan{}, err
	}
	var databaseName, schema string
	if err := tx.QueryRow(ctx, `SELECT current_database(), current_schema()`).Scan(&databaseName, &schema); err != nil {
		return Plan{}, err
	}
	if databaseName != scope.Database || schema != scope.Schema {
		return Plan{}, errors.New("database/schema does not match reviewed scope")
	}
	var version, count int
	if err := tx.QueryRow(ctx, `SELECT COALESCE(max(version),0), count(*) FROM schema_migrations`).Scan(&version, &count); err != nil {
		return Plan{}, err
	}
	if version != 3 || count != 3 {
		return Plan{}, errors.New("unsupported schema; review the deletion queries against its migrations")
	}
	args := []interface{}{scope.GrantIDs, scope.AppTransactionIDs, scope.ClaimIDs}
	// Do not follow relationships into records outside the approved scope. A
	// transferred subscription or shared grant needs a new ownership review.
	var crossesScope bool
	err := tx.QueryRow(ctx, scopeSQL+`SELECT
	 EXISTS(SELECT 1 FROM grant_entitlements g, scope s WHERE
	   (g.grant_id = ANY(s.grants)) <> (g.app_transaction_id = ANY(s.transactions)))
	 OR EXISTS(SELECT 1 FROM pairing_claims c, scope s WHERE c.id = ANY(s.claims)
	   AND c.grant_id IS NOT NULL AND NOT (c.grant_id = ANY(s.grants)))
	 OR EXISTS(SELECT 1 FROM app_store_approval_proofs p, scope s WHERE
	   (p.claim_id IN `+selectedClaims+`) <> (p.app_transaction_id = ANY(s.transactions)))
	 OR EXISTS(SELECT 1 FROM pairing_claims c JOIN endpoints e ON e.id=c.approved_app_endpoint_id, scope s
	   WHERE (c.id IN `+selectedClaims+`) <> (e.grant_id = ANY(s.grants)))`, args...).Scan(&crossesScope)
	if err != nil {
		return Plan{}, err
	}
	if crossesScope {
		return Plan{}, errors.New("relationships cross the approved scope; resolve ownership before planning")
	}
	plan := Plan{Scope: scope, Counts: make(map[string]int)}
	hash := sha256.New()
	encoded, err := json.Marshal(scope)
	if err != nil {
		return Plan{}, err
	}
	hash.Write(encoded)
	for _, table := range tables {
		hash.Write([]byte("\n" + table.name + "\n"))
		rows, err := tx.Query(ctx, scopeSQL+`SELECT to_jsonb(t)::text FROM `+table.name+` t, scope s WHERE `+table.predicate+` ORDER BY to_jsonb(t)::text`, args...)
		if err != nil {
			return Plan{}, err
		}
		plan.Counts[table.name] = 0
		for rows.Next() {
			var row string
			if err := rows.Scan(&row); err != nil {
				rows.Close()
				return Plan{}, err
			}
			hash.Write([]byte(row + "\n"))
			plan.Counts[table.name]++
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return Plan{}, err
		}
	}
	plan.Fingerprint = hex.EncodeToString(hash.Sum(nil))
	return plan, nil
}

// Apply holds short table write locks so inserts, refreshes and rebindings
// cannot race the scope check. Run during an agreed maintenance window.
// Failure rolls the entire broker deletion back. Other providers are separate.
func Apply(ctx context.Context, pool *pgxpool.Pool, scope Scope, fingerprint string) (Plan, error) {
	if len(fingerprint) != 64 {
		return Plan{}, errors.New("a reviewed plan fingerprint is required")
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return Plan{}, err
	}
	defer tx.Rollback(context.Background())
	if _, err := tx.Exec(ctx, `SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '30s'`); err != nil {
		return Plan{}, err
	}
	if _, err := tx.Exec(ctx, `LOCK TABLE schema_migrations, grants, endpoints, pairing_claims,
	 grant_entitlements, app_store_entitlements, app_store_approval_proofs, app_store_notifications IN SHARE ROW EXCLUSIVE MODE`); err != nil {
		return Plan{}, err
	}
	plan, err := preview(ctx, tx, scope)
	if err != nil {
		return Plan{}, err
	}
	if plan.Fingerprint != fingerprint {
		return Plan{}, errors.New("records changed since review; create and review a fresh plan")
	}
	args := []interface{}{scope.GrantIDs, scope.AppTransactionIDs, scope.ClaimIDs}
	for _, table := range tables {
		result, err := tx.Exec(ctx, scopeSQL+`DELETE FROM `+table.name+` t USING scope s WHERE `+table.predicate, args...)
		if err != nil {
			return Plan{}, err
		}
		if result.RowsAffected() != int64(plan.Counts[table.name]) {
			return Plan{}, fmt.Errorf("unexpected deletion count for %s", table.name)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Plan{}, err
	}
	return plan, nil
}
