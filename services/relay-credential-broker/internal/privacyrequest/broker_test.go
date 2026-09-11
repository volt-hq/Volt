package privacyrequest

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/volt-hq/Volt/services/relay-credential-broker/internal/testdatabase"
)

const grantA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const grantB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

func seed(t *testing.T) (*pgxpool.Pool, Scope) {
	t.Helper()
	pool := testdatabase.Open(t)
	_, err := pool.Exec(context.Background(), `
	INSERT INTO grants(id,host_node_id,created_at) VALUES
	 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',repeat('a',64),now()),
	 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',repeat('b',64),now());
	INSERT INTO endpoints(id,grant_id,kind,node_id,refresh_token_hash,refresh_inactive_expires_at,created_at)
	 SELECT id,id,'host',host_node_id,decode(host_node_id,'hex'),now()+interval '90 days',now() FROM grants;
	INSERT INTO pairing_claims(id,claim_secret_hash,host_node_id,grant_id,approved_app_endpoint_id,created_at,expires_at)
	 SELECT left(host_node_id,1),decode(repeat(left(host_node_id,1)||'0',32),'hex'),host_node_id,id,id,now(),now()+interval '10 minutes' FROM grants;
	INSERT INTO pairing_claims(id,claim_secret_hash,host_node_id,bootstrap_host_refresh_hash,created_at,expires_at)
	 VALUES('unbound-a',decode(repeat('01',32),'hex'),repeat('a',64),decode(repeat('02',32),'hex'),now(),now()+interval '10 minutes');
	INSERT INTO app_store_entitlements(app_transaction_id,environment,status,source_signed_at,last_verified_at,updated_at)
	 VALUES('transaction-a','Sandbox','inactive',now(),now(),now()),('transaction-b','Sandbox','inactive',now(),now(),now());
	INSERT INTO grant_entitlements(grant_id,app_transaction_id,bound_claim_created_at,bound_at)
	 SELECT id,'transaction-'||left(host_node_id,1),now(),now() FROM grants;
	INSERT INTO app_store_approval_proofs(proof_identity_hash,claim_id,app_transaction_id,proof_created_at,consumed_at)
	 SELECT decode(repeat(left(host_node_id,1)||'1',32),'hex'),left(host_node_id,1),'transaction-'||left(host_node_id,1),now(),now() FROM grants;
	INSERT INTO app_store_notifications(notification_uuid,app_transaction_id,source_signed_at,received_at)
	 SELECT id::text,'transaction-'||left(host_node_id,1),now(),now() FROM grants;
	INSERT INTO pairing_attestation_keys(key_id, public_key, registration_hash, app_transaction_id, device_id_hash, created_at, last_used_at)
	 SELECT repeat(left(host_node_id,1),44),decode(repeat('04',65),'hex'),decode(repeat('05',32),'hex'),'transaction-'||left(host_node_id,1),decode(repeat('06',32),'hex'),now(),now() FROM grants;
	INSERT INTO pairing_attestation_challenges(nonce_hash,purpose,claim_id,key_id,request_hash,app_check_jti_hash,expires_at)
	 SELECT decode(repeat(left(host_node_id,1)||'2',32),'hex'),'approve',left(host_node_id,1),repeat(left(host_node_id,1),44),decode(repeat('07',32),'hex'),decode(repeat(left(host_node_id,1)||'3',32),'hex'),now()+interval '2 minutes' FROM grants;
	INSERT INTO consumed_app_check_tokens(jti_hash,expires_at,consumed_at)
	 VALUES(decode(repeat('03',32),'hex'),now()+interval '1 hour',now());`)
	if err != nil {
		t.Fatal(err)
	}
	scope := Scope{CaseID: "disposable-rehearsal", VerificationReference: "test-fixture-owned-by-test", GrantIDs: []string{grantA}, AppTransactionIDs: []string{"transaction-a"}, ClaimIDs: []string{"unbound-a"}}
	if err := pool.QueryRow(context.Background(), `SELECT current_database(), current_schema()`).Scan(&scope.Database, &scope.Schema); err != nil {
		t.Fatal(err)
	}
	return pool, scope
}

// Regression: #349. A deletion request must not erase another installation's
// broker state, and replay-prevention hashes cannot be attributed by guesswork.
func TestRegression349DeleteOnlyReviewedSubject(t *testing.T) {
	pool, scope := seed(t)
	ctx := context.Background()
	plan, err := Preview(ctx, pool, scope)
	if err != nil {
		t.Fatal(err)
	}
	for _, table := range tables {
		want := 1
		if table.name == "pairing_claims" {
			want = 2
		}
		if plan.Counts[table.name] != want {
			t.Fatalf("%s count %d, want %d", table.name, plan.Counts[table.name], want)
		}
	}
	unrelated := scope
	unrelated.GrantIDs, unrelated.AppTransactionIDs, unrelated.ClaimIDs = []string{grantB}, []string{"transaction-b"}, nil
	before, err := Preview(ctx, pool, unrelated)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Apply(ctx, pool, scope, plan.Fingerprint); err != nil {
		t.Fatal(err)
	}
	after, err := Preview(ctx, pool, unrelated)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, after) {
		t.Fatal("unrelated records changed")
	}
	if got := testdatabase.Count(t, pool, "consumed_app_check_tokens"); got != 1 {
		t.Fatalf("replay records: %d", got)
	}
	empty, err := Preview(ctx, pool, scope)
	if err != nil {
		t.Fatal(err)
	}
	for table, count := range empty.Counts {
		if count != 0 {
			t.Fatalf("%s still has %d records", table, count)
		}
	}
	if _, err := Apply(ctx, pool, scope, plan.Fingerprint); err == nil {
		t.Fatal("old fingerprint accepted after deletion")
	}
	if _, err := Apply(ctx, pool, scope, empty.Fingerprint); err != nil {
		t.Fatal(err)
	}
}

func TestRegression349RefuseRelationshipsOutsideScope(t *testing.T) {
	pool, scope := seed(t)
	scope.AppTransactionIDs = nil
	if _, err := Preview(context.Background(), pool, scope); err == nil {
		t.Fatal("grant's unapproved transaction crossed scope")
	}
	scope.GrantIDs = nil
	scope.AppTransactionIDs = []string{"transaction-a"}
	if _, err := Preview(context.Background(), pool, scope); err == nil {
		t.Fatal("transaction's unapproved grant crossed scope")
	}
}

func TestRegression349ChangedRecordsRequireNewReview(t *testing.T) {
	pool, scope := seed(t)
	ctx := context.Background()
	plan, err := Preview(ctx, pool, scope)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE app_store_entitlements SET status='expired' WHERE app_transaction_id='transaction-a'`); err != nil {
		t.Fatal(err)
	}
	if _, err := Apply(ctx, pool, scope, plan.Fingerprint); err == nil {
		t.Fatal("changed records accepted")
	}
	if testdatabase.Count(t, pool, "grants") != 2 {
		t.Fatal("partial deletion after review mismatch")
	}
}

func TestRegression349FailureRollsBackAllTables(t *testing.T) {
	pool, scope := seed(t)
	ctx := context.Background()
	_, err := pool.Exec(ctx, `CREATE TABLE retained_record(grant_id uuid REFERENCES grants(id)); INSERT INTO retained_record VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')`)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := Preview(ctx, pool, scope)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Apply(ctx, pool, scope, plan.Fingerprint); err == nil {
		t.Fatal("expected foreign key failure")
	}
	after, err := Preview(ctx, pool, scope)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(plan, after) {
		t.Fatal("failed deletion changed records")
	}
}

func TestRegression349RestoredBackupReappliesCompletedDeletion(t *testing.T) {
	for _, tool := range []string{"pg_dump", "psql"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skipf("backup rehearsal requires %s", tool)
		}
	}
	pool, scope := seed(t)
	ctx := context.Background()
	backup := filepath.Join(t.TempDir(), "disposable-backup.sql")
	connection := pool.Config().ConnConfig
	if !strings.HasPrefix(connection.Host, "/") || connection.Password != "" {
		t.Skip("backup restore rehearsal requires a disposable local Unix-socket database")
	}
	dump := exec.CommandContext(ctx, "pg_dump", "--no-owner", "--no-acl", "--schema", scope.Schema, "--file", backup)
	dump.Env = append(os.Environ(), "PGDATABASE="+connection.Database, "PGHOST="+connection.Host,
		"PGPORT="+strconv.Itoa(int(connection.Port)), "PGUSER="+connection.User, "PGPASSWORD=", "PGSSLMODE=disable")
	if output, err := dump.CombinedOutput(); err != nil {
		t.Fatalf("dump failed: %v %s", err, output)
	}
	plan, err := Preview(ctx, pool, scope)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Apply(ctx, pool, scope, plan.Fingerprint); err != nil {
		t.Fatal(err)
	}
	// Only the randomly named schema owned by this test is replaced.
	if _, err := pool.Exec(ctx, "DROP SCHEMA "+pgx.Identifier{scope.Schema}.Sanitize()+" CASCADE"); err != nil {
		t.Fatal(err)
	}
	restore := exec.CommandContext(ctx, "psql", "--no-psqlrc", "--set", "ON_ERROR_STOP=1", "--file", backup)
	restore.Env = dump.Env
	if output, err := restore.CombinedOutput(); err != nil {
		t.Fatalf("restore failed: %v %s", err, output)
	}
	if testdatabase.Count(t, pool, "grants") != 2 {
		t.Fatal("backup did not restore deleted subject")
	}
	review, err := Preview(ctx, pool, scope)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Apply(ctx, pool, scope, review.Fingerprint); err != nil {
		t.Fatal(err)
	}
	if testdatabase.Count(t, pool, "grants") != 1 || testdatabase.Count(t, pool, "app_store_entitlements") != 1 {
		t.Fatal("restored deletion not reapplied")
	}
	var remaining string
	if err := pool.QueryRow(ctx, `SELECT id::text FROM grants`).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != grantB {
		t.Fatal("wrong subject survived restore replay")
	}
}
