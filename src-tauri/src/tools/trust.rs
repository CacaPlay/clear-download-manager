use base64::{engine::general_purpose::STANDARD, Engine as _};
use ed25519_dalek::{Signature, VerifyingKey};
use std::fmt;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum TrustError {
    UnknownKeyId(String),
    InvalidPublicKey(String),
    InvalidSignatureEncoding,
    InvalidSignature,
}

impl fmt::Display for TrustError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownKeyId(key_id) => write!(formatter, "unknown keyId: {key_id}"),
            Self::InvalidPublicKey(key_id) => {
                write!(formatter, "invalid public key for keyId: {key_id}")
            }
            Self::InvalidSignatureEncoding => {
                formatter.write_str("invalid Ed25519 signature encoding")
            }
            Self::InvalidSignature => formatter.write_str("Ed25519 signature verification failed"),
        }
    }
}

impl std::error::Error for TrustError {}

#[derive(Clone)]
struct TrustedKey {
    key_id: String,
    verifying_key: VerifyingKey,
}

#[derive(Clone, Default)]
pub(crate) struct TrustedKeys {
    keys: Vec<TrustedKey>,
}

impl TrustedKeys {
    pub(crate) fn empty() -> Self {
        Self::default()
    }

    pub(crate) fn from_public_key_bytes<I>(entries: I) -> Result<Self, TrustError>
    where
        I: IntoIterator<Item = (String, [u8; 32])>,
    {
        let mut keys = Vec::new();
        for (key_id, bytes) in entries {
            let verifying_key = VerifyingKey::from_bytes(&bytes)
                .map_err(|_| TrustError::InvalidPublicKey(key_id.clone()))?;
            if keys.iter().any(|entry: &TrustedKey| entry.key_id == key_id) {
                return Err(TrustError::InvalidPublicKey(key_id));
            }
            keys.push(TrustedKey {
                key_id,
                verifying_key,
            });
        }
        Ok(Self { keys })
    }

    pub(crate) fn production() -> Self {
        // Phase 2B deliberately ships no production root. A future signed app
        // release must add the public key here; manifests cannot add roots.
        Self::empty()
    }

    pub(crate) fn key_ids(&self) -> impl Iterator<Item = &str> {
        self.keys.iter().map(|entry| entry.key_id.as_str())
    }

    pub(crate) fn verify(
        &self,
        key_id: &str,
        signed_bytes: &[u8],
        signature_base64: &str,
    ) -> Result<(), TrustError> {
        let key = self
            .keys
            .iter()
            .find(|entry| entry.key_id == key_id)
            .ok_or_else(|| TrustError::UnknownKeyId(key_id.to_string()))?;
        let signature_bytes = STANDARD
            .decode(signature_base64)
            .map_err(|_| TrustError::InvalidSignatureEncoding)?;
        if signature_bytes.len() != 64 || STANDARD.encode(&signature_bytes) != signature_base64 {
            return Err(TrustError::InvalidSignatureEncoding);
        }
        let signature = Signature::from_slice(&signature_bytes)
            .map_err(|_| TrustError::InvalidSignatureEncoding)?;
        key.verifying_key
            .verify_strict(signed_bytes, &signature)
            .map_err(|_| TrustError::InvalidSignature)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    const TEST_ONLY_SEED: [u8; 32] = [
        0x42, 0x19, 0x07, 0x2a, 0x5c, 0x9e, 0x11, 0xd3, 0x84, 0x20, 0x71, 0xa6, 0x0f, 0xc8, 0x33,
        0x95, 0x67, 0x14, 0xe2, 0x4b, 0x8a, 0x55, 0x09, 0xbd, 0x73, 0x2c, 0xf1, 0x68, 0x0a, 0x44,
        0x97, 0x5e,
    ];

    #[test]
    fn production_trust_root_is_empty_until_a_future_app_release_adds_one() {
        assert_eq!(TrustedKeys::production().key_ids().count(), 0);
    }

    #[test]
    fn known_test_key_verifies_and_unknown_key_is_rejected() {
        let signing_key = SigningKey::from_bytes(&TEST_ONLY_SEED);
        let trust = TrustedKeys::from_public_key_bytes(vec![(
            "test-only-2026".to_string(),
            signing_key.verifying_key().to_bytes(),
        )])
        .expect("test key");
        let message = b"test-only manifest bytes";
        let signature = STANDARD.encode(signing_key.sign(message).to_bytes());
        assert!(trust.verify("test-only-2026", message, &signature).is_ok());
        assert!(matches!(
            trust.verify("unknown", message, &signature),
            Err(TrustError::UnknownKeyId(_))
        ));
        assert!(matches!(
            trust.verify("test-only-2026", message, "AAAA"),
            Err(TrustError::InvalidSignatureEncoding)
        ));
    }
}
