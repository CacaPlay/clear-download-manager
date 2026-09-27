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
    path::{Path, PathBuf},
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
    command.args(args);
    if stdin_value.is_some() {
        // Secret writes never capture stdout/stderr, so a CLI diagnostic cannot
        // accidentally echo the secret into this process's output buffers.
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
    } else {
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
    }
    let mut child = command
        .spawn()
        .map_err(|_| "GitHub CLI could not be started; verify `gh auth status`.".to_string())?;
    if let Some(value) = stdin_value {
        let Some(mut stdin) = child.stdin.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err("GitHub CLI secret input pipe is unavailable".into());
        };
        let write_result = stdin.write_all(value.as_bytes());
        drop(stdin); // EOF is required for gh to finish reading the secret.
        if write_result.is_err() {
            let _ = child.kill();
            let _ = child.wait();
            return Err("GitHub CLI did not accept secret input".into());
        }
    }
    child
        .wait_with_output()
        .map_err(|_| "GitHub CLI did not return a result".to_string())
}

fn production_secret_args() -> [&'static str; 7] {
    [
        "secret",
        "set",
        PRODUCTION_SECRET,
        "--env",
        "release",
        "--repo",
        PRODUCTION_REPOSITORY,
    ]
}

struct LocalTrustBackup {
    public_module_path: PathBuf,
    manifest_path: PathBuf,
    original_public_module: Vec<u8>,
    original_manifest: Vec<u8>,
}

impl LocalTrustBackup {
    fn capture(root: &Path) -> Result<Self, String> {
        let public_module_path = root.join(PUBLIC_KEY_MODULE);
        let manifest_path = root.join("MANIFEST.sha256");
        Ok(Self {
            original_public_module: fs::read(&public_module_path)
                .map_err(|_| "component public-key module could not be backed up".to_string())?,
            original_manifest: fs::read(&manifest_path)
                .map_err(|_| "source manifest could not be backed up".to_string())?,
            public_module_path,
            manifest_path,
        })
    }

    fn restore(&self) -> Result<(), String> {
        let mut failures = Vec::new();
        if fs::write(&self.public_module_path, &self.original_public_module).is_err() {
            failures.push("component public-key module");
        }
        if fs::write(&self.manifest_path, &self.original_manifest).is_err() {
            failures.push("source manifest");
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(format!("could not restore {}", failures.join(" and ")))
        }
    }
}

fn manifest_command(root: &Path, verify_only: bool) -> Result<(), String> {
    let mut command = Command::new("node");
    command
        .arg("scripts/generate-source-manifest.mjs")
        .current_dir(root)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if verify_only {
        command.arg("--check");
    }
    let status = command
        .status()
        .map_err(|_| "Node could not validate the source manifest".to_string())?;
    if !status.success() {
        return Err("source manifest generation or validation failed".into());
    }
    Ok(())
}

fn restore_after_failure(backup: &LocalTrustBackup, reason: String) -> String {
    match backup.restore() {
        Ok(()) => reason,
        Err(rollback) => format!("{reason}; local rollback also failed: {rollback}"),
    }
}

fn provision_production_key_with<E, S, G, M, V, P>(
    root: &Path,
    check_environment: E,
    secret_exists: S,
    generate_seed: G,
    regenerate_manifest: M,
    validate_manifest: V,
    store_secret: P,
) -> Result<String, String>
where
    E: FnOnce() -> Result<(), String>,
    S: FnOnce() -> Result<bool, String>,
    G: FnOnce() -> Result<[u8; 32], String>,
    M: FnOnce(&Path) -> Result<(), String>,
    V: FnOnce(&Path) -> Result<(), String>,
    P: FnOnce(&[&str], Option<&str>) -> Result<(), String>,
{
    if !root.join("package.json").is_file() || !root.join("src-tauri/Cargo.toml").is_file() {
        return Err("run this command from the repository root".into());
    }
    let public_module_path = root.join(PUBLIC_KEY_MODULE);
    let existing_module = fs::read_to_string(&public_module_path)
        .map_err(|_| "component public-key module is missing".to_string())?;
    if !existing_module.contains("PUBLIC_KEY_BASE64: &str = \"\"") {
        return Err(
            "a Component Manager public key is already provisioned; refusing rotation".into(),
        );
    }

    // All remote preflight checks happen before entropy is requested.
    check_environment()?;
    if secret_exists()? {
        return Err(
            "the release environment secret name already exists; refusing key rotation".into(),
        );
    }

    let seed = Zeroizing::new(generate_seed()?);
    let signing_key = SigningKey::from_bytes(&seed);
    let challenge = b"Clear Download Manager Component Catalog key-pair check";
    let signature = signing_key.sign(challenge);
    signing_key
        .verifying_key()
        .verify_strict(challenge, &signature)
        .map_err(|_| "generated Component Manager key pair did not verify".to_string())?;
    let public_key = signing_key.verifying_key().to_bytes();
    let fingerprint = Sha256::digest(public_key)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let private_seed_base64 = Zeroizing::new(STANDARD.encode(&seed[..]));
    let public_key_base64 = STANDARD.encode(public_key);
    let public_module = format!(
        "//! Public trust anchor for the Component Manager catalog only.\n\
         //! The private seed is stored only in the protected GitHub release environment.\n\n\
         pub(crate) const KEY_ID: &str = \"{PRODUCTION_KEY_ID}\";\n\
         pub(crate) const PUBLIC_KEY_BASE64: &str = \"{public_key_base64}\";\n"
    );

    // Both local files are snapshotted before the first write.
    let backup = LocalTrustBackup::capture(root)?;
    let local_prepare = (|| {
        fs::write(&backup.public_module_path, public_module.as_bytes())
            .map_err(|_| "could not write the public trust anchor".to_string())?;
        regenerate_manifest(root)?;
        let written_module = fs::read(&backup.public_module_path)
            .map_err(|_| "could not read back the public trust anchor".to_string())?;
        if written_module != public_module.as_bytes() {
            return Err("public trust anchor read-back did not match".into());
        }
        if !backup.manifest_path.is_file() {
            return Err("source manifest is missing after generation".into());
        }
        validate_manifest(root)
    })();
    if let Err(error) = local_prepare {
        drop(private_seed_base64);
        drop(signing_key);
        drop(seed);
        return Err(restore_after_failure(&backup, error));
    }

    // This is the final fallible operation. The private value is supplied only
    // through stdin; the secret name and all other arguments are non-secret.
    let args = production_secret_args();
    let stored = store_secret(&args, Some(&private_seed_base64));
    drop(private_seed_base64);
    drop(signing_key); // ed25519-dalek's `zeroize` feature clears the signing key on drop.
    drop(seed);
    if let Err(error) = stored {
        return Err(restore_after_failure(&backup, error));
    }

    // No verification, file write, manifest operation, or other fallible local
    // operation follows confirmed `gh secret set` success.
    Ok(fingerprint)
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
    let fingerprint = provision_production_key_with(
        &root,
        release_environment_writable,
        environment_secret_exists,
        os_random_seed,
        |path| manifest_command(path, false),
        |path| manifest_command(path, true),
        |args, stdin_value| {
            let Some(secret) = stdin_value else {
                return Err("GitHub secret input was not configured".into());
            };
            let result = run_gh(args, Some(secret)).map_err(|_| {
                "GitHub secret write did not complete; local rollback was attempted. The remote outcome may be ambiguous, so inspect the secret name before retrying; provisioning refuses an existing name.".to_string()
            })?;
            if result.status.success() {
                Ok(())
            } else {
                Err("GitHub did not confirm storing the release secret; local rollback was attempted. The remote outcome may be ambiguous, so inspect the secret name before retrying; provisioning refuses an existing name.".into())
            }
        },
    )?;
    // Fingerprint is public and computed before remote storage; success is the
    // process exit code, so there are no fallible output writes after provisioning.
    drop(fingerprint);
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        cell::{Cell, RefCell},
        fs,
    };
    use tempfile::TempDir;

    fn fixture(public_key: &str) -> TempDir {
        let temp = tempfile::tempdir().expect("create fixture directory");
        let root = temp.path();
        fs::create_dir_all(root.join("src-tauri/src/components")).expect("create source tree");
        fs::create_dir_all(root.join("src-tauri/src/tools")).expect("create tool source tree");
        fs::write(root.join("package.json"), "{}\n").expect("write package marker");
        fs::write(root.join("src-tauri/Cargo.toml"), "[package]\n").expect("write Cargo marker");
        fs::write(
            root.join(PUBLIC_KEY_MODULE),
            format!(
                "pub(crate) const KEY_ID: &str = \"{PRODUCTION_KEY_ID}\";\n\
                 pub(crate) const PUBLIC_KEY_BASE64: &str = \"{public_key}\";\n"
            ),
        )
        .expect("write initial public key module");
        fs::write(root.join("MANIFEST.sha256"), "original manifest\n")
            .expect("write original manifest");
        fs::write(
            root.join("src-tauri/src/tools/trust.rs"),
            "tool trust sentinel\n",
        )
        .expect("write Tool Catalog trust sentinel");
        temp
    }

    fn no_manifest_work(_: &Path) -> Result<(), String> {
        Ok(())
    }

    #[test]
    fn existing_secret_aborts_before_generating_entropy() {
        let temp = fixture("");
        let generated = Cell::new(false);
        let result = provision_production_key_with(
            temp.path(),
            || Ok(()),
            || Ok(true),
            || {
                generated.set(true);
                Ok([0x51; 32])
            },
            no_manifest_work,
            no_manifest_work,
            |_, _| panic!("secret storage must not run"),
        );
        assert!(result.unwrap_err().contains("already exists"));
        assert!(!generated.get());
    }

    #[test]
    fn existing_public_key_refuses_rotation_before_generating_entropy() {
        let temp = fixture("already-provisioned-public-key");
        let generated = Cell::new(false);
        let result = provision_production_key_with(
            temp.path(),
            || Ok(()),
            || panic!("secret inventory must not be queried after a public key exists"),
            || {
                generated.set(true);
                Ok([0x52; 32])
            },
            no_manifest_work,
            no_manifest_work,
            |_, _| panic!("secret storage must not run"),
        );
        assert!(result.unwrap_err().contains("refusing rotation"));
        assert!(!generated.get());
    }

    #[test]
    fn secret_request_uses_stdin_and_never_puts_value_in_argv() {
        let args = production_secret_args();
        assert!(!args.contains(&"--body"));
        assert!(args.contains(&PRODUCTION_SECRET));

        let temp = fixture("");
        let mut observed_args = Vec::new();
        let mut observed_stdin = None;
        let observed_events = RefCell::new(Vec::new());
        let result = provision_production_key_with(
            temp.path(),
            || Ok(()),
            || Ok(false),
            || Ok([0x53; 32]),
            |root| {
                observed_events.borrow_mut().push("manifest-generation");
                fs::write(root.join("MANIFEST.sha256"), "updated manifest\n")
                    .map_err(|error| error.to_string())
            },
            |root| {
                observed_events.borrow_mut().push("manifest-validation");
                if fs::read(root.join("MANIFEST.sha256")).map_err(|error| error.to_string())?
                    != b"updated manifest\n"
                {
                    return Err("manifest validation failed".into());
                }
                Ok(())
            },
            |request_args, stdin| {
                observed_events.borrow_mut().push("secret-store");
                observed_args = request_args.iter().map(|arg| (*arg).to_string()).collect();
                observed_stdin = stdin.map(str::to_string);
                Ok(())
            },
        );
        assert!(result.is_ok());
        assert_eq!(observed_args, args.map(str::to_string).to_vec());
        assert!(!observed_args.iter().any(|arg| arg == "--body"));
        let received = observed_stdin.expect("secret must use stdin");
        assert!(!observed_args.iter().any(|arg| arg == &received));
        assert_eq!(
            *observed_events.borrow(),
            ["manifest-generation", "manifest-validation", "secret-store"]
        );
        assert!(!fs::read_to_string(temp.path().join(PUBLIC_KEY_MODULE))
            .unwrap()
            .contains("PUBLIC_KEY_BASE64: &str = \"\""));
        assert_eq!(
            fs::read_to_string(temp.path().join("src-tauri/src/tools/trust.rs")).unwrap(),
            "tool trust sentinel\n"
        );
    }

    #[test]
    fn local_preparation_failure_restores_both_files_before_secret_store() {
        let temp = fixture("");
        let original_module = fs::read(temp.path().join(PUBLIC_KEY_MODULE)).unwrap();
        let original_manifest = fs::read(temp.path().join("MANIFEST.sha256")).unwrap();
        let result = provision_production_key_with(
            temp.path(),
            || Ok(()),
            || Ok(false),
            || Ok([0x54; 32]),
            |_| Err("simulated manifest generation failure".into()),
            no_manifest_work,
            |_, _| panic!("secret storage must not run after local failure"),
        );
        assert!(result
            .unwrap_err()
            .contains("simulated manifest generation failure"));
        assert_eq!(
            fs::read(temp.path().join(PUBLIC_KEY_MODULE)).unwrap(),
            original_module
        );
        assert_eq!(
            fs::read(temp.path().join("MANIFEST.sha256")).unwrap(),
            original_manifest
        );
    }

    #[test]
    fn secret_store_failure_restores_public_key_and_manifest() {
        let temp = fixture("");
        let original_module = fs::read(temp.path().join(PUBLIC_KEY_MODULE)).unwrap();
        let original_manifest = fs::read(temp.path().join("MANIFEST.sha256")).unwrap();
        let result = provision_production_key_with(
            temp.path(),
            || Ok(()),
            || Ok(false),
            || Ok([0x55; 32]),
            |root| {
                fs::write(root.join("MANIFEST.sha256"), "updated manifest\n")
                    .map_err(|error| error.to_string())
            },
            |root| {
                if fs::read(root.join("MANIFEST.sha256")).map_err(|error| error.to_string())?
                    != b"updated manifest\n"
                {
                    return Err("manifest validation failed".into());
                }
                Ok(())
            },
            |_, stdin| {
                assert!(stdin.is_some());
                Err("simulated gh secret set failure".into())
            },
        );
        assert!(result
            .unwrap_err()
            .contains("simulated gh secret set failure"));
        assert_eq!(
            fs::read(temp.path().join(PUBLIC_KEY_MODULE)).unwrap(),
            original_module
        );
        assert_eq!(
            fs::read(temp.path().join("MANIFEST.sha256")).unwrap(),
            original_manifest
        );
    }
}
