use base64::{engine::general_purpose::STANDARD, Engine as _};
use cacatools_desktop_lib::catalog_tooling::{
    canonical_catalog_payload_bytes, envelope_with_signature, inspect_catalog_envelope,
    verify_catalog_envelope,
};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::json;
use std::{collections::BTreeMap, env, fs, path::Path};

fn usage() -> &'static str {
    "catalog-signer <validate|canonicalize|sign|verify|inspect> [--input PATH] [--output PATH] [--key-file PATH] [--public-key-file PATH] [--key-id ID] [--canonical-output PATH] [--signature-output PATH] [--public-key-output PATH]"
}

fn options() -> Result<(String, BTreeMap<String, String>), String> {
    let mut args = env::args().skip(1);
    let command = args.next().ok_or_else(|| usage().to_string())?;
    let mut values = BTreeMap::new();
    while let Some(name) = args.next() {
        if !name.starts_with("--") {
            return Err(format!("unexpected argument: {name}"));
        }
        let value = args
            .next()
            .ok_or_else(|| format!("missing value for {name}"))?;
        if values.insert(name.clone(), value).is_some() {
            return Err(format!("duplicate option: {name}"));
        }
    }
    Ok((command, values))
}

fn required<'a>(values: &'a BTreeMap<String, String>, name: &str) -> Result<&'a str, String> {
    values
        .get(name)
        .map(String::as_str)
        .ok_or_else(|| format!("missing required option: {name}"))
}

fn read(path: &str) -> Result<Vec<u8>, String> {
    fs::read(path).map_err(|error| format!("cannot read {}: {error}", Path::new(path).display()))
}

fn write(path: &str, bytes: &[u8]) -> Result<(), String> {
    fs::write(path, bytes)
        .map_err(|error| format!("cannot write {}: {error}", Path::new(path).display()))
}

fn decode_32(path: &str, label: &str) -> Result<[u8; 32], String> {
    let encoded = String::from_utf8(read(path)?).map_err(|_| format!("{label} is not UTF-8"))?;
    let encoded = encoded.trim();
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| format!("{label} is not canonical base64"))?;
    if bytes.len() != 32 || STANDARD.encode(&bytes) != encoded {
        return Err(format!(
            "{label} must be exactly 32 bytes in canonical base64"
        ));
    }
    bytes
        .try_into()
        .map_err(|_| format!("{label} must be exactly 32 bytes"))
}

fn print_inspection(status: &str, inspection: impl serde::Serialize) -> Result<(), String> {
    let mut value = serde_json::to_value(inspection).map_err(|error| error.to_string())?;
    value["verification"] = json!(status);
    println!(
        "{}",
        serde_json::to_string_pretty(&value).map_err(|error| error.to_string())?
    );
    Ok(())
}

fn run() -> Result<(), String> {
    let (command, values) = options()?;
    let input = || required(&values, "--input").and_then(read);
    match command.as_str() {
        "validate" | "inspect" => {
            let bytes = input()?;
            print_inspection("NOT_REQUESTED", inspect_catalog_envelope(&bytes)?)
        }
        "canonicalize" => {
            let bytes = input()?;
            let canonical = canonical_catalog_payload_bytes(&bytes)?;
            write(required(&values, "--output")?, &canonical)
        }
        "sign" => {
            let bytes = input()?;
            let seed = decode_32(required(&values, "--key-file")?, "private key file")?;
            let signing_key = SigningKey::from_bytes(&seed);
            let canonical = canonical_catalog_payload_bytes(&bytes)?;
            let signature = STANDARD.encode(signing_key.sign(&canonical).to_bytes());
            let signed = envelope_with_signature(&bytes, &signature)?;
            let key_id = inspect_catalog_envelope(&signed)?.key_id;
            verify_catalog_envelope(&signed, &key_id, signing_key.verifying_key().to_bytes())?;
            write(required(&values, "--output")?, &signed)?;
            if let Some(path) = values.get("--canonical-output") {
                write(path, &canonical)?;
            }
            if let Some(path) = values.get("--signature-output") {
                write(path, signature.as_bytes())?;
            }
            if let Some(path) = values.get("--public-key-output") {
                write(
                    path,
                    STANDARD
                        .encode(signing_key.verifying_key().to_bytes())
                        .as_bytes(),
                )?;
            }
            print_inspection("PASS", inspect_catalog_envelope(&signed)?)
        }
        "verify" => {
            let bytes = input()?;
            let public_key = decode_32(required(&values, "--public-key-file")?, "public key file")?;
            let result =
                verify_catalog_envelope(&bytes, required(&values, "--key-id")?, public_key)?;
            print_inspection("PASS", result)
        }
        _ => Err(usage().into()),
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("catalog-signer: FAIL: {error}");
        std::process::exit(1);
    }
}
