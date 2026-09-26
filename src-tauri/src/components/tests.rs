use super::*;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};
#[cfg(windows)]
use std::{
    io::Read,
    net::TcpListener,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};
use tempfile::tempdir;
use zip::{write::SimpleFileOptions, ZipWriter};

fn fixture_pins() -> RuntimePins {
    RuntimePins::from_test_files([
        (
            RuntimeArtifact::YtDlp,
            "yt-dlp.exe",
            "2026.08.19",
            b"trusted yt-dlp".as_slice(),
        ),
        (
            RuntimeArtifact::Ffmpeg,
            "ffmpeg.exe",
            "9.0.2",
            b"trusted ffmpeg".as_slice(),
        ),
        (
            RuntimeArtifact::Ffprobe,
            "ffprobe.exe",
            "9.0.2",
            b"trusted ffprobe".as_slice(),
        ),
        (
            RuntimeArtifact::Deno,
            "deno.exe",
            "2.9.7",
            b"trusted deno".as_slice(),
        ),
        (
            RuntimeArtifact::Aria2,
            "aria2c.exe",
            "1.37.0",
            b"trusted aria2".as_slice(),
        ),
    ])
}

fn package_manifest(
    id: ComponentId,
    version: &str,
    pins: &RuntimePins,
) -> ComponentPackageManifest {
    ComponentPackageManifest {
        schema_version: COMPONENT_SCHEMA_VERSION,
        id,
        version: version.to_string(),
        capabilities: id.capabilities().to_vec(),
        dependencies: Vec::new(),
        files: pins.files_for(id),
    }
}

fn write_package(path: &Path, manifest: &ComponentPackageManifest, overrides: &[(&str, &[u8])]) {
    let file = fs::File::create(path).expect("create package fixture");
    let mut archive = ZipWriter::new(file);
    let options = SimpleFileOptions::default();
    archive
        .start_file("component.json", options)
        .expect("start manifest entry");
    archive
        .write_all(&serde_json::to_vec(manifest).expect("serialize manifest"))
        .expect("write manifest");
    for file in &manifest.files {
        let bytes = overrides
            .iter()
            .find(|(name, _)| *name == file.name)
            .map(|(_, bytes)| *bytes)
            .unwrap_or_else(|| fixture_bytes(&file.name));
        archive
            .start_file(&file.name, options)
            .expect("start binary entry");
        archive.write_all(bytes).expect("write binary fixture");
    }
    archive.finish().expect("finish package fixture");
}

fn fixture_bytes(name: &str) -> &'static [u8] {
    match name {
        "yt-dlp.exe" => b"trusted yt-dlp",
        "ffmpeg.exe" => b"trusted ffmpeg",
        "ffprobe.exe" => b"trusted ffprobe",
        "deno.exe" => b"trusted deno",
        "aria2c.exe" => b"trusted aria2",
        _ => panic!("unexpected fixture file: {name}"),
    }
}

#[cfg(windows)]
fn assert_runtime_version(path: &Path, argument: &str, expected: &str) {
    let output = Command::new(path)
        .arg(argument)
        .output()
        .expect("launch installed runtime");
    assert!(
        output.status.success(),
        "{} --version failed: {}",
        path.display(),
        String::from_utf8_lossy(&output.stderr)
    );
    let version = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        version.contains(expected),
        "{} did not report {expected}: {version}",
        path.display()
    );
}

#[cfg(windows)]
fn write_test_wav(path: &Path) {
    let sample_rate = 8_000_u32;
    let data_size = 1_600_u32;
    let mut bytes = Vec::with_capacity(44 + data_size as usize);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data_size).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16_u32.to_le_bytes());
    bytes.extend_from_slice(&1_u16.to_le_bytes());
    bytes.extend_from_slice(&1_u16.to_le_bytes());
    bytes.extend_from_slice(&sample_rate.to_le_bytes());
    bytes.extend_from_slice(&(sample_rate * 2).to_le_bytes());
    bytes.extend_from_slice(&2_u16.to_le_bytes());
    bytes.extend_from_slice(&16_u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_size.to_le_bytes());
    bytes.resize(44 + data_size as usize, 0);
    fs::write(path, bytes).expect("write tiny local WAV fixture");
}

#[cfg(windows)]
fn bencode_string(output: &mut Vec<u8>, value: &[u8]) {
    output.extend_from_slice(format!("{}:", value.len()).as_bytes());
    output.extend_from_slice(value);
}

#[cfg(windows)]
fn create_local_web_seed_torrent(path: &Path, payload: &[u8], web_seed: &str) {
    let piece_sha1 = [
        0x74, 0xb7, 0xa9, 0xdb, 0x9f, 0xd3, 0x71, 0x85, 0x96, 0x44, 0x09, 0xfb, 0x2e, 0x5f, 0x96,
        0x25, 0x78, 0x68, 0x03, 0xf9,
    ];
    let mut torrent = Vec::new();
    torrent.push(b'd');
    bencode_string(&mut torrent, b"info");
    torrent.push(b'd');
    bencode_string(&mut torrent, b"length");
    torrent.extend_from_slice(format!("i{}e", payload.len()).as_bytes());
    bencode_string(&mut torrent, b"name");
    bencode_string(&mut torrent, b"smoke.bin");
    bencode_string(&mut torrent, b"piece length");
    torrent.extend_from_slice(b"i16384e");
    bencode_string(&mut torrent, b"pieces");
    bencode_string(&mut torrent, &piece_sha1);
    torrent.push(b'e');
    bencode_string(&mut torrent, b"url-list");
    bencode_string(&mut torrent, web_seed.as_bytes());
    torrent.push(b'e');
    fs::write(path, torrent).expect("write local web-seed torrent");
}

#[cfg(windows)]
fn download_local_web_seed_torrent(aria2: &Path, root: &Path) {
    let payload = b"Clear Download Manager torrent smoke\n";
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind local web seed");
    listener
        .set_nonblocking(true)
        .expect("set web seed nonblocking");
    let address = listener.local_addr().expect("read web seed address");
    let stopped = Arc::new(AtomicBool::new(false));
    let server_stopped = stopped.clone();
    let server_payload = payload.to_vec();
    let server = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(35);
        while !server_stopped.load(Ordering::Relaxed) && Instant::now() < deadline {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    stream
                        .set_read_timeout(Some(Duration::from_secs(2)))
                        .expect("set web seed read timeout");
                    let mut request = [0u8; 4096];
                    let read = stream.read(&mut request).expect("read web seed request");
                    let headers = String::from_utf8_lossy(&request[..read]);
                    let range = headers.lines().find_map(|line| {
                        let value = line.strip_prefix("Range: bytes=")?;
                        let (start, end) = value.split_once('-')?;
                        Some((start.parse::<usize>().ok()?, end.parse::<usize>().ok()?))
                    });
                    let (status, body, content_range) = if let Some((start, end)) = range {
                        let start = start.min(server_payload.len());
                        let end = end.min(server_payload.len().saturating_sub(1));
                        if start <= end {
                            (
                                "206 Partial Content",
                                &server_payload[start..=end],
                                Some(format!(
                                    "Content-Range: bytes {start}-{end}/{}\r\n",
                                    server_payload.len()
                                )),
                            )
                        } else {
                            ("416 Range Not Satisfiable", &server_payload[0..0], None)
                        }
                    } else {
                        ("200 OK", server_payload.as_slice(), None)
                    };
                    let content_range = content_range.unwrap_or_default();
                    write!(
                        stream,
                        "HTTP/1.1 {status}\r\nContent-Length: {}\r\n{content_range}Connection: close\r\n\r\n",
                        body.len()
                    )
                    .expect("write web seed response headers");
                    stream.write_all(body).expect("write web seed payload");
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("local web seed failed: {error}"),
            }
        }
    });

    let torrent_path = root.join("smoke.torrent");
    let download_dir = root.join("torrent-download");
    fs::create_dir(&download_dir).expect("create torrent download directory");
    let web_seed = format!("http://{address}/smoke.bin");
    create_local_web_seed_torrent(&torrent_path, payload, &web_seed);

    let mut child = Command::new(aria2)
        .arg("--enable-dht=false")
        .arg("--bt-enable-lpd=false")
        .arg("--seed-time=0")
        .arg("--connect-timeout=3")
        .arg("--timeout=5")
        .arg("--max-tries=1")
        .arg("--console-log-level=warn")
        .arg(format!("--dir={}", download_dir.display()))
        .arg("--out=smoke.bin")
        .arg(&torrent_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("launch aria2 torrent smoke");
    let deadline = Instant::now() + Duration::from_secs(30);
    while child.try_wait().expect("poll aria2 process").is_none() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(50));
    }
    if child.try_wait().expect("poll aria2 process").is_none() {
        child.kill().expect("stop timed-out aria2 process");
    }
    let output = child.wait_with_output().expect("collect aria2 output");
    stopped.store(true, Ordering::Relaxed);
    server.join().expect("join local web seed server");
    assert!(
        output.status.success(),
        "aria2 torrent smoke failed: {}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        fs::read(download_dir.join("smoke.bin")).expect("read torrent output"),
        payload
    );
}

#[cfg(windows)]
#[test]
#[ignore = "manual local-package smoke; set CDM_COMPONENT_PACKAGE_DIR to prepared package directory"]
fn prepared_component_packages_install_verify_resolve_launch_and_remove() {
    let package_root = PathBuf::from(
        std::env::var_os("CDM_COMPONENT_PACKAGE_DIR")
            .expect("CDM_COMPONENT_PACKAGE_DIR must point to prepared .cdmcomponent files"),
    );
    let temp = tempdir().expect("temp dir");
    let manager = ComponentManager::new(
        temp.path().join("isolated-app-data").join("components"),
        RuntimePins::embedded().expect("embedded runtime pins"),
    )
    .expect("create isolated component manager");

    let media = manager
        .install_component_from_package(&package_root.join("media-tools-1.0.0.cdmcomponent"))
        .expect("install prepared Media Tools package");
    assert_eq!(media.state, ComponentState::Installed);
    assert_eq!(
        manager
            .verify_component(ComponentId::MediaTools)
            .expect("verify Media Tools")
            .state,
        ComponentState::Installed
    );
    for (capability, argument, version) in [
        (Capability::MediaExtraction, "--version", "2026.08.19"),
        (Capability::MediaMerge, "-version", "9.0.2"),
        (Capability::MediaProbe, "-version", "9.0.2"),
        (Capability::JsRuntime, "--version", "2.9.7"),
    ] {
        let executable = manager
            .resolve_capability(capability)
            .expect("resolve installed Media Tools capability");
        assert_runtime_version(&executable, argument, version);
    }
    let ffmpeg = manager
        .resolve_capability(Capability::MediaMerge)
        .expect("resolve installed FFmpeg");
    let ffprobe = manager
        .resolve_capability(Capability::MediaProbe)
        .expect("resolve installed FFprobe");
    let probe_input = temp.path().join("component-manager-input.wav");
    let probe_fixture = temp.path().join("component-manager-probe.wav");
    write_test_wav(&probe_input);
    let encoded = Command::new(&ffmpeg)
        .args(["-nostdin", "-hide_banner", "-loglevel", "error", "-i"])
        .arg(&probe_input)
        .args(["-c:a", "copy", "-y"])
        .arg(&probe_fixture)
        .output()
        .expect("run local FFmpeg smoke");
    assert!(
        encoded.status.success(),
        "FFmpeg smoke failed: {}",
        String::from_utf8_lossy(&encoded.stderr)
    );
    let probed = Command::new(&ffprobe)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=format_name",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(&probe_fixture)
        .output()
        .expect("run local FFprobe smoke");
    assert!(
        probed.status.success(),
        "FFprobe smoke failed: {}",
        String::from_utf8_lossy(&probed.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&probed.stdout).trim(),
        "wav",
        "FFprobe must recognize the generated local WAV"
    );
    if let Some(url) = std::env::var_os("CDM_YOUTUBE_SMOKE_URL") {
        let yt_dlp = manager
            .resolve_capability(Capability::MediaExtraction)
            .expect("resolve installed yt-dlp");
        let deno = manager
            .resolve_capability(Capability::JsRuntime)
            .expect("resolve installed Deno");
        let output = Command::new(&yt_dlp)
            .args([
                "--ignore-config",
                "--no-cache-dir",
                "--simulate",
                "--no-playlist",
                "--print",
                "%(id)s",
                "--remote-components",
                "ejs:github",
                "--js-runtimes",
            ])
            .arg(format!("deno:{}", deno.display()))
            .args(["--ffmpeg-location"])
            .arg(ffmpeg.parent().expect("FFmpeg parent directory"))
            .arg(url)
            .output()
            .expect("run no-download YouTube extraction smoke");
        assert!(
            output.status.success(),
            "yt-dlp extraction failed: stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            !output.stdout.is_empty(),
            "yt-dlp extraction returned no video metadata"
        );
        println!(
            "YouTube extraction resolved video ID: {}",
            String::from_utf8_lossy(&output.stdout).trim()
        );
    }
    manager
        .remove_component(ComponentId::MediaTools)
        .expect("remove prepared Media Tools package");
    assert_eq!(
        manager.component_status(ComponentId::MediaTools).state,
        ComponentState::Missing
    );

    let torrent = manager
        .install_component_from_package(&package_root.join("torrent-engine-1.0.0.cdmcomponent"))
        .expect("install prepared Torrent Engine package");
    assert_eq!(torrent.state, ComponentState::Installed);
    assert_eq!(
        manager
            .verify_component(ComponentId::TorrentEngine)
            .expect("verify Torrent Engine")
            .state,
        ComponentState::Installed
    );
    let aria2 = manager
        .resolve_capability(Capability::Bittorrent)
        .expect("resolve installed BitTorrent capability");
    assert_runtime_version(&aria2, "--version", "1.37.0");
    download_local_web_seed_torrent(&aria2, temp.path());
    manager
        .remove_component(ComponentId::TorrentEngine)
        .expect("remove prepared Torrent Engine package");
    assert_eq!(
        manager.component_status(ComponentId::TorrentEngine).state,
        ComponentState::Missing
    );
}

fn manager_in(temp: &Path) -> (ComponentManager, RuntimePins) {
    let pins = fixture_pins();
    let manager =
        ComponentManager::new(temp.join("app-local-data").join("components"), pins.clone())
            .expect("create manager");
    (manager, pins)
}

#[test]
fn embedded_runtime_manifest_provides_all_component_hash_pins() {
    let pins = RuntimePins::embedded().expect("embedded runtime pins");
    let media = pins.files_for(ComponentId::MediaTools);
    let torrent = pins.files_for(ComponentId::TorrentEngine);

    assert_eq!(
        media
            .iter()
            .map(|file| file.name.as_str())
            .collect::<Vec<_>>(),
        ["yt-dlp.exe", "ffmpeg.exe", "ffprobe.exe", "deno.exe"]
    );
    assert_eq!(torrent[0].name, "aria2c.exe");
    assert!(media
        .iter()
        .chain(torrent.iter())
        .all(|file| file.sha256.len() == 64));
}

fn make_package(temp: &Path, id: ComponentId, version: &str, pins: &RuntimePins) -> PathBuf {
    let path = temp.join(format!("{id}-{version}.zip"));
    write_package(&path, &package_manifest(id, version, pins), &[]);
    path
}

#[test]
fn component_status_starts_missing_and_capabilities_fail_closed() {
    let temp = tempdir().expect("temp dir");
    let (manager, _) = manager_in(temp.path());

    assert_eq!(
        manager.component_status(ComponentId::MediaTools).state,
        ComponentState::Missing
    );
    assert!(matches!(
        manager.resolve_capability(Capability::MediaProbe),
        Err(ComponentError::Missing(ComponentId::MediaTools))
    ));
}

#[cfg(windows)]
#[test]
fn manager_rejects_component_storage_under_junction_without_writing_through_it() {
    let temp = tempdir().expect("temp dir");
    let target = temp.path().join("outside-target");
    fs::create_dir(&target).expect("create junction target");
    let junction = temp.path().join("component-root-junction");
    let output = Command::new("cmd.exe")
        .args(["/C", "mklink", "/J"])
        .arg(&junction)
        .arg(&target)
        .output()
        .expect("create directory junction");
    assert!(
        output.status.success(),
        "mklink /J failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let result = ComponentManager::new(junction.join("components"), fixture_pins());

    assert!(
        matches!(result, Err(ComponentError::InvalidPackage(_))),
        "component storage below a junction must be rejected"
    );
    assert!(
        !target.join("components").exists(),
        "manager must not create storage through the junction"
    );
}

#[cfg(windows)]
#[test]
fn stale_staging_junction_does_not_prevent_core_manager_startup() {
    let temp = tempdir().expect("temp dir");
    let root = temp.path().join("components");
    let staging = root.join(STAGING_DIR);
    fs::create_dir_all(&staging).expect("create staging root");
    let outside = temp.path().join("outside-target");
    fs::create_dir(&outside).expect("create junction target");
    let sentinel = outside.join("keep.txt");
    fs::write(&sentinel, b"must remain untouched").expect("write junction sentinel");
    let junction = staging.join("stale-junction");
    let output = Command::new("cmd.exe")
        .args(["/C", "mklink", "/J"])
        .arg(&junction)
        .arg(&outside)
        .output()
        .expect("create staging junction");
    assert!(
        output.status.success(),
        "mklink /J failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let manager = ComponentManager::new(root, fixture_pins())
        .expect("stale optional staging must not prevent Core startup");

    assert_eq!(
        manager.component_status(ComponentId::MediaTools).state,
        ComponentState::Error
    );
    assert_eq!(
        manager.component_status(ComponentId::TorrentEngine).state,
        ComponentState::Error
    );
    assert!(sentinel.exists(), "cleanup must not traverse the junction");
}

#[cfg(windows)]
#[test]
fn staging_root_junction_does_not_prevent_core_manager_startup() {
    let temp = tempdir().expect("temp dir");
    let root = temp.path().join("components");
    fs::create_dir(&root).expect("create component root");
    let outside = temp.path().join("outside-target");
    fs::create_dir(&outside).expect("create junction target");
    let sentinel = outside.join("keep.txt");
    fs::write(&sentinel, b"must remain untouched").expect("write junction sentinel");
    let staging = root.join(STAGING_DIR);
    let output = Command::new("cmd.exe")
        .args(["/C", "mklink", "/J"])
        .arg(&staging)
        .arg(&outside)
        .output()
        .expect("create staging root junction");
    assert!(
        output.status.success(),
        "mklink /J failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let manager = ComponentManager::new(root, fixture_pins())
        .expect("unsafe optional staging root must not prevent Core startup");

    assert_eq!(
        manager.component_status(ComponentId::MediaTools).state,
        ComponentState::Error
    );
    assert_eq!(
        manager.component_status(ComponentId::TorrentEngine).state,
        ComponentState::Error
    );
    assert!(
        sentinel.exists(),
        "manager must not follow staging junction"
    );
}

#[test]
fn valid_media_package_installs_verifies_and_resolves_capabilities() {
    let temp = tempdir().expect("temp dir");
    let (manager, pins) = manager_in(temp.path());
    let package = make_package(temp.path(), ComponentId::MediaTools, "1.0.0", &pins);

    let status = manager
        .install_component_from_package(&package)
        .expect("install package");

    assert_eq!(status.state, ComponentState::Installed);
    assert_eq!(status.version.as_deref(), Some("1.0.0"));
    assert_eq!(
        manager
            .verify_component(ComponentId::MediaTools)
            .unwrap()
            .state,
        ComponentState::Installed
    );
    assert_eq!(
        manager
            .resolve_capability(Capability::MediaProbe)
            .unwrap()
            .file_name()
            .unwrap(),
        "ffprobe.exe"
    );
    assert_eq!(
        manager
            .resolve_capability(Capability::JsRuntime)
            .unwrap()
            .file_name()
            .unwrap(),
        "deno.exe"
    );
}

#[test]
fn failed_activation_cleanup_removes_renamed_version_and_pointer_temp() {
    let temp = tempdir().expect("temp dir");
    let staging = temp.path().join("staging-install");
    let final_directory = temp.path().join("versions").join("1.0.0-test");
    let pointer_temp = temp.path().join("active.json.random.tmp");
    fs::create_dir_all(&staging).expect("create staging directory");
    fs::write(staging.join("aria2c.exe"), b"partial install").expect("write staged executable");

    let mut cleanup = InstallCleanupGuard::new(staging.clone());
    fs::create_dir_all(final_directory.parent().expect("versions parent"))
        .expect("create version root");
    fs::rename(&staging, &final_directory).expect("move install into versions");
    cleanup.set_install_directory(final_directory.clone());
    fs::write(&pointer_temp, b"partial pointer").expect("write active pointer temp");
    cleanup.set_pointer_temp(pointer_temp.clone());

    drop(cleanup);

    assert!(!staging.exists());
    assert!(!final_directory.exists());
    assert!(!pointer_temp.exists());
}

#[test]
fn pointer_activation_failure_leaves_no_orphaned_version_or_temp() {
    let temp = tempdir().expect("temp dir");
    let (manager, pins) = manager_in(temp.path());
    let component_root = manager.component_root(ComponentId::MediaTools);
    fs::create_dir_all(component_root.join(POINTER_NAME))
        .expect("create directory to reject active pointer replacement");
    let package = make_package(temp.path(), ComponentId::MediaTools, "1.0.0", &pins);

    let result = manager.install_component_from_package(&package);

    assert!(result.is_err(), "a directory cannot be the active pointer");
    let versions_root = component_root.join("versions");
    assert_eq!(
        fs::read_dir(&versions_root)
            .expect("read version root")
            .count(),
        0,
        "unactivated version directory must be removed"
    );
    assert_eq!(
        fs::read_dir(&component_root)
            .expect("read component root")
            .filter_map(Result::ok)
            .filter(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with(&format!("{POINTER_NAME}.")))
            .count(),
        0,
        "pointer temporary file must be removed"
    );
    assert_eq!(staging_entries(manager.root()), 0);
}

#[test]
fn invalid_manifest_is_rejected_without_leaving_staging_files() {
    let temp = tempdir().expect("temp dir");
    let (manager, pins) = manager_in(temp.path());
    let package = temp.path().join("bad-manifest.zip");
    let mut manifest = package_manifest(ComponentId::MediaTools, "1.0.0", &pins);
    manifest.id = ComponentId::TorrentEngine;
    write_package(&package, &manifest, &[]);

    assert!(matches!(
        manager.install_component_from_package_for(ComponentId::MediaTools, &package),
        Err(ComponentError::InvalidManifest(_))
    ));
    assert_eq!(staging_entries(manager.root()), 0);
    assert_eq!(
        manager.component_status(ComponentId::MediaTools).state,
        ComponentState::Error
    );
}

#[test]
fn incorrect_file_hash_is_rejected_and_staging_is_cleaned() {
    let temp = tempdir().expect("temp dir");
    let (manager, pins) = manager_in(temp.path());
    let package = temp.path().join("bad-hash.zip");
    let manifest = package_manifest(ComponentId::MediaTools, "1.0.0", &pins);
    write_package(&package, &manifest, &[("ffprobe.exe", b"tampered ffprob")]);

    let result = manager.install_component_from_package(&package);
    assert!(
        matches!(&result, Err(ComponentError::HashMismatch { .. })),
        "result: {result:?}"
    );
    assert_eq!(staging_entries(manager.root()), 0);
    assert_eq!(
        manager.component_status(ComponentId::MediaTools).state,
        ComponentState::Error
    );
}

#[test]
fn zip_path_traversal_is_rejected_without_writing_outside_component_root() {
    let temp = tempdir().expect("temp dir");
    let (manager, pins) = manager_in(temp.path());
    let package = temp.path().join("traversal.zip");
    let manifest = package_manifest(ComponentId::TorrentEngine, "1.0.0", &pins);
    let file = fs::File::create(&package).expect("create package");
    let mut archive = ZipWriter::new(file);
    archive
        .start_file("component.json", SimpleFileOptions::default())
        .unwrap();
    archive
        .write_all(&serde_json::to_vec(&manifest).unwrap())
        .unwrap();
    archive
        .start_file("aria2c.exe", SimpleFileOptions::default())
        .unwrap();
    archive.write_all(b"trusted aria2").unwrap();
    archive
        .start_file("../outside.exe", SimpleFileOptions::default())
        .unwrap();
    archive.write_all(b"outside").unwrap();
    archive.finish().unwrap();

    assert!(matches!(
        manager.install_component_from_package(&package),
        Err(ComponentError::InvalidPackage(_))
    ));
    assert!(!temp.path().join("outside.exe").exists());
    assert_eq!(staging_entries(manager.root()), 0);
}

#[test]
fn failed_new_activation_preserves_the_previous_working_version() {
    let temp = tempdir().expect("temp dir");
    let (manager, pins) = manager_in(temp.path());
    let first = make_package(temp.path(), ComponentId::MediaTools, "1.0.0", &pins);
    manager
        .install_component_from_package(&first)
        .expect("install initial version");
    let active_before = manager
        .component_status(ComponentId::MediaTools)
        .version
        .expect("active version");

    let failed_upgrade = temp.path().join("failed-upgrade.zip");
    let mut bad_manifest = package_manifest(ComponentId::MediaTools, "2.0.0", &pins);
    bad_manifest.files[0].sha256 = "00".repeat(32);
    write_package(&failed_upgrade, &bad_manifest, &[]);
    assert!(manager
        .install_component_from_package(&failed_upgrade)
        .is_err());

    let status = manager.component_status(ComponentId::MediaTools);
    assert_eq!(status.state, ComponentState::Installed);
    assert_eq!(status.version.as_deref(), Some(active_before.as_str()));
    assert_eq!(staging_entries(manager.root()), 0);
    assert!(manager
        .resolve_capability(Capability::MediaExtraction)
        .is_ok());
}

#[test]
fn interrupted_staging_is_cleaned_on_startup_without_touching_active_version() {
    let temp = tempdir().expect("temp dir");
    let (manager, pins) = manager_in(temp.path());
    let package = make_package(temp.path(), ComponentId::MediaTools, "1.0.0", &pins);
    manager
        .install_component_from_package(&package)
        .expect("install initial version");
    let component_root = manager.root().to_path_buf();
    let interrupted = component_root.join(".staging").join("interrupted-install");
    fs::create_dir_all(&interrupted).expect("create interrupted staging fixture");
    fs::write(interrupted.join("ffmpeg.exe"), b"partial file").expect("write partial fixture");

    let restarted = ComponentManager::new(component_root, pins).expect("reopen manager");

    assert_eq!(staging_entries(restarted.root()), 0);
    assert_eq!(
        restarted.component_status(ComponentId::MediaTools).state,
        ComponentState::Installed
    );
    assert!(restarted.resolve_capability(Capability::MediaMerge).is_ok());
}

#[test]
fn verification_detects_modified_installed_component_and_repair_restores_it() {
    let temp = tempdir().expect("temp dir");
    let (manager, pins) = manager_in(temp.path());
    let package = make_package(temp.path(), ComponentId::MediaTools, "1.0.0", &pins);
    let installed = manager
        .install_component_from_package(&package)
        .expect("install package");
    let executable = installed
        .directory
        .expect("installed directory")
        .join("ffmpeg.exe");
    fs::write(&executable, b"corrupted").expect("corrupt fixture");

    assert_eq!(
        manager
            .verify_component(ComponentId::MediaTools)
            .unwrap()
            .state,
        ComponentState::Corrupted
    );
    assert!(matches!(
        manager.resolve_capability(Capability::MediaMerge),
        Err(ComponentError::Corrupted(ComponentId::MediaTools))
    ));

    let repaired = manager
        .repair_component(ComponentId::MediaTools, &package)
        .expect("repair from valid local package");
    assert_eq!(repaired.state, ComponentState::Installed);
    assert_eq!(
        manager.resolve_capability(Capability::MediaMerge).unwrap(),
        repaired.directory.unwrap().join("ffmpeg.exe")
    );
}

#[test]
fn remove_deactivates_and_removes_a_verified_component() {
    let temp = tempdir().expect("temp dir");
    let (manager, pins) = manager_in(temp.path());
    let package = make_package(temp.path(), ComponentId::TorrentEngine, "1.0.0", &pins);
    manager
        .install_component_from_package(&package)
        .expect("install package");

    manager
        .remove_component(ComponentId::TorrentEngine)
        .expect("remove package");

    assert_eq!(
        manager.component_status(ComponentId::TorrentEngine).state,
        ComponentState::Missing
    );
    assert!(matches!(
        manager.resolve_capability(Capability::Bittorrent),
        Err(ComponentError::Missing(ComponentId::TorrentEngine))
    ));
}

fn staging_entries(root: &Path) -> usize {
    fs::read_dir(root.join(".staging"))
        .map(|entries| entries.count())
        .unwrap_or(0)
}
