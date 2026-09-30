use crate::components::{catalog_key, distribution};

pub(crate) const APPLICATION_IDENTIFIER: &str = "lat.cacaplay.cacatools.downloadmanager.qa";
const CATALOG_KEY_FINGERPRINT: &str =
    "7910b5251d799b5160471f860db7de4bd478dea5280e5ebd7a63a1ec2a655313";

pub(crate) fn validate_runtime_configuration(config: &tauri::Config) -> Result<(), String> {
    if config.identifier != APPLICATION_IDENTIFIER {
        return Err("La build de componentes QA requiere su identificador aislado".into());
    }
    if let Some(updater) = config.plugins.0.get("updater") {
        let has_public_key = updater
            .get("pubkey")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|value| !value.is_empty());
        let has_endpoints = updater
            .get("endpoints")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|values| !values.is_empty());
        if has_public_key || has_endpoints {
            return Err("La build QA no puede tener configurado el actualizador".into());
        }
    }
    if catalog_key::KEY_ID != "component-catalog-qa-20260927" {
        return Err("La build de componentes QA requiere su key ID exclusivo".into());
    }
    if distribution::COMPONENT_CATALOG_ENDPOINT
        != "http://127.0.0.1:49301/component-catalog-v1.json"
        || !distribution::ALLOW_LOOPBACK_HTTP
    {
        return Err("La build de componentes QA solo admite el catálogo loopback fijado".into());
    }

    let public_key = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        catalog_key::PUBLIC_KEY_BASE64,
    )
    .map_err(|_| "La clave pública del catálogo QA no es válida".to_string())?;
    if public_key.len() != 32 || distribution::sha256_hex(&public_key) != CATALOG_KEY_FINGERPRINT {
        return Err("La huella de la clave pública del catálogo QA no coincide".into());
    }

    Ok(())
}
