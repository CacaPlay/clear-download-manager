//! Maintainer-only support for Component Manager's inline-signed catalog.
//!
//! This deliberately does not call `catalog_tooling`: that module handles the
//! unrelated Tool Catalog envelope. Canonical payload bytes here are exactly
//! `serde_json::to_vec(payload)`, matching the production verifier.

use crate::components::ComponentId;
use crate::{
    components::distribution::{
        verify_component_catalog, ComponentCatalogPayload, SignedComponentCatalog,
    },
    tools::{manifest::reject_duplicate_keys, trust::TrustedKeys},
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use ed25519_dalek::{Signer, SigningKey};
use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ComponentCatalogInspection {
    pub schema_version: u32,
    pub catalog_version: String,
    pub sequence: u64,
    pub key_id: String,
    pub issued_at: i64,
    pub expires_at: i64,
    pub component_ids: Vec<String>,
    pub signature_model: &'static str,
}

fn parse_payload(payload_json: &[u8]) -> Result<ComponentCatalogPayload, String> {
    reject_duplicate_keys(payload_json)
        .map_err(|_| "component catalog payload contains duplicate JSON keys".to_string())?;
    serde_json::from_slice(payload_json)
        .map_err(|error| format!("invalid component catalog payload: {error}"))
}

/// Assemble a payload into the exact canonical bytes verified by production.
pub fn assemble_payload(payload_json: &[u8]) -> Result<Vec<u8>, String> {
    let payload = parse_payload(payload_json)?;
    crate::components::distribution::validate_payload(&payload, false)
        .map_err(|error| format!("component catalog payload rejected: {error}"))?;
    serde_json::to_vec(&payload).map_err(|error| error.to_string())
}

fn decode_seed(seed_base64: &str) -> Result<[u8; 32], String> {
    let seed_base64 = seed_base64.trim();
    let bytes = STANDARD
        .decode(seed_base64)
        .map_err(|_| "private seed must be canonical base64".to_string())?;
    if bytes.len() != 32 || STANDARD.encode(&bytes) != seed_base64 {
        return Err("private seed must be exactly 32 bytes in canonical base64".into());
    }
    bytes
        .try_into()
        .map_err(|_| "private seed must be exactly 32 bytes".to_string())
}

/// Sign a component payload and return `{payload, signature}` JSON inline.
/// The seed is accepted as a value by this library API so callers can source
/// it from a protected environment; callers must never log or persist it.
pub fn sign_payload(payload_json: &[u8], seed_base64: &str) -> Result<Vec<u8>, String> {
    let payload = parse_payload(payload_json)?;
    crate::components::distribution::validate_payload(&payload, false)
        .map_err(|error| format!("component catalog payload rejected: {error}"))?;
    let canonical = serde_json::to_vec(&payload).map_err(|error| error.to_string())?;
    let seed = decode_seed(seed_base64)?;
    let signing_key = SigningKey::from_bytes(&seed);
    let signature = STANDARD.encode(signing_key.sign(&canonical).to_bytes());
    let signed = SignedComponentCatalog { payload, signature };
    let bytes = serde_json::to_vec(&signed).map_err(|error| error.to_string())?;
    let public = signing_key.verifying_key().to_bytes();
    let trust = TrustedKeys::from_public_key_bytes([(signed.payload.key_id.clone(), public)])
        .map_err(|error| error.to_string())?;
    verify_component_catalog(&bytes, &trust, current_time()?, false)
        .map_err(|error| format!("self-verification failed: {error}"))?;
    Ok(bytes)
}

/// Verify a signed catalog using the supplied public key and expected key ID.
pub fn verify_catalog(
    bytes: &[u8],
    public_key: [u8; 32],
    expected_key_id: &str,
    now: i64,
) -> Result<ComponentCatalogInspection, String> {
    reject_duplicate_keys(bytes)
        .map_err(|_| "component catalog contains duplicate JSON keys".to_string())?;
    let signed: SignedComponentCatalog =
        serde_json::from_slice(bytes).map_err(|error| format!("invalid catalog: {error}"))?;
    if signed.payload.key_id != expected_key_id {
        return Err("component catalog keyId does not match the expected keyId".into());
    }
    let trust = TrustedKeys::from_public_key_bytes([(expected_key_id.to_string(), public_key)])
        .map_err(|error| error.to_string())?;
    let verified = verify_component_catalog(bytes, &trust, now, false)
        .map_err(|error| format!("component catalog verification failed: {error}"))?;
    Ok(inspection(&verified.signed))
}

/// Verify against the public trust root embedded in the Core source.
pub fn verify_production_catalog(
    bytes: &[u8],
    now: i64,
) -> Result<ComponentCatalogInspection, String> {
    let trust = crate::components::distribution::production_trust();
    let verified = verify_component_catalog(bytes, &trust, now, false).map_err(|error| {
        format!("production Component Manager catalog verification failed: {error}")
    })?;
    Ok(inspection(&verified.signed))
}

/// Inspect the inline envelope without asserting that its signature is valid.
pub fn inspect_catalog(bytes: &[u8]) -> Result<ComponentCatalogInspection, String> {
    reject_duplicate_keys(bytes)
        .map_err(|_| "component catalog contains duplicate JSON keys".to_string())?;
    let signed: SignedComponentCatalog =
        serde_json::from_slice(bytes).map_err(|error| format!("invalid catalog: {error}"))?;
    Ok(inspection(&signed))
}

fn inspection(signed: &SignedComponentCatalog) -> ComponentCatalogInspection {
    ComponentCatalogInspection {
        schema_version: signed.payload.schema_version,
        catalog_version: signed.payload.catalog_version.clone(),
        sequence: signed.payload.sequence,
        key_id: signed.payload.key_id.clone(),
        issued_at: signed.payload.issued_at,
        expires_at: signed.payload.expires_at,
        component_ids: signed
            .payload
            .components
            .iter()
            .map(|component| match component.id {
                ComponentId::MediaTools => "media-tools".to_string(),
                ComponentId::TorrentEngine => "torrent-engine".to_string(),
            })
            .collect(),
        signature_model: "inline",
    }
}

fn current_time() -> Result<i64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .map_err(|_| "system clock is before Unix epoch".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_duplicate_payload_keys_before_canonicalization() {
        assert!(assemble_payload(br#"{"schemaVersion":1,"schemaVersion":1}"#).is_err());
    }

    #[test]
    fn rejects_noncanonical_or_wrong_length_seed() {
        assert!(decode_seed("AQ==").is_err());
        assert!(decode_seed(&STANDARD.encode([7_u8; 32]).replace('=', "")).is_err());
    }
}
