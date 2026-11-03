-- A phone that pairs with the same computer again replaces its earlier app
-- endpoint, including one revoked after a failed pairing. Only one active
-- endpoint per grant, kind, and node remains unique; revoked rows stay until
-- retention cleanup.
ALTER TABLE endpoints DROP CONSTRAINT endpoints_grant_id_kind_node_id_key;
CREATE UNIQUE INDEX endpoints_one_active_node_per_grant
    ON endpoints (grant_id, kind, node_id)
    WHERE revoked_at IS NULL;
