-- Add the replacement request-freshness mechanism without changing existing
-- grants, credentials, or receipt consumption. The approval cutover is in code.
CREATE TABLE pairing_attestation_keys (
    key_id text PRIMARY KEY CHECK (length(key_id) = 44),
    public_key bytea NOT NULL CHECK (octet_length(public_key) = 65),
    registration_hash bytea NOT NULL CHECK (octet_length(registration_hash) = 32),
    app_transaction_id text NOT NULL REFERENCES app_store_entitlements(app_transaction_id) ON DELETE CASCADE,
    device_id_hash bytea NOT NULL CHECK (octet_length(device_id_hash) = 32),
    assertion_counter bigint NOT NULL DEFAULT 0 CHECK (
        assertion_counter >= 0 AND assertion_counter <= 4294967295
    ),
    created_at timestamptz NOT NULL,
    last_used_at timestamptz NOT NULL
);

CREATE TABLE pairing_attestation_challenges (
    nonce_hash bytea PRIMARY KEY CHECK (octet_length(nonce_hash) = 32),
    purpose text NOT NULL CHECK (purpose IN ('register', 'approve')),
    claim_id text NOT NULL REFERENCES pairing_claims(id) ON DELETE CASCADE,
    key_id text NOT NULL CHECK (length(key_id) = 44),
    request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
    app_check_jti_hash bytea NOT NULL CHECK (octet_length(app_check_jti_hash) = 32),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    UNIQUE (app_check_jti_hash, purpose)
);
CREATE INDEX pairing_attestation_challenges_expiry
    ON pairing_attestation_challenges (expires_at);
