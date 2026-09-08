CREATE TABLE IF NOT EXISTS vault_events (
    event_id TEXT PRIMARY KEY,
    chain_id TEXT NOT NULL,
    vault_address TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('DEPOSIT', 'WITHDRAW')),
    sender_address TEXT NOT NULL,
    owner_address TEXT NOT NULL,
    receiver_address TEXT NULL,
    assets_raw NUMERIC(78,0) NOT NULL,
    shares_raw NUMERIC(78,0) NOT NULL,
    block_number BIGINT NOT NULL,
    block_time TIMESTAMPTZ NOT NULL,
    transaction_hash TEXT NOT NULL,
    log_index INTEGER NOT NULL,
    UNIQUE (chain_id, transaction_hash, log_index)
);

CREATE INDEX IF NOT EXISTS idx_vault_events_block_number
    ON vault_events (block_number);
CREATE INDEX IF NOT EXISTS idx_vault_events_block_time
    ON vault_events (block_time);
CREATE INDEX IF NOT EXISTS idx_vault_events_vault_time
    ON vault_events (vault_address, block_time);
CREATE INDEX IF NOT EXISTS idx_vault_events_owner_time
    ON vault_events (owner_address, block_time);
CREATE INDEX IF NOT EXISTS idx_vault_events_type_time
    ON vault_events (event_type, block_time);

CREATE OR REPLACE VIEW hourly_vault_flows AS
SELECT
    vault_address,
    date_trunc('hour', block_time) AS hour_start,
    SUM(CASE WHEN event_type = 'DEPOSIT' THEN assets_raw ELSE 0 END) AS inflow_assets_raw,
    SUM(CASE WHEN event_type = 'WITHDRAW' THEN assets_raw ELSE 0 END) AS outflow_assets_raw,
    SUM(CASE WHEN event_type = 'DEPOSIT' THEN assets_raw ELSE -assets_raw END) AS net_assets_raw,
    COUNT(*) FILTER (WHERE event_type = 'DEPOSIT') AS deposit_count,
    COUNT(*) FILTER (WHERE event_type = 'WITHDRAW') AS withdrawal_count,
    COUNT(DISTINCT owner_address) AS unique_owners
FROM vault_events
GROUP BY vault_address, date_trunc('hour', block_time);

