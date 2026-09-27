//! Public trust anchor for the Component Manager catalog only.
//! The private seed is never stored in this source tree.

pub(crate) const KEY_ID: &str = "component-catalog-2026-01";
// Filled by the distributor's one-shot provisioning command. An empty value
// intentionally leaves remote component installation fail-closed.
pub(crate) const PUBLIC_KEY_BASE64: &str = "";
