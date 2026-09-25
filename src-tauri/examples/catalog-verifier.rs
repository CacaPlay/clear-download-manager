use base64::{engine::general_purpose::STANDARD, Engine as _};
use cacatools_desktop_lib::catalog_tooling::{inspect_catalog_envelope, verify_catalog_envelope};
use serde_json::json;
use std::{env, fs};

fn decode_public_key(path: &str) -> Result<[u8; 32], String> {
    let encoded = fs::read_to_string(path).map_err(|error| format!("cannot read key: {error}"))?;
    let encoded = encoded.trim();
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| "public key is not canonical base64".to_string())?;
    if bytes.len() != 32 || STANDARD.encode(&bytes) != encoded {
        return Err("public key must be exactly 32 bytes in canonical base64".into());
    }
    bytes
        .try_into()
        .map_err(|_| "public key must be exactly 32 bytes".to_string())
}

fn value(args: &[String], name: &str) -> Result<String, String> {
    let index = args
        .iter()
        .position(|value| value == name)
        .ok_or_else(|| format!("missing required option: {name}"))?;
    args.get(index + 1)
        .cloned()
        .ok_or_else(|| format!("missing value for {name}"))
}

fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().skip(1).collect();
    let command = args.first().ok_or_else(|| {
        "catalog-verifier <verify|inspect> --input PATH [--public-key-file PATH --key-id ID]"
            .to_string()
    })?;
    let envelope = fs::read(value(&args, "--input")?)
        .map_err(|error| format!("cannot read envelope: {error}"))?;
    let inspection = match command.as_str() {
        "inspect" => inspect_catalog_envelope(&envelope)?,
        "verify" => verify_catalog_envelope(
            &envelope,
            &value(&args, "--key-id")?,
            decode_public_key(&value(&args, "--public-key-file")?)?,
        )?,
        _ => return Err("expected verify or inspect".into()),
    };
    let mut output = serde_json::to_value(inspection).map_err(|error| error.to_string())?;
    output["verification"] = json!(if command == "verify" {
        "PASS"
    } else {
        "NOT_REQUESTED"
    });
    println!(
        "{}",
        serde_json::to_string_pretty(&output).map_err(|error| error.to_string())?
    );
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("catalog-verifier: FAIL: {error}");
        std::process::exit(1);
    }
}
