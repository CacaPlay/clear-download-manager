use base64::{engine::general_purpose::STANDARD, Engine as _};
use cacatools_desktop_lib::component_catalog_tooling::{
    assemble_payload, inspect_catalog, sign_payload, verify_catalog, verify_production_catalog,
};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    env, fs,
    io::Write,
    path::Path,
    process::{Command, Stdio},
};
use zeroize::Zeroizing;

const PRODUCTION_SECRET: &str = "RELEASE_COMPONENT_CATALOG_SIGNING_PRIVATE_KEY";
const PRODUCTION_KEY_ID: &str = "component-catalog-2026-01";
const PRODUCTION_REPOSITORY: &str = "CacaPlay/clear-download-manager";
const PUBLIC_KEY_MODULE: &str = "src-tauri/src/components/catalog_key.rs";

#[cfg(windows)]
fn os_random_seed() -> Result<[u8; 32], String> {
    #[link(name = "bcrypt")]
    unsafe extern "system" {
        fn BCryptGenRandom(
            algorithm: *mut std::ffi::c_void,
            buffer: *mut u8,
            buffer_length: u32,
            flags: u32,
        ) -> i32;
    }
    const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 0x0000_0002;
    let mut seed = [0_u8; 32];
    // SAFETY: the buffer is writable for exactly its declared 32-byte length;
    // passing a null algorithm with SYSTEM_PREFERRED_RNG delegates to Windows CNG.
    let status = unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            seed.as_mut_ptr(),
            seed.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status != 0 {
        seed.fill(0);
        return Err("Windows CNG could not provide cryptographic randomness".into());
    }
    Ok(seed)
}

#[cfg(not(windows))]
fn os_random_seed() -> Result<[u8; 32], String> {
    Err("production key provisioning is supported only on Windows in this tool".into())
}

fn usage() -> &'static str {
    "component-catalog-tool <assemble|sign|verify|verify-production|inspect|provision-production-key> [--input PATH] [--output PATH] [--key-file PATH] [--public-key-file PATH] [--key-id ID]"
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

fn decode_public_key(path: &str) -> Result<[u8; 32], String> {
    let encoded = String::from_utf8(read(path)?).map_err(|_| "public key is not UTF-8")?;
    let encoded = encoded.trim();
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| "public key must be canonical base64".to_string())?;
    if bytes.len() != 32 || STANDARD.encode(&bytes) != encoded {
        return Err("public key must be exactly 32 bytes in canonical base64".into());
    }
    bytes
        .try_into()
        .map_err(|_| "public key must be exactly 32 bytes".to_string())
}

fn run_gh(args: &[&str], stdin_value: Option<&str>) -> Result<std::process::Output, String> {
    let mut command = Command::new("gh");
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if stdin_value.is_some() {
        command.stdin(Stdio::piped());
    }
    let mut child = command
        .spawn()
        .map_err(|_| "GitHub CLI could not be started; verify `gh auth status`.".to_string())?;
    if let Some(value) = stdin_value {
        child
            .stdin
            .take()
            .ok_or_else(|| "GitHub CLI secret input pipe is unavailable".to_string())?
            .write_all(value.as_bytes())
            .map_err(|_| "GitHub CLI did not accept secret input".to_string())?;
    }
    child
        .wait_with_output()
        .map_err(|_| "GitHub CLI did not return a result".to_string())
}

fn environment_secret_exists() -> Result<bool, String> {
    let output = run_gh(
        &[
            "secret",
            "list",
            "--env",
            "release",
            "--repo",
            PRODUCTION_REPOSITORY,
        ],
        None,
    )?;
    if !output.status.success() {
        return Err("Could not inspect release environment secret names.".into());
    }
    let names = String::from_utf8_lossy(&output.stdout);
    Ok(names
        .lines()
        .any(|line| line.split_whitespace().next() == Some(PRODUCTION_SECRET)))
}

fn release_environment_writable() -> Result<(), String> {
    let repository = run_gh(&["api", &format!("repos/{PRODUCTION_REPOSITORY}")], None)?;
    if !repository.status.success() {
        return Err(
            "Could not verify repository administration access; no production key was generated"
                .into(),
        );
    }
    let repository: serde_json::Value = serde_json::from_slice(&repository.stdout)
        .map_err(|_| "GitHub repository permission response was invalid".to_string())?;
    if repository
        .pointer("/permissions/admin")
        .and_then(serde_json::Value::as_bool)
        != Some(true)
    {
        return Err(
            "GitHub account is not a repository admin; no production key was generated".into(),
        );
    }
    let environment = run_gh(
        &[
            "api",
            &format!("repos/{PRODUCTION_REPOSITORY}/environments/release"),
        ],
        None,
    )?;
    if !environment.status.success() {
        return Err(
            "Could not verify the release environment; no production key was generated".into(),
        );
    }
    Ok(())
}

fn provision_production_key() -> Result<(), String> {
    let root = env::current_dir().map_err(|_| "cannot inspect current directory".to_string())?;
    if !root.join("package.json").is_file() || !root.join("src-tauri/Cargo.toml").is_file() {
        return Err("run this command from the repository root".into());
    }
    let public_module_path = root.join(PUBLIC_KEY_MODULE);
    let original_module = fs::read_to_string(&public_module_path)
        .map_err(|_| "component public-key module is missing".to_string())?;
    if !original_module.contains("PUBLIC_KEY_BASE64: &str = \"\"") {
        return Err(
            "a Component Manager public key is already provisioned; refusing rotation".into(),
        );
    }
    release_environment_writable()?;
    if environment_secret_exists()? {
        return Err(
            "the release environment secret name already exists; refusing key rotation".into(),
        );
    }

    let seed = Zeroizing::new(os_random_seed()?);
    let signing_key = SigningKey::from_bytes(&seed);
    let challenge = b"Clear Download Manager Component Catalog key-pair check";
    let signature = signing_key.sign(challenge);
    signing_key
        .verifying_key()
        .verify_strict(challenge, &signature)
        .map_err(|_| "generated Component Manager key pair did not verify".to_string())?;
    let private_seed_base64 = Zeroizing::new(STANDARD.encode(*seed));
    let public_key_base64 = STANDARD.encode(signing_key.verifying_key().to_bytes());

    let public_module = format!(
        "//! Public trust anchor for the Component Manager catalog only.\n\
         //! The private seed is stored only in the protected GitHub release environment.\n\n\
         pub(crate) const KEY_ID: &str = \"{PRODUCTION_KEY_ID}\";\n\
         pub(crate) const PUBLIC_KEY_BASE64: &str = \"{public_key_base64}\";\n"
    );
    fs::write(&public_module_path, public_module.as_bytes())
        .map_err(|_| "could not write the public trust anchor".to_string())?;

    let result = run_gh(
        &[
            "secret",
            "set",
            PRODUCTION_SECRET,
            "--env",
            "release",
            "--repo",
            PRODUCTION_REPOSITORY,
            "--body",
            "-",
        ],
        Some(&private_seed_base64),
    );
    // Drop the only application-level copy before inspecting CLI status.
    let output = match result {
        Ok(output) if output.status.success() => output,
        _ => {
            let _ = fs::write(&public_module_path, original_module.as_bytes());
            return Err(
                "GitHub did not confirm storing the release secret; no key was retained locally"
                    .into(),
            );
        }
    };
    drop(output);
    if !environment_secret_exists()? {
        return Err(
            "secret-name verification failed; do not use the generated trust anchor".into(),
        );
    }

    let node = Command::new("node")
        .arg("scripts/generate-source-manifest.mjs")
        .current_dir(&root)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| {
            "public key was stored but MANIFEST.sha256 could not be updated".to_string()
        })?;
    if !node.success() {
        return Err("public key was stored but MANIFEST.sha256 could not be updated".into());
    }
    let fingerprint = Sha256::digest(signing_key.verifying_key().to_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    println!("PASS: production Component Manager key provisioned; keyId={PRODUCTION_KEY_ID}; public-key fingerprint={fingerprint}");
    println!("Secret value printed: NO");
    Ok(())
}

fn run() -> Result<(), String> {
    let (command, values) = options()?;
    if command == "provision-production-key" {
        if !values.is_empty() {
            return Err("provision-production-key accepts no options".into());
        }
        return provision_production_key();
    }
    let input = read(required(&values, "--input")?)?;
    match command.as_str() {
        "assemble" | "generate" => {
            write(required(&values, "--output")?, &assemble_payload(&input)?)
        }
        "sign" => {
            let seed = Zeroizing::new(
                match env::var("RELEASE_COMPONENT_CATALOG_SIGNING_PRIVATE_KEY") {
                    Ok(value) if !value.is_empty() => value,
                    _ => String::from_utf8(read(required(&values, "--key-file")?)?)
                        .map_err(|_| "private seed file is not UTF-8".to_string())?,
                },
            );
            let signed = sign_payload(&input, seed.trim())?;
            write(required(&values, "--output")?, &signed)?;
            if let Some(public_path) = values.get("--public-key-output") {
                let decoded = STANDARD
                    .decode(seed.trim())
                    .map_err(|_| "private seed must be canonical base64".to_string())?;
                let seed_bytes: [u8; 32] = decoded
                    .try_into()
                    .map_err(|_| "private seed must be exactly 32 bytes".to_string())?;
                let public = STANDARD.encode(
                    SigningKey::from_bytes(&seed_bytes)
                        .verifying_key()
                        .to_bytes(),
                );
                write(public_path, public.as_bytes())?;
            }
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({"result":"PASS","signature":"inline"}))
                    .map_err(|error| error.to_string())?
            );
            Ok(())
        }
        "verify" => {
            let public_key = decode_public_key(required(&values, "--public-key-file")?)?;
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| "system clock is before Unix epoch".to_string())?
                .as_secs() as i64;
            let summary = verify_catalog(&input, public_key, required(&values, "--key-id")?, now)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({"verification":"PASS","catalog":summary}))
                    .map_err(|error| error.to_string())?
            );
            Ok(())
        }
        "verify-production" => {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| "system clock is before Unix epoch".to_string())?
                .as_secs() as i64;
            let summary = verify_production_catalog(&input, now)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({"verification":"PASS","catalog":summary}))
                    .map_err(|error| error.to_string())?
            );
            Ok(())
        }
        "inspect" => {
            let summary = inspect_catalog(&input)?;
            println!(
                "{}",
                serde_json::to_string_pretty(
                    &json!({"verification":"NOT_REQUESTED","catalog":summary})
                )
                .map_err(|error| error.to_string())?
            );
            Ok(())
        }
        _ => Err(usage().into()),
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("component-catalog-tool: FAIL: {error}");
        std::process::exit(1);
    }
}
