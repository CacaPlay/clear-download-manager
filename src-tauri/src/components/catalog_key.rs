//! Public trust anchor for the Component Manager catalog only.
//! The production private seed remains outside this source tree.

#[cfg(not(feature = "qa-component-manager"))]
pub(crate) const KEY_ID: &str = "component-catalog-2026-01";
#[cfg(not(feature = "qa-component-manager"))]
pub(crate) const PUBLIC_KEY_BASE64: &str = "zysvJaYHVxSS5rFZ8FOdCM29HZVjmANqXE1wQG/RvcY=";

#[cfg(feature = "qa-component-manager")]
pub(crate) const KEY_ID: &str = "component-catalog-qa-20260927";
#[cfg(feature = "qa-component-manager")]
pub(crate) const PUBLIC_KEY_BASE64: &str = "VmFFlBFPcTFAsUDbjFQTDJA40vvEHMe9MWfmcCCB2fw=";
