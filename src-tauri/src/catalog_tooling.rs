//! Shared, offline catalog-format boundary used by the runtime verifier and
//! feature-gated maintainer command-line tools.
//!
//! Schema v1 signs the exact UTF-8 bytes returned by
//! `canonical_catalog_payload_bytes`: compact JSON, deterministic struct field
//! order, no BOM, no trailing newline, and no `signature` field.

use crate::tools::{
    catalog::{
        canonical_catalog_payload_bytes as runtime_canonical_bytes, ToolCatalogEnvelope,
        CATALOG_SCHEMA_VERSION,
    },
    manifest::reject_duplicate_keys,
    trust::TrustedKeys,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogInspection {
    pub schema_version: u32,
    pub key_id: String,
    pub sequence: u64,
    pub manifest_id: String,
    pub canonical_sha256: String,
}

fn parse_envelope(bytes: &[u8]) -> Result<ToolCatalogEnvelope, String> {
    reject_duplicate_keys(bytes).map_err(|error| error.to_string())?;
    let envelope: ToolCatalogEnvelope =
        serde_json::from_slice(bytes).map_err(|_| "catalog schema is invalid".to_string())?;
    if envelope.schema_version != CATALOG_SCHEMA_VERSION
        || envelope.key_id != envelope.manifest.key_id
    {
        return Err("catalog schema is invalid".into());
    }
    Ok(envelope)
}

fn inspection(envelope: &ToolCatalogEnvelope, canonical: &[u8]) -> CatalogInspection {
    CatalogInspection {
        schema_version: envelope.schema_version,
        key_id: envelope.key_id.clone(),
        sequence: envelope.sequence,
        manifest_id: envelope.manifest.manifest_id.clone(),
        canonical_sha256: format!("{:x}", Sha256::digest(canonical)),
    }
}

/// Validates an envelope and returns the single schema-v1 byte sequence that
/// must be signed. The signature field is deliberately excluded.
pub fn canonical_catalog_payload_bytes(envelope_json: &[u8]) -> Result<Vec<u8>, String> {
    let envelope = parse_envelope(envelope_json)?;
    runtime_canonical_bytes(&envelope).map_err(|error| error.to_string())
}

/// Validates an envelope and returns non-secret identifying metadata.
pub fn inspect_catalog_envelope(envelope_json: &[u8]) -> Result<CatalogInspection, String> {
    let envelope = parse_envelope(envelope_json)?;
    let canonical = runtime_canonical_bytes(&envelope).map_err(|error| error.to_string())?;
    Ok(inspection(&envelope, &canonical))
}

/// Replaces the signature with one canonical base64-encoded Ed25519 signature.
pub fn envelope_with_signature(
    envelope_json: &[u8],
    signature_base64: &str,
) -> Result<Vec<u8>, String> {
    let mut envelope = parse_envelope(envelope_json)?;
    let signature = STANDARD
        .decode(signature_base64)
        .map_err(|_| "invalid Ed25519 signature encoding".to_string())?;
    if signature.len() != 64 || STANDARD.encode(&signature) != signature_base64 {
        return Err("invalid Ed25519 signature encoding".into());
    }
    envelope.signature = signature_base64.to_string();
    serde_json::to_vec(&envelope).map_err(|_| "catalog schema is invalid".to_string())
}

/// Verifies an envelope with a caller-supplied public key. This tooling
/// boundary never reads or modifies the production trust root.
pub fn verify_catalog_envelope(
    envelope_json: &[u8],
    expected_key_id: &str,
    public_key: [u8; 32],
) -> Result<CatalogInspection, String> {
    let envelope = parse_envelope(envelope_json)?;
    if envelope.key_id != expected_key_id {
        return Err(format!("unknown keyId: {}", envelope.key_id));
    }
    let canonical = runtime_canonical_bytes(&envelope).map_err(|error| error.to_string())?;
    let trust = TrustedKeys::from_public_key_bytes([(expected_key_id.to_string(), public_key)])
        .map_err(|error| error.to_string())?;
    trust
        .verify(expected_key_id, &canonical, &envelope.signature)
        .map_err(|error| error.to_string())?;
    Ok(inspection(&envelope, &canonical))
}

#[cfg(test)]
mod tests {
    use super::*;

    const VECTOR_ROOT: &str = "tools/catalog-test-vectors/v1";

    fn vector(path: &str) -> Vec<u8> {
        std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join(VECTOR_ROOT)
                .join(path),
        )
        .expect("golden vector file")
    }

    fn public_key() -> [u8; 32] {
        let encoded = String::from_utf8(vector("test-public-key.base64")).expect("UTF-8 key");
        let bytes = STANDARD.decode(encoded.trim()).expect("base64 public key");
        bytes.try_into().expect("32-byte public key")
    }

    #[test]
    fn golden_vector_freezes_exact_canonical_bytes_hash_and_signature() {
        let envelope = vector("envelope.json");
        let canonical = canonical_catalog_payload_bytes(&envelope).expect("canonical payload");
        assert_eq!(canonical, vector("payload.canonical.json"));
        let expected_hash =
            String::from_utf8(vector("payload.canonical.sha256")).expect("UTF-8 hash");
        assert_eq!(
            format!("{:x}", Sha256::digest(&canonical)),
            expected_hash.trim()
        );
        let verified = verify_catalog_envelope(&envelope, "test-only-catalog-v1", public_key())
            .expect("golden signature");
        assert_eq!(verified.canonical_sha256, expected_hash.trim());
        let envelope_value: serde_json::Value =
            serde_json::from_slice(&envelope).expect("golden envelope JSON");
        let signature = String::from_utf8(vector("signature.base64")).expect("UTF-8 signature");
        assert_eq!(envelope_value["signature"], signature.trim());
        let mut actual = serde_json::to_value(verified).expect("inspection JSON");
        actual["verification"] = serde_json::json!("PASS");
        let expected: serde_json::Value =
            serde_json::from_slice(&vector("expected-verification.json"))
                .expect("expected verification JSON");
        assert_eq!(actual, expected);
    }

    #[test]
    fn golden_vector_rejects_payload_sequence_signature_and_unknown_key_tampering() {
        let envelope = vector("envelope.json");
        let key = public_key();

        let mut byte_tamper = envelope.clone();
        let offset = byte_tamper
            .windows(b"golden".len())
            .position(|window| window == b"golden")
            .expect("manifest marker");
        byte_tamper[offset] = b'G';
        assert!(verify_catalog_envelope(&byte_tamper, "test-only-catalog-v1", key).is_err());

        let mut sequence: serde_json::Value = serde_json::from_slice(&envelope).expect("JSON");
        sequence["sequence"] = serde_json::json!(43);
        assert!(verify_catalog_envelope(
            &serde_json::to_vec(&sequence).expect("JSON bytes"),
            "test-only-catalog-v1",
            key,
        )
        .is_err());

        let mut signature: serde_json::Value = serde_json::from_slice(&envelope).expect("JSON");
        signature["signature"] = serde_json::json!(STANDARD.encode([0_u8; 64]));
        assert!(verify_catalog_envelope(
            &serde_json::to_vec(&signature).expect("JSON bytes"),
            "test-only-catalog-v1",
            key,
        )
        .is_err());
        assert!(verify_catalog_envelope(&envelope, "unknown-test-key", key).is_err());
    }

    #[test]
    fn duplicate_and_invalid_schema_remain_rejected() {
        assert!(
            canonical_catalog_payload_bytes(br#"{"schemaVersion":1,"schemaVersion":1}"#).is_err()
        );
        let mut envelope: serde_json::Value =
            serde_json::from_slice(&vector("envelope.json")).expect("JSON");
        envelope["schemaVersion"] = serde_json::json!(2);
        assert!(canonical_catalog_payload_bytes(
            &serde_json::to_vec(&envelope).expect("JSON bytes")
        )
        .is_err());
    }
}
