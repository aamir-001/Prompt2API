import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";
import { DatasetService, encodeCursor, type Queryable } from "./index.js";

function result<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return {
    command: "SELECT",
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  };
}

const eventRow = {
  event_id: "base-mainnet:0xa88efc19760e12e3773270f004ede724b58d9a82d7cef2dd0d9adf811a275095:12",
  chain_id: "base-mainnet",
  vault_address: "0x050ce30b927da55177a4914ec73480238bad56f0",
  event_type: "DEPOSIT" as const,
  sender_address: "0x3af0490e309a701ef5ab55cd017b74f2e192e8c0",
  owner_address: "0x3af0490e309a701ef5ab55cd017b74f2e192e8c0",
  receiver_address: null,
  assets_raw: "523694647",
  shares_raw: "503316024132450944623",
  block_number: "50999150",
  block_time: new Date("2026-09-07T13:27:27Z"),
  transaction_hash: "0xa88efc19760e12e3773270f004ede724b58d9a82d7cef2dd0d9adf811a275095",
  log_index: 12,
};

describe("DatasetService", () => {
  it("uses parameterized filters and opaque keyset cursors", async () => {
    const query = vi
      .fn<Queryable["query"]>()
      .mockResolvedValueOnce(result([eventRow, { ...eventRow, event_id: `${eventRow.event_id}-next` }]))
      .mockResolvedValueOnce(result([]));
    const service = new DatasetService({
      query: query as unknown as Queryable["query"],
    });
    const first = await service.events("dataset_pl_1234abcd", {
      vault: "0x050CE30b927Da55177A4914Ec73480238bAd56F0",
      eventType: "DEPOSIT",
      limit: "1",
    });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTypeOf("string");
    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain('FROM "dataset_pl_1234abcd".vault_events');
    expect(sql).not.toContain(eventRow.vault_address);
    expect(values).toEqual([eventRow.vault_address, "DEPOSIT", 2]);

    await service.events("dataset_pl_1234abcd", {
      cursor: first.nextCursor!,
      limit: 1,
    });
    expect(query.mock.calls[1]?.[1]).toEqual([
      eventRow.block_number,
      eventRow.log_index,
      eventRow.event_id,
      2,
    ]);
  });

  it("rejects identifiers, filters, and cursors outside the contract", async () => {
    const query = vi.fn<Queryable["query"]>();
    const service = new DatasetService({
      query: query as unknown as Queryable["query"],
    });
    await expect(service.events('dataset_pl_safe"; DROP SCHEMA public', {})).rejects.toThrow(
      /schema name/,
    );
    await expect(
      service.events("dataset_pl_1234abcd", { owner: "not-an-address" }),
    ).rejects.toThrow();
    await expect(
      service.events("dataset_pl_1234abcd", { cursor: "not-a-cursor" }),
    ).rejects.toThrow(/cursor/);
    expect(query).not.toHaveBeenCalled();
  });

  it("preserves full-width aggregate values in depositor cursors", async () => {
    const maximum = (2n ** 256n - 1n).toString();
    const ownerAddress = "0xffffffffffffffffffffffffffffffffffffffff";
    const query = vi
      .fn<Queryable["query"]>()
      .mockResolvedValue(result([{ owner_address: ownerAddress, deposited_assets_raw: maximum, deposit_count: "1" }]));
    const service = new DatasetService({
      query: query as unknown as Queryable["query"],
    });
    const page = await service.topDepositors("dataset_pl_1234abcd", {
      cursor: encodeCursor({ depositedAssetsRaw: maximum, ownerAddress }),
    });
    expect(page.items[0]?.depositedAssetsRaw).toBe(maximum);
    expect(query.mock.calls[0]?.[1]).toContain(maximum);
  });
});
