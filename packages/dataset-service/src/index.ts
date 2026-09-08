import type { QueryResult, QueryResultRow } from "pg";
import { z } from "zod";

const AddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const UtcDateSchema = z.string().regex(/Z$/).pipe(z.iso.datetime());

export const EventQuerySchema = z.strictObject({
  vault: AddressSchema.optional(),
  eventType: z.enum(["DEPOSIT", "WITHDRAW"]).optional(),
  owner: AddressSchema.optional(),
  from: UtcDateSchema.optional(),
  to: UtcDateSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().min(1).optional(),
});

export const AggregateQuerySchema = z.strictObject({
  vault: AddressSchema.optional(),
  from: UtcDateSchema.optional(),
  to: UtcDateSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().min(1).optional(),
});

const EventCursorSchema = z.strictObject({
  blockNumber: z.string().regex(/^\d+$/),
  logIndex: z.number().int().nonnegative(),
  eventId: z.string().min(1),
});

const FlowCursorSchema = z.strictObject({
  hourStart: z.string().datetime({ offset: true }),
  vaultAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
});

const DepositorCursorSchema = z.strictObject({
  depositedAssetsRaw: z.string().regex(/^\d+$/),
  ownerAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
});

export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

export interface DatasetPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface VaultEventRow extends QueryResultRow {
  event_id: string;
  chain_id: string;
  vault_address: string;
  event_type: "DEPOSIT" | "WITHDRAW";
  sender_address: string;
  owner_address: string;
  receiver_address: string | null;
  assets_raw: string;
  shares_raw: string;
  block_number: string;
  block_time: Date;
  transaction_hash: string;
  log_index: number;
}

function assertSchemaName(schemaName: string): string {
  if (!/^dataset_pl_[a-z0-9]{8,32}$/.test(schemaName)) {
    throw new Error("Invalid dataset schema name");
  }
  return `"${schemaName}"`;
}

export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor<T>(value: string, schema: z.ZodType<T>): T {
  try {
    return schema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
  } catch (error) {
    throw new Error("Invalid dataset cursor", { cause: error });
  }
}

function addFilter(
  clauses: string[],
  values: unknown[],
  expression: string,
  value: unknown,
): void {
  values.push(value);
  clauses.push(`${expression} $${values.length}`);
}

export class DatasetService {
  constructor(readonly database: Queryable) {}

  async setupSchema(schemaName: string): Promise<void> {
    await this.database.query(`CREATE SCHEMA IF NOT EXISTS ${assertSchemaName(schemaName)}`);
  }

  async health(schemaName: string): Promise<{ indexedThroughBlock: string | null }> {
    const schema = assertSchemaName(schemaName);
    const result = await this.database.query<{ indexed_through_block: string | null }>(
      `SELECT MAX(block_num)::text AS indexed_through_block FROM ${schema}.cursors`,
    );
    return { indexedThroughBlock: result.rows[0]?.indexed_through_block ?? null };
  }

  async events(schemaName: string, input: unknown): Promise<DatasetPage<Record<string, unknown>>> {
    const query = EventQuerySchema.parse(input);
    const schema = assertSchemaName(schemaName);
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (query.vault !== undefined) {
      addFilter(clauses, values, "vault_address =", query.vault.toLowerCase());
    }
    if (query.eventType !== undefined) {
      addFilter(clauses, values, "event_type =", query.eventType);
    }
    if (query.owner !== undefined) {
      addFilter(clauses, values, "owner_address =", query.owner.toLowerCase());
    }
    if (query.from !== undefined) addFilter(clauses, values, "block_time >=", query.from);
    if (query.to !== undefined) addFilter(clauses, values, "block_time <", query.to);
    if (query.cursor !== undefined) {
      const cursor = decodeCursor(query.cursor, EventCursorSchema);
      values.push(cursor.blockNumber, cursor.logIndex, cursor.eventId);
      clauses.push(
        `(block_number, log_index, event_id) < ($${values.length - 2}::bigint, $${values.length - 1}::integer, $${values.length}::text)`,
      );
    }
    values.push(query.limit + 1);
    const result = await this.database.query<VaultEventRow>(
      `SELECT event_id, chain_id, vault_address, event_type, sender_address,
              owner_address, receiver_address, assets_raw::text, shares_raw::text,
              block_number::text, block_time, transaction_hash, log_index
       FROM ${schema}.vault_events
       ${clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`}
       ORDER BY block_number DESC, log_index DESC, event_id DESC
       LIMIT $${values.length}`,
      values,
    );
    const hasNextPage = result.rows.length > query.limit;
    const rows = result.rows.slice(0, query.limit);
    const last = rows.at(-1);
    return {
      items: rows.map(mapEvent),
      nextCursor:
        hasNextPage && last !== undefined
          ? encodeCursor({
              blockNumber: last.block_number,
              logIndex: last.log_index,
              eventId: last.event_id,
            })
          : null,
    };
  }

  async hourlyFlows(
    schemaName: string,
    input: unknown,
  ): Promise<DatasetPage<Record<string, unknown>>> {
    const query = AggregateQuerySchema.parse(input);
    const schema = assertSchemaName(schemaName);
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (query.vault !== undefined) {
      addFilter(clauses, values, "vault_address =", query.vault.toLowerCase());
    }
    if (query.from !== undefined) addFilter(clauses, values, "hour_start >=", query.from);
    if (query.to !== undefined) addFilter(clauses, values, "hour_start <", query.to);
    if (query.cursor !== undefined) {
      const cursor = decodeCursor(query.cursor, FlowCursorSchema);
      values.push(cursor.hourStart, cursor.vaultAddress);
      clauses.push(
        `(hour_start, vault_address) < ($${values.length - 1}::timestamptz, $${values.length}::text)`,
      );
    }
    values.push(query.limit + 1);
    const result = await this.database.query<
      QueryResultRow & {
        vault_address: string;
        hour_start: Date;
        inflow_assets_raw: string;
        outflow_assets_raw: string;
        net_assets_raw: string;
        deposit_count: string;
        withdrawal_count: string;
        unique_owners: string;
      }
    >(
      `SELECT vault_address, hour_start, inflow_assets_raw::text,
              outflow_assets_raw::text, net_assets_raw::text,
              deposit_count::text, withdrawal_count::text, unique_owners::text
       FROM ${schema}.hourly_vault_flows
       ${clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`}
       ORDER BY hour_start DESC, vault_address DESC
       LIMIT $${values.length}`,
      values,
    );
    const hasNextPage = result.rows.length > query.limit;
    const rows = result.rows.slice(0, query.limit);
    const last = rows.at(-1);
    return {
      items: rows.map((row) => ({
        vaultAddress: row.vault_address,
        hourStart: row.hour_start.toISOString(),
        inflowAssetsRaw: row.inflow_assets_raw,
        outflowAssetsRaw: row.outflow_assets_raw,
        netAssetsRaw: row.net_assets_raw,
        depositCount: row.deposit_count,
        withdrawalCount: row.withdrawal_count,
        uniqueOwners: row.unique_owners,
      })),
      nextCursor:
        hasNextPage && last !== undefined
          ? encodeCursor({
              hourStart: last.hour_start.toISOString(),
              vaultAddress: last.vault_address,
            })
          : null,
    };
  }

  async topDepositors(
    schemaName: string,
    input: unknown,
  ): Promise<DatasetPage<Record<string, unknown>>> {
    const query = AggregateQuerySchema.parse(input);
    const schema = assertSchemaName(schemaName);
    const clauses = ["event_type = 'DEPOSIT'"];
    const values: unknown[] = [];
    if (query.vault !== undefined) {
      addFilter(clauses, values, "vault_address =", query.vault.toLowerCase());
    }
    if (query.from !== undefined) addFilter(clauses, values, "block_time >=", query.from);
    if (query.to !== undefined) addFilter(clauses, values, "block_time <", query.to);
    let cursorClause = "";
    if (query.cursor !== undefined) {
      const cursor = decodeCursor(query.cursor, DepositorCursorSchema);
      values.push(cursor.depositedAssetsRaw, cursor.ownerAddress);
      cursorClause = `HAVING (SUM(assets_raw), owner_address) < ($${values.length - 1}::numeric, $${values.length}::text)`;
    }
    values.push(query.limit + 1);
    const result = await this.database.query<
      QueryResultRow & {
        owner_address: string;
        deposited_assets_raw: string;
        deposit_count: string;
      }
    >(
      `SELECT owner_address, SUM(assets_raw)::text AS deposited_assets_raw,
              COUNT(*)::text AS deposit_count
       FROM ${schema}.vault_events
       WHERE ${clauses.join(" AND ")}
       GROUP BY owner_address
       ${cursorClause}
       ORDER BY SUM(assets_raw) DESC, owner_address DESC
       LIMIT $${values.length}`,
      values,
    );
    const hasNextPage = result.rows.length > query.limit;
    const rows = result.rows.slice(0, query.limit);
    const last = rows.at(-1);
    return {
      items: rows.map((row) => ({
        ownerAddress: row.owner_address,
        depositedAssetsRaw: row.deposited_assets_raw,
        depositCount: row.deposit_count,
      })),
      nextCursor:
        hasNextPage && last !== undefined
          ? encodeCursor({
              depositedAssetsRaw: last.deposited_assets_raw,
              ownerAddress: last.owner_address,
            })
          : null,
    };
  }
}

function mapEvent(row: VaultEventRow): Record<string, unknown> {
  return {
    eventId: row.event_id,
    chainId: row.chain_id,
    vaultAddress: row.vault_address,
    eventType: row.event_type,
    senderAddress: row.sender_address,
    ownerAddress: row.owner_address,
    receiverAddress: row.receiver_address,
    assetsRaw: row.assets_raw,
    sharesRaw: row.shares_raw,
    blockNumber: row.block_number,
    blockTime: row.block_time.toISOString(),
    transactionHash: row.transaction_hash,
    logIndex: row.log_index,
  };
}
