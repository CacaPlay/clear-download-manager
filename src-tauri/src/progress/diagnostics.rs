//! Development-only tracing for the Progress Engine V2 hand-off.
//!
//! The trace is bounded, contains no URLs or file paths, and is disabled from
//! the observable output in release builds. It distinguishes worker,
//! coordinator, IPC, and DOM failures without changing progress semantics.

use serde::Serialize;
#[cfg(debug_assertions)]
use std::collections::VecDeque;
#[cfg(debug_assertions)]
use std::sync::{Mutex, OnceLock};
#[cfg(debug_assertions)]
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_EVENTS: usize = 256;

#[cfg_attr(not(debug_assertions), allow(dead_code))]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProgressDiagnosticEvent {
    pub(crate) sequence: u64,
    pub(crate) at_ms: u64,
    pub(crate) stage: String,
    pub(crate) job_id: Option<i64>,
    pub(crate) detail: String,
}

#[cfg(debug_assertions)]
static EVENTS: OnceLock<Mutex<VecDeque<ProgressDiagnosticEvent>>> = OnceLock::new();

#[cfg(debug_assertions)]
fn events() -> &'static Mutex<VecDeque<ProgressDiagnosticEvent>> {
    EVENTS.get_or_init(|| Mutex::new(VecDeque::with_capacity(MAX_EVENTS)))
}

pub(crate) fn record(stage: &str, job_id: Option<i64>, detail: impl Into<String>) {
    #[cfg(debug_assertions)]
    {
        let Ok(mut events) = events().lock() else {
            return;
        };
        let sequence = events.back().map(|event| event.sequence + 1).unwrap_or(1);
        if events.len() == MAX_EVENTS {
            events.pop_front();
        }
        events.push_back(ProgressDiagnosticEvent {
            sequence,
            at_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or_default(),
            stage: stage.to_string(),
            job_id,
            detail: detail.into(),
        });
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = (stage, job_id, detail);
    }
}

pub(crate) fn snapshot() -> serde_json::Value {
    #[cfg(debug_assertions)]
    {
        let events = events()
            .lock()
            .map(|events| events.iter().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        serde_json::json!({ "enabled": true, "events": events })
    }
    #[cfg(not(debug_assertions))]
    {
        serde_json::json!({ "enabled": false, "events": [] })
    }
}
