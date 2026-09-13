import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatasetService } from "./index.js";

const databaseUrl = process.env.TEST_DATASET_DATABASE_URL ?? (
  process.env.RUN_DATABASE_INTEGRATION === "1"
    ? process.env.DATASET_DATABASE_URL
    : undefined
);
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;
const schemaName = `dataset_pl_${randomBytes(5).toString("hex")}`;
const quotedSchema = `"${schemaName}"`;
const pool = new Pool(
  databaseUrl === undefined ? undefined : { connectionString: databaseUrl },
);

describeDatabase("DatasetService PostgreSQL", () => {
  const service = new DatasetService(pool);

  beforeAll(async () => {
    await service.setupSchema(schemaName);
    await pool.query(`
      CREATE TABLE ${quotedSchema}.vault_events (
        event_id TEXT PRIMARY KEY,
        chain_id TEXT NOT NULL,
        vault_address TEXT NOT NULL,
        event_type TEXT NOT NULL,
        sender_address TEXT NOT NULL,
        owner_address TEXT NOT NULL,
        receiver_address TEXT,
        assets_raw NUMERIC(78, 0) NOT NULL,
        shares_raw NUMERIC(78, 0) NOT NULL,
        block_number BIGINT NOT NULL,
        block_time TIMESTAMPTZ NOT NULL,
        transaction_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL
      );
      CREATE TABLE ${quotedSchema}.cursors (
        id TEXT PRIMARY KEY,
        cursor TEXT NOT NULL,
        block_num BIGINT NOT NULL,
        block_id TEXT NOT NULL
      );
      CREATE VIEW ${quotedSchema}.hourly_vault_flows AS
      SELECT vault_address,
             date_trunc('hour', block_time) AS hour_start,
             SUM(CASE WHEN event_type = 'DEPOSIT' THEN assets_raw ELSE 0 END) AS inflow_assets_raw,
             SUM(CASE WHEN event_type = 'WITHDRAW' THEN assets_raw ELSE 0 END) AS outflow_assets_raw,
             SUM(CASE WHEN event_type = 'DEPOSIT' THEN assets_raw ELSE -assets_raw END) AS net_assets_raw,
             COUNT(*) FILTER (WHERE event_type = 'DEPOSIT') AS deposit_count,
             COUNT(*) FILTER (WHERE event_type = 'WITHDRAW') AS withdrawal_count,
             COUNT(DISTINCT owner_address) AS unique_owners
      FROM ${quotedSchema}.vault_events
      GROUP BY vault_address, date_trunc('hour', block_time)
    `);
    const vault = "0x050ce30b927da55177a4914ec73480238bad56f0";
    const owner = "0x3af0490e309a701ef5ab55cd017b74f2e192e8c0";
    const sender = owner;
    for (const [index, eventType, assets] of [
      [1, "DEPOSIT", "100"],
      [2, "DEPOSIT", "250"],
      [3, "WITHDRAW", "40"],
    ] as const) {
      await pool.query(
        `INSERT INTO ${quotedSchema}.vault_events
         (event_id, chain_id, vault_address, event_type, sender_address,
          owner_address, receiver_address, assets_raw, shares_raw, block_number,
          block_time, transaction_hash, log_index)
         VALUES ($1, 'base-mainnet', $2, $3, $4, $5, $6, $7, $8, $9,
                 $10::timestamptz, $11, $12)`,
        [
          `event-${index}`,
          vault,
          eventType,
          sender,
          owner,
          eventType === "WITHDRAW" ? owner : null,
          assets,
          assets,
          100 + index,
          "2026-09-07T13:27:27Z",
          `0x${String(index).padStart(64, "0")}`,
          index,
        ],
      );
    }
    await pool.query(
      `INSERT INTO ${quotedSchema}.cursors (id, cursor, block_num, block_id)
       VALUES ('cursor', 'opaque', 103, 'block')`,
    );
  });

  afterAll(async () => {
    if (databaseUrl !== undefined) {
      await pool.query(`DROP SCHEMA ${quotedSchema} CASCADE`);
    }
    await pool.end();
  });

  it("returns health, paginated events, hourly flows, and top depositors", async () => {
    await expect(service.health(schemaName)).resolves.toEqual({
      indexedThroughBlock: "103",
    });
    const firstPage = await service.events(schemaName, { limit: 2 });
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = await service.events(schemaName, {
      limit: 2,
      cursor: firstPage.nextCursor!,
    });
    expect(secondPage.items).toHaveLength(1);

    const flows = await service.hourlyFlows(schemaName, {});
    expect(flows.items[0]).toMatchObject({
      inflowAssetsRaw: "350",
      outflowAssetsRaw: "40",
      netAssetsRaw: "310",
      depositCount: "2",
      withdrawalCount: "1",
    });
    const depositors = await service.topDepositors(schemaName, {});
    expect(depositors.items[0]).toMatchObject({
      depositedAssetsRaw: "350",
      depositCount: "2",
    });
  });
});
