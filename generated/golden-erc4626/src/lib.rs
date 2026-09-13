mod abi;
mod pb;

mod model {
    include!(concat!(env!("OUT_DIR"), "/prompt2api.erc4626.v1.rs"));
}
use abi::erc4626::events::{Deposit as AbiDeposit, Withdraw as AbiWithdraw};
use model::{Deposit, VaultEvents, Withdraw};
use pb::sf::substreams::ethereum::v1::Events;
use substreams::{errors::Error, Hex};
use substreams_database_change::{
    pb::sf::substreams::sink::database::v1::DatabaseChanges, tables::Tables,
};
use substreams_ethereum::Event;

const CHAIN_ID: &str = "base-mainnet";

fn hex0x(bytes: &[u8]) -> String {
    format!("0x{}", Hex::encode(bytes))
}

fn normalize_hash(hash: &str) -> String {
    let hash = hash.to_ascii_lowercase();
    if hash.starts_with("0x") {
        hash
    } else {
        format!("0x{hash}")
    }
}

fn event_id(transaction_hash: &str, log_index: u32) -> String {
    format!("{CHAIN_ID}:{transaction_hash}:{log_index}")
}

#[substreams::handlers::map]
pub fn map_vault_events(events: Events) -> Result<VaultEvents, Error> {
    let clock = events
        .clock
        .ok_or_else(|| Error::msg("filtered events missing clock"))?;
    let block_time = clock
        .timestamp
        .ok_or_else(|| Error::msg("filtered events missing block timestamp"))?;

    let mut output = VaultEvents::default();

    for event in events.events {
        let Some(log) = event.log else {
            continue;
        };

        let transaction_hash = normalize_hash(&event.tx_hash);
        let vault_address = hex0x(&log.address);

        if let Some(deposit) = AbiDeposit::match_and_decode(&log) {
            output.deposits.push(Deposit {
                event_id: event_id(&transaction_hash, log.index),
                chain_id: CHAIN_ID.to_string(),
                vault_address,
                sender_address: hex0x(&deposit.sender),
                owner_address: hex0x(&deposit.owner),
                assets_raw: deposit.assets.to_string(),
                shares_raw: deposit.shares.to_string(),
                block_number: clock.number,
                block_time: block_time.to_string(),
                transaction_hash,
                log_index: log.index,
            });
        } else if let Some(withdraw) = AbiWithdraw::match_and_decode(&log) {
            output.withdrawals.push(Withdraw {
                event_id: event_id(&transaction_hash, log.index),
                chain_id: CHAIN_ID.to_string(),
                vault_address,
                sender_address: hex0x(&withdraw.sender),
                receiver_address: hex0x(&withdraw.receiver),
                owner_address: hex0x(&withdraw.owner),
                assets_raw: withdraw.assets.to_string(),
                shares_raw: withdraw.shares.to_string(),
                block_number: clock.number,
                block_time: block_time.to_string(),
                transaction_hash,
                log_index: log.index,
            });
        }
    }

    Ok(output)
}

#[substreams::handlers::map]
pub fn db_out(events: VaultEvents) -> Result<DatabaseChanges, Error> {
    let mut tables = Tables::new();

    for event in events.deposits {
        tables
            .create_row("vault_events", event.event_id.as_str())
            .set("chain_id", event.chain_id)
            .set("vault_address", event.vault_address)
            .set("event_type", "DEPOSIT")
            .set("sender_address", event.sender_address)
            .set("owner_address", event.owner_address)
            .set("assets_raw", event.assets_raw)
            .set("shares_raw", event.shares_raw)
            .set("block_number", event.block_number)
            .set("block_time", event.block_time)
            .set("transaction_hash", event.transaction_hash)
            .set("log_index", event.log_index);
    }

    for event in events.withdrawals {
        tables
            .create_row("vault_events", event.event_id.as_str())
            .set("chain_id", event.chain_id)
            .set("vault_address", event.vault_address)
            .set("event_type", "WITHDRAW")
            .set("sender_address", event.sender_address)
            .set("owner_address", event.owner_address)
            .set("receiver_address", event.receiver_address)
            .set("assets_raw", event.assets_raw)
            .set("shares_raw", event.shares_raw)
            .set("block_number", event.block_number)
            .set("block_time", event.block_time)
            .set("transaction_hash", event.transaction_hash)
            .set("log_index", event.log_index);
    }

    Ok(tables.to_database_changes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use pb::sf::substreams::{ethereum::v1::Event as FoundationalEvent, v1::Clock};
    use prost_types::Timestamp;
    use substreams::testing;
    use substreams_ethereum::pb::eth::v2::Log;

    const DEPOSIT_TOPIC: &str = "dcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7";
    const WITHDRAW_TOPIC: &str = "fbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db";

    fn topic_address(fill: u8) -> Vec<u8> {
        let mut topic = vec![0_u8; 32];
        topic[12..].fill(fill);
        topic
    }

    fn u256_word(fill: u8) -> Vec<u8> {
        vec![fill; 32]
    }

    fn input(log: Log) -> Events {
        Events {
            clock: Some(Clock {
                id: "block-hash".to_string(),
                number: 50_999_150,
                timestamp: Some(Timestamp {
                    seconds: 1_789_000_000,
                    nanos: 0,
                }),
            }),
            events: vec![FoundationalEvent {
                log: Some(log),
                tx_hash: "a88efc19760e12e3773270f004ede724b58d9a82d7cef2dd0d9adf811a275095"
                    .to_string(),
            }],
        }
    }

    #[test]
    fn decodes_deposit_and_preserves_max_uint256() {
        let mut data = u256_word(0xff);
        data.extend(u256_word(0x00));
        data[63] = 1;

        let events = testing::map!(map_vault_events(input(Log {
            address: vec![0x05; 20],
            topics: vec![
                hex::decode(DEPOSIT_TOPIC).unwrap(),
                topic_address(0x11),
                topic_address(0x22),
            ],
            data,
            index: 7,
            ..Default::default()
        })))
        .unwrap();

        assert_eq!(events.deposits.len(), 1);
        assert!(events.withdrawals.is_empty());
        let deposit = &events.deposits[0];
        assert_eq!(
            deposit.assets_raw,
            "115792089237316195423570985008687907853269984665640564039457584007913129639935"
        );
        assert_eq!(deposit.shares_raw, "1");
        assert_eq!(deposit.vault_address, format!("0x{}", "05".repeat(20)));
        assert_eq!(
            deposit.event_id,
            format!("base-mainnet:{}:7", deposit.transaction_hash)
        );
    }

    #[test]
    fn decodes_withdraw_addresses() {
        let mut data = u256_word(0x00);
        data[31] = 2;
        data.extend(u256_word(0x00));
        data[63] = 3;

        let events = testing::map!(map_vault_events(input(Log {
            address: vec![0xee; 20],
            topics: vec![
                hex::decode(WITHDRAW_TOPIC).unwrap(),
                topic_address(0x11),
                topic_address(0x22),
                topic_address(0x33),
            ],
            data,
            index: 9,
            ..Default::default()
        })))
        .unwrap();

        assert_eq!(events.withdrawals.len(), 1);
        let withdrawal = &events.withdrawals[0];
        assert_eq!(withdrawal.assets_raw, "2");
        assert_eq!(withdrawal.shares_raw, "3");
        assert_eq!(withdrawal.sender_address, format!("0x{}", "11".repeat(20)));
        assert_eq!(
            withdrawal.receiver_address,
            format!("0x{}", "22".repeat(20))
        );
        assert_eq!(withdrawal.owner_address, format!("0x{}", "33".repeat(20)));
    }

    #[test]
    fn ignores_unknown_topic() {
        let events = testing::map!(map_vault_events(input(Log {
            address: vec![0x05; 20],
            topics: vec![vec![0xaa; 32]],
            index: 1,
            ..Default::default()
        })))
        .unwrap();

        assert!(events.deposits.is_empty());
        assert!(events.withdrawals.is_empty());
    }

    #[test]
    fn db_out_emits_one_normalized_row() {
        let changes = testing::map!(db_out(VaultEvents {
            deposits: vec![Deposit {
                event_id: "base-mainnet:0xabc:1".to_string(),
                chain_id: CHAIN_ID.to_string(),
                vault_address: format!("0x{}", "05".repeat(20)),
                sender_address: format!("0x{}", "11".repeat(20)),
                owner_address: format!("0x{}", "22".repeat(20)),
                assets_raw: "10".to_string(),
                shares_raw: "9".to_string(),
                block_number: 50_999_150,
                block_time: "2026-09-07T13:27:27Z".to_string(),
                transaction_hash: "0xabc".to_string(),
                log_index: 1,
            }],
            withdrawals: vec![],
        }))
        .unwrap();

        assert_eq!(changes.table_changes.len(), 1);
        assert_eq!(changes.table_changes[0].table, "vault_events");
    }
}
