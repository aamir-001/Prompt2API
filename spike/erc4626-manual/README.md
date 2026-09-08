# ERC-4626 manual feasibility spike

This prompt-independent package proves the Phase 1 data path before platform or
planner work. It decodes standard ERC-4626 `Deposit` and `Withdraw` events from
three active Base vaults, emits typed protobuf messages, and writes normalized
rows through the integrated Substreams PostgreSQL sink.

## Pinned environment

- Rust `1.88.0`
- Substreams CLI `1.22.0`
- `ethereum-common` `v0.3.3` via its full `spkg.io` URL
- `substreams-database-change` `4.0.0`

Current official Substreams guidance uses `network: base`, full package URLs,
and a `build.rs` for ABI/protobuf generation. Those current requirements
supersede the older illustrative values in the implementation specification.

Substreams CLI `1.22.0` already supplies the current
`sf.substreams.sink.sql.service.v1.Service` descriptor. Importing the archived
standalone SQL protodefs package alongside the integrated CLI produces a
deprecated/current descriptor collision, so this package imports only the
Database Changes types and relies on the integrated sink service descriptor.

## Golden Base fixtures

Validation range: blocks `50999146` through `51000146` (stop exclusive).

| Vault | Label | Deposit coverage | Withdraw coverage |
| --- | --- | ---: | ---: |
| `0x050ce30b927da55177a4914ec73480238bad56f0` | Gauntlet USDC Prime v2 | 138 | 48 |
| `0xbeeff2490feffa212fac2f6553682c219e6a8845` | Steakhouse High Yield USDC Edition | 66 | 13 |
| `0xee8f4ec5672f09119b96ab6fb59c27e1b7e44b61` | Gauntlet USDC Prime | 4 | 6 |

All three returned the Base USDC asset address
`0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` from the standard `asset()` call.

## Commands

Run these inside the repository dev container:

```bash
substreams build ./spike/erc4626-manual/substreams.yaml
substreams info ./spike/erc4626-manual/substreams.yaml
substreams graph ./spike/erc4626-manual/substreams.yaml
substreams run -e "$SUBSTREAMS_ENDPOINT" -s 50999146 -t 51000146 \
  ./spike/erc4626-manual/substreams.yaml map_vault_events -o jsonl
```

For the SQL sink, use a dataset DSN whose scheme is `psql://` or `postgres://`.
The Prisma/psql-style `postgresql://` value is converted deterministically by
the Phase 1 backend.

Verified results for the short range `50999146..50999246`:

- 20 deposits and 7 withdrawals inserted.
- Three hourly view rows, one per configured vault.
- First sink cursor at block `50999243`.
- A restarted sink resumed at block `50999244`, extended through block
  `50999345`, and increased the event count to 54 without duplicates.
