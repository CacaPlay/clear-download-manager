//! Progress Engine V2, isolated from the production V1 pipeline.
//!
//! This module is intentionally in-memory only. It defines the canonical
//! contract, state machine and pure aggregators that will later be fed by
//! engine adapters. V1 still owns SQLite, polling and real workers.

pub(crate) mod adapter;
pub(crate) mod aggregate;
pub(crate) mod aria2;
pub(crate) mod coordinator;
pub(crate) mod diagnostics;
pub(crate) mod ffmpeg;
mod fixtures;
pub(crate) mod http;
pub(crate) mod model;
pub(crate) mod playlist;
pub(crate) mod state_machine;

#[cfg(test)]
mod tests {
    use super::model::{JobPhase, ProgressSnapshotV2, TotalKind, TransferProgress};

    #[test]
    fn v2_contract_is_explicitly_versioned() {
        let snapshot = ProgressSnapshotV2::new(
            42,
            JobPhase::Downloading,
            TransferProgress::with_total(73, Some(200), TotalKind::Estimated),
        );
        assert_eq!(snapshot.schema_version, 2);
        assert!(snapshot.validate().is_ok());
    }
}
