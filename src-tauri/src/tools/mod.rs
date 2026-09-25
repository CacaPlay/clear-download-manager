use crate::app::runtime::ToolId;
use std::{
    collections::HashSet,
    sync::{Mutex, OnceLock},
};

pub(crate) mod catalog;
mod download;
pub(crate) mod manifest;
pub(crate) mod overlay;
mod policy;
pub(crate) mod trust;
mod version;

pub(crate) mod ipc;

static TOOL_OPERATIONS: OnceLock<Mutex<HashSet<ToolId>>> = OnceLock::new();

pub(crate) struct ToolOperationLease(ToolId);

pub(crate) fn acquire_tool_operation(id: ToolId) -> Result<ToolOperationLease, ()> {
    let operations = TOOL_OPERATIONS.get_or_init(|| Mutex::new(HashSet::new()));
    let mut operations = operations.lock().map_err(|_| ())?;
    if !operations.insert(id) {
        return Err(());
    }
    Ok(ToolOperationLease(id))
}

pub(crate) fn tool_operation_active(id: ToolId) -> bool {
    TOOL_OPERATIONS
        .get()
        .and_then(|operations| operations.lock().ok().map(|active| active.contains(&id)))
        .unwrap_or(false)
}

impl Drop for ToolOperationLease {
    fn drop(&mut self) {
        if let Some(operations) = TOOL_OPERATIONS.get() {
            if let Ok(mut operations) = operations.lock() {
                operations.remove(&self.0);
            }
        }
    }
}
