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

const REMOTE_CATALOG_NOW: i64 = 1_800_000_000;
const COMPONENT_TEST_SEED: [u8; 32] = [
    0x42, 0x19, 0x07, 0x2a, 0x5c, 0x9e, 0x11, 0xd3, 0x84, 0x20, 0x71, 0xa6, 0x0f, 0xc8, 0x33, 0x95,
    0x67, 0x14, 0xe2, 0x4b, 0x8a, 0x55, 0x09, 0xbd, 0x73, 0x2c, 0xf1, 0x68, 0x0a, 0x44, 0x97, 0x5e,
];

fn component_test_trust() -> TrustedKeys {
    let key = ed25519_dalek::SigningKey::from_bytes(&COMPONENT_TEST_SEED);
    TrustedKeys::from_public_key_bytes(vec![(
        "component-test-2026".into(),
        key.verifying_key().to_bytes(),
    )])
    .expect("test trust root")
}

fn incompatible_fixture_pins() -> RuntimePins {
    RuntimePins::from_test_files([
        (
            RuntimeArtifact::YtDlp,
            "yt-dlp.exe",
            "old",
            b"old ytdlp".as_slice(),
        ),
        (
            RuntimeArtifact::Ffmpeg,
            "ffmpeg.exe",
            "old",
            b"old ffmpeg".as_slice(),
        ),
        (
            RuntimeArtifact::Ffprobe,
            "ffprobe.exe",
            "old",
            b"old ffprobe".as_slice(),
        ),
        (
            RuntimeArtifact::Deno,
            "deno.exe",
            "old",
            b"old deno".as_slice(),
        ),
        (
            RuntimeArtifact::Aria2,
            "aria2c.exe",
            "old",
            b"old aria2".as_slice(),
        ),
    ])
}

fn catalog_source(
    runtime_id: &str,
    source_commit: &str,
    asset_name: &str,
    license: &str,
) -> distribution::CorrespondingSourceAsset {
    distribution::CorrespondingSourceAsset {
        runtime_id: runtime_id.into(),
        source_commit: source_commit.into(),
        asset_name: asset_name.into(),
        asset_url: format!(
            "https://github.com/CacaPlay/clear-download-manager/releases/download/v0.95.5/{asset_name}"
        ),
        bytes: 100,
        sha256: "a".repeat(64),
        license: license.into(),
        human_review: "APPROVED".into(),
    }
}

fn catalog_component(
    id: ComponentId,
    version: &str,
    package_path: &Path,
    address: std::net::SocketAddr,
    pins: &RuntimePins,
) -> distribution::CatalogComponent {
    let asset_name = format!("{}-{version}.cdmcomponent", id.as_str());
    let source_tag = "v0.95.5";
    let (corresponding_sources, license_notices) = match id {
        ComponentId::MediaTools => (
            vec![
                catalog_source(
                    "ffmpeg",
                    "946fcce07b6dcd0331c8cc609192aeff5e1924f8",
                    "ffmpeg-9.0.2-safe-lean-win64-corresponding-source.tar.xz",
                    "GPL-3.0-or-later",
                ),
                catalog_source(
                    "yt-dlp",
                    "3a08beaf031ab68f966401ead017ac81fe8486cf",
                    "yt-dlp-2026.08.19-win64-corresponding-source.tar.xz",
                    "GPL-3.0-or-later",
                ),
            ],
            vec![
                distribution::LicenseNotice {
                    runtime_id: "yt-dlp".into(),
                    spdx: "GPL-3.0-or-later".into(),
                    notice_file: "YT-DLP-NOTICE.txt".into(),
                    notice_sha256: "c".repeat(64),
                },
                distribution::LicenseNotice {
                    runtime_id: "ffmpeg".into(),
                    spdx: "GPL-3.0-or-later".into(),
                    notice_file: "FFMPEG-NOTICE.txt".into(),
                    notice_sha256: "c".repeat(64),
                },
                distribution::LicenseNotice {
                    runtime_id: "deno".into(),
                    spdx: "MIT".into(),
                    notice_file: "DENO-NOTICE.txt".into(),
                    notice_sha256: "c".repeat(64),
                },
            ],
        ),
        ComponentId::TorrentEngine => (
            vec![catalog_source(
                "aria2",
                "02f2d0d8472b3c38c29b4dba8c75ebd5fdd2899a",
                "aria2-1.37.0-win64-corresponding-source.tar.xz",
                "GPL-2.0-or-later",
            )],
            vec![distribution::LicenseNotice {
                runtime_id: "aria2".into(),
                spdx: "GPL-2.0-or-later".into(),
                notice_file: "ARIA2-NOTICE.txt".into(),
                notice_sha256: "c".repeat(64),
            }],
        ),
    };
    let package_bytes = fs::read(package_path).expect("read test package");
    distribution::CatalogComponent {
        id,
        version: version.into(),
        release_tag: source_tag.into(),
        asset_name: asset_name.clone(),
        package_url: format!("http://{address}/{asset_name}"),
        package_bytes: package_bytes.len() as u64,
        package_sha256: sha256_bytes(&package_bytes),
        capabilities: id.capabilities().to_vec(),
        minimum_cdm_version: "0.95.4".into(),
        files: package_manifest(id, version, pins).files,
        corresponding_sources,
        license_notices,
    }
}

fn start_remote_component_fixture(
    temp: &Path,
    version: &str,
    sequence: u64,
    tamper_media_package: bool,
) -> (String, thread::JoinHandle<()>) {
    use ed25519_dalek::Signer;

    let pins = fixture_pins();
    let media_path = temp.join(format!("media-{version}.zip"));
    let torrent_path = temp.join(format!("torrent-{version}.zip"));
    write_package(
        &media_path,
        &package_manifest(ComponentId::MediaTools, version, &pins),
        &[],
    );
    write_package(
        &torrent_path,
        &package_manifest(ComponentId::TorrentEngine, version, &pins),
        &[],
    );
    let media_bytes = fs::read(&media_path).expect("read media package");
    let torrent_bytes = fs::read(&torrent_path).expect("read torrent package");
    let mut served_media_bytes = media_bytes.clone();
    if tamper_media_package {
        served_media_bytes[0] ^= 0xff;
    }

    let listener = TcpListener::bind("127.0.0.1:0").expect("bind local component fixture");
    let address = listener.local_addr().expect("local fixture address");
    let media_component = catalog_component(
        ComponentId::MediaTools,
        version,
        &media_path,
        address,
        &pins,
    );
    let torrent_component = catalog_component(
        ComponentId::TorrentEngine,
        version,
        &torrent_path,
        address,
        &pins,
    );
    let payload = distribution::ComponentCatalogPayload {
        schema_version: 1,
        catalog_version: "1".into(),
        sequence,
        key_id: "component-test-2026".into(),
        issued_at: REMOTE_CATALOG_NOW - 10,
        expires_at: REMOTE_CATALOG_NOW + 3600,
        components: vec![media_component.clone(), torrent_component.clone()],
    };
    let canonical_payload = serde_json::to_vec(&payload).expect("serialize catalog payload");
    let key = ed25519_dalek::SigningKey::from_bytes(&COMPONENT_TEST_SEED);
    let signed = distribution::SignedComponentCatalog {
        payload,
        signature: base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            key.sign(&canonical_payload).to_bytes(),
        ),
    };
    let catalog_bytes = serde_json::to_vec(&signed).expect("serialize signed catalog");
    let media_name = media_component.asset_name;
    let torrent_name = torrent_component.asset_name;
    let server = thread::spawn(move || {
        for _ in 0..2 {
            let (mut stream, _) = listener.accept().expect("accept fixture request");
            let mut request = Vec::new();
            let mut chunk = [0_u8; 1024];
            loop {
                let read = stream.read(&mut chunk).expect("read fixture request");
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..read]);
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            let request_line = String::from_utf8_lossy(&request);
            let body: &[u8] = if request_line.starts_with("GET /component-catalog-v1.json ") {
                &catalog_bytes
            } else if request_line.starts_with(&format!("GET /{media_name} ")) {
                &served_media_bytes
            } else if request_line.starts_with(&format!("GET /{torrent_name} ")) {
                &torrent_bytes
            } else {
                &[]
            };
            let status = if body.is_empty() {
                "404 Not Found"
            } else {
                "200 OK"
            };
            write!(
                stream,
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .expect("write fixture response headers");
            stream.write_all(body).expect("write fixture response body");
        }
    });
    (
        format!("http://{address}/component-catalog-v1.json"),
        server,
    )
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

#[test]
fn signed_remote_component_catalog_downloads_verifies_installs_and_activates_atomically() {
    let temp = tempdir().expect("temp dir");
    let (endpoint, server) = start_remote_component_fixture(temp.path(), "1.0.0", 1, false);
    let manager = ComponentManager::new_with_trust(
        temp.path().join("remote-components"),
        incompatible_fixture_pins(),
        component_test_trust(),
    )
    .expect("create manager with test trust root");
    let mut progress = Vec::new();

    let installed = manager
        .install_component_from_catalog_at(
            ComponentId::MediaTools,
            &endpoint,
            REMOTE_CATALOG_NOW,
            true,
            |state, received, total| progress.push((state, received, total)),
        )
        .expect("install verified remote component");
    server.join().expect("complete local HTTP fixture");

    assert_eq!(installed.state, ComponentState::Installed);
    assert_eq!(installed.version.as_deref(), Some("1.0.0"));
    assert!(progress
        .iter()
        .any(|(state, _, _)| *state == ComponentState::Verifying));
    assert!(progress
        .iter()
        .any(|(state, _, _)| *state == ComponentState::Installing));
    assert_eq!(
        fs::read(
            manager
                .resolve_capability(Capability::MediaExtraction)
                .expect("resolve activated runtime")
        )
        .expect("read activated fixture runtime"),
        fixture_bytes("yt-dlp.exe")
    );
    assert!(manager.root().join(CATALOG_STATE_NAME).is_file());
    assert_eq!(staging_entries(manager.root()), 0);
    let restarted = ComponentManager::new_with_trust(
        manager.root().to_path_buf(),
        incompatible_fixture_pins(),
        component_test_trust(),
    )
    .expect("restart manager with same trust root");
    assert_eq!(
        restarted.component_status(ComponentId::MediaTools).state,
        ComponentState::Installed
    );
    assert_eq!(
        fs::read(
            restarted
                .resolve_capability(Capability::MediaExtraction)
                .expect("resolve signed runtime after restart")
        )
        .expect("read runtime after restart"),
        fixture_bytes("yt-dlp.exe")
    );
}

#[test]
fn signed_catalog_update_activates_new_component_version() {
    let temp = tempdir().expect("temp dir");
    let manager = ComponentManager::new_with_trust(
        temp.path().join("remote-components"),
        incompatible_fixture_pins(),
        component_test_trust(),
    )
    .expect("create manager with test trust root");
    let (first_endpoint, first_server) =
        start_remote_component_fixture(temp.path(), "1.0.0", 1, false);
    manager
        .install_component_from_catalog_at(
            ComponentId::MediaTools,
            &first_endpoint,
            REMOTE_CATALOG_NOW,
            true,
            |_, _, _| {},
        )
        .expect("install original remote component");
    first_server.join().expect("complete initial transfer");
    let original_path = manager
        .resolve_capability(Capability::MediaExtraction)
        .expect("resolve original runtime");

    let (update_endpoint, update_server) =
        start_remote_component_fixture(temp.path(), "2.0.0", 2, false);
    let updated = manager
        .install_component_from_catalog_at(
            ComponentId::MediaTools,
            &update_endpoint,
            REMOTE_CATALOG_NOW,
            true,
            |_, _, _| {},
        )
        .expect("activate newer signed component");
    update_server.join().expect("complete update transfer");

    assert_eq!(updated.version.as_deref(), Some("2.0.0"));
    let updated_path = manager
        .resolve_capability(Capability::MediaExtraction)
        .expect("resolve updated runtime");
    assert_ne!(updated_path, original_path);
    assert_eq!(
        fs::read(updated_path).expect("read updated runtime"),
        fixture_bytes("yt-dlp.exe")
    );
}

#[test]
fn failed_remote_update_preserves_the_previously_active_component() {
    let temp = tempdir().expect("temp dir");
    let manager = ComponentManager::new_with_trust(
        temp.path().join("remote-components"),
        fixture_pins(),
        component_test_trust(),
    )
    .expect("create manager with test trust root");
    let (first_endpoint, first_server) =
        start_remote_component_fixture(temp.path(), "1.0.0", 1, false);
    manager
        .install_component_from_catalog_at(
            ComponentId::MediaTools,
            &first_endpoint,
            REMOTE_CATALOG_NOW,
            true,
            |_, _, _| {},
        )
        .expect("install original remote component");
    first_server
        .join()
        .expect("complete first fixture transfer");
    let original_path = manager
        .resolve_capability(Capability::MediaExtraction)
        .expect("resolve original active runtime");
    let (update_endpoint, update_server) =
        start_remote_component_fixture(temp.path(), "2.0.0", 2, true);

    let result = manager.install_component_from_catalog_at(
        ComponentId::MediaTools,
        &update_endpoint,
        REMOTE_CATALOG_NOW,
        true,
        |_, _, _| {},
    );
    update_server
        .join()
        .expect("complete update fixture transfer");

    assert!(matches!(
        result,
        Err(ComponentError::Download(
            distribution::AssetDownloadError::HashMismatch
        ))
    ));
    let status = manager.component_status(ComponentId::MediaTools);
    assert_eq!(status.version.as_deref(), Some("1.0.0"));
    assert_eq!(status.state, ComponentState::UpdateAvailable);
    assert_eq!(
        manager
            .resolve_capability(Capability::MediaExtraction)
            .expect("old runtime stays active after failed update"),
        original_path
    );
    assert_eq!(staging_entries(manager.root()), 0);
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
fn signed_catalog_reinstall_repairs_corruption_and_remove_deactivates_component() {
    let temp = tempdir().expect("temp dir");
    let manager = ComponentManager::new_with_trust(
        temp.path().join("remote-components"),
        incompatible_fixture_pins(),
        component_test_trust(),
    )
    .expect("create manager with test trust root");
    let (endpoint, server) = start_remote_component_fixture(temp.path(), "1.0.0", 1, false);
    manager
        .install_component_from_catalog_at(
            ComponentId::MediaTools,
            &endpoint,
            REMOTE_CATALOG_NOW,
            true,
            |_, _, _| {},
        )
        .expect("install signed remote component");
    server.join().expect("complete initial transfer");
    let active = manager
        .resolve_capability(Capability::MediaExtraction)
        .expect("resolve installed runtime");
    fs::write(&active, b"corrupted runtime").expect("corrupt installed runtime");
    assert_eq!(
        manager
            .verify_component(ComponentId::MediaTools)
            .expect("verify corrupted runtime")
            .state,
        ComponentState::Corrupted
    );

    let (repair_endpoint, repair_server) =
        start_remote_component_fixture(temp.path(), "1.0.0", 2, false);
    let repaired = manager
        .install_component_from_catalog_at(
            ComponentId::MediaTools,
            &repair_endpoint,
            REMOTE_CATALOG_NOW,
            true,
            |_, _, _| {},
        )
        .expect("repair from the current signed catalog package");
    repair_server.join().expect("complete repair transfer");
    assert_eq!(repaired.state, ComponentState::Installed);
    assert_eq!(repaired.version.as_deref(), Some("1.0.0"));
    assert_eq!(
        fs::read(
            manager
                .resolve_capability(Capability::MediaExtraction)
                .expect("resolve repaired runtime")
        )
        .expect("read repaired runtime"),
        fixture_bytes("yt-dlp.exe")
    );

    manager
        .remove_component(ComponentId::MediaTools)
        .expect("remove repaired remote component");
    assert_eq!(
        manager.component_status(ComponentId::MediaTools).state,
        ComponentState::Missing
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
