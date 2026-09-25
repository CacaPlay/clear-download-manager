#![allow(clippy::invisible_characters)]

use super::*;
use crate::progress::adapter::{
    shadow_begin_aria2, shadow_mark_aria2_cancelled, shadow_mark_aria2_cancelling,
    shadow_mark_aria2_completed, shadow_mark_aria2_failed, shadow_mark_aria2_finalizing,
    shadow_mark_aria2_paused, shadow_observe_aria2,
};
use crate::progress::aria2::{Aria2ProgressInput, Aria2V1Observation};

pub(crate) fn valid_btih_hash(value: &str) -> bool {
    (value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        || (value.len() == 32
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphabetic() || matches!(byte, b'2'..=b'7')))
}

pub(crate) fn valid_btmh_hash(value: &str) -> bool {
    value.len() == 68
        && value[..4].eq_ignore_ascii_case("1220")
        && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(crate) fn valid_magnet_exact_topic(value: &str) -> bool {
    let lowercase = value.to_ascii_lowercase();
    if let Some(hash) = lowercase.strip_prefix("urn:btih:") {
        return valid_btih_hash(hash);
    }
    if let Some(hash) = lowercase.strip_prefix("urn:btmh:") {
        return valid_btmh_hash(hash);
    }
    false
}

pub(crate) fn magnet_auxiliary_url_is_safe(value: &str, allow_udp: bool) -> bool {
    let Ok(parsed) = Url::parse(value) else {
        return false;
    };
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return false;
    }
    match parsed.scheme() {
        "http" | "https" => url_has_public_http_target(&parsed),
        "udp" if allow_udp => parsed.host_str().is_some_and(host_is_public),
        _ => false,
    }
}

pub(crate) fn normalize_torrent_source(source: &str) -> Result<(String, String, String), String> {
    let source = source.trim();
    if source.is_empty() || source.len() > 8_192 || source.chars().any(char::is_control) {
        return Err("El origen torrent no es válido".into());
    }
    if source.to_ascii_lowercase().starts_with("magnet:") {
        let parsed = Url::parse(source).map_err(|_| "El enlace magnet no es válido".to_string())?;
        if !parsed.scheme().eq_ignore_ascii_case("magnet") {
            return Err("El enlace magnet no es válido".into());
        }
        let mut has_hash = false;
        let mut display_name = String::new();
        for (key, value) in parsed.query_pairs() {
            if key.eq_ignore_ascii_case("xt") && valid_magnet_exact_topic(&value) {
                has_hash = true;
            }
            if key.eq_ignore_ascii_case("dn") && display_name.is_empty() {
                display_name = value.chars().take(160).collect();
            }
            if matches!(key.to_ascii_lowercase().as_str(), "ws" | "as" | "xs")
                && !magnet_auxiliary_url_is_safe(&value, false)
            {
                return Err("El magnet contiene una fuente web local o no segura".into());
            }
            if key.eq_ignore_ascii_case("tr") && !magnet_auxiliary_url_is_safe(&value, true) {
                return Err("El magnet contiene un tracker local o no seguro".into());
            }
        }
        if !has_hash {
            return Err("El magnet no contiene un hash BTIH o BTMH válido".into());
        }
        let display_name = if display_name.trim().is_empty() {
            "Torrent magnet".to_string()
        } else {
            sanitize_filename(&display_name)
        };
        return Ok((parsed.to_string(), "magnet".into(), display_name));
    }

    let path = PathBuf::from(source);
    if !path.is_absolute() {
        return Err("El archivo .torrent debe usar una ruta absoluta".into());
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| "No se pudo abrir el archivo .torrent".to_string())?;
    let has_torrent_extension = canonical
        .extension()
        .and_then(|value| value.to_str())
        .map(|extension| extension.eq_ignore_ascii_case("torrent"))
        .unwrap_or(false);
    if !has_torrent_extension {
        return Err("Selecciona un archivo con extensión .torrent".into());
    }
    let metadata = canonical
        .metadata()
        .map_err(|error| format!("No se pudo leer el archivo .torrent: {error}"))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > 32 * 1024 * 1024 {
        return Err("El archivo .torrent está vacío o excede 32 MB".into());
    }
    let label = canonical
        .file_stem()
        .and_then(|value| value.to_str())
        .map(sanitize_filename)
        .unwrap_or_else(|| "Torrent".into());
    Ok((
        canonical.to_string_lossy().to_string(),
        "file".into(),
        label,
    ))
}

#[derive(Debug, PartialEq)]
pub(crate) struct Aria2ProgressUpdate {
    pub(crate) downloaded_bytes: u64,
    pub(crate) total_bytes: u64,
    pub(crate) speed_bps: f64,
    pub(crate) eta_seconds: Option<u64>,
}

pub(crate) fn parse_aria2_byte_value(value: &str) -> Option<u64> {
    let normalized = value.trim().trim_end_matches("/s");
    let units = [
        ("TiB", 1024_f64.powi(4)),
        ("GiB", 1024_f64.powi(3)),
        ("MiB", 1024_f64.powi(2)),
        ("KiB", 1024_f64),
        ("TB", 1000_f64.powi(4)),
        ("GB", 1000_f64.powi(3)),
        ("MB", 1000_f64.powi(2)),
        ("KB", 1000_f64),
        ("B", 1_f64),
    ];
    for (suffix, multiplier) in units {
        let Some(number) = normalized.strip_suffix(suffix) else {
            continue;
        };
        let parsed = number.trim().parse::<f64>().ok()?;
        if !parsed.is_finite() || parsed < 0.0 {
            return None;
        }
        return Some((parsed * multiplier).round().clamp(0.0, u64::MAX as f64) as u64);
    }
    None
}

pub(crate) fn parse_aria2_eta(value: &str) -> Option<u64> {
    let mut total = 0_u64;
    let mut current = String::new();
    for character in value.trim().chars() {
        if character.is_ascii_digit() {
            current.push(character);
            continue;
        }
        let amount = current.parse::<u64>().ok()?;
        current.clear();
        total = total.saturating_add(match character {
            'd' => amount.saturating_mul(86_400),
            'h' => amount.saturating_mul(3_600),
            'm' => amount.saturating_mul(60),
            's' => amount,
            _ => return None,
        });
    }
    if !current.is_empty() {
        total = total.saturating_add(current.parse::<u64>().ok()?);
    }
    Some(total)
}

pub(crate) fn parse_aria2_progress_line(line: &str) -> Option<Aria2ProgressUpdate> {
    let start = line.rfind("[#")?;
    let end = line[start..].find(']')? + start;
    let body = &line[start + 1..end];
    let mut downloaded_bytes = None;
    let mut total_bytes = None;
    let mut speed_bps = 0.0;
    let mut eta_seconds = None;

    for raw_token in body.split_whitespace() {
        let token = raw_token.trim_matches(|character: char| matches!(character, ',' | ';'));
        let size_token = token.strip_prefix("SIZE:").unwrap_or(token);
        if let (true, Some((downloaded, total_with_percent))) =
            (downloaded_bytes.is_none(), size_token.split_once('/'))
        {
            let total = total_with_percent
                .split('(')
                .next()
                .unwrap_or(total_with_percent);
            downloaded_bytes = parse_aria2_byte_value(downloaded);
            total_bytes = parse_aria2_byte_value(total).filter(|value| *value > 0);
        }
        if let Some(speed) = token.strip_prefix("DL:").and_then(parse_aria2_byte_value) {
            speed_bps = speed as f64;
        }
        if let Some(eta) = token.strip_prefix("ETA:").and_then(parse_aria2_eta) {
            eta_seconds = Some(eta);
        }
    }

    Some(Aria2ProgressUpdate {
        downloaded_bytes: downloaded_bytes?.min(total_bytes?),
        total_bytes: total_bytes?,
        speed_bps,
        eta_seconds,
    })
}

pub(crate) fn update_torrent_progress(
    connection: &Connection,
    id: i64,
    update: Option<Aria2ProgressUpdate>,
    measured_bytes: u64,
    sampler: &mut TransferRateSampler,
    progress_gate: &mut ProgressPersistenceGate,
) -> Result<(), String> {
    let stored_total = connection
        .query_row(
            "SELECT total_bytes FROM torrent_jobs WHERE job_id=?1",
            params![id],
            |row| row.get::<_, Option<i64>>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .flatten()
        .filter(|value| *value > 0)
        .map(|value| value as u64);
    let total_bytes = update
        .as_ref()
        .map(|value| value.total_bytes)
        .or(stored_total);
    let downloaded_bytes = update
        .as_ref()
        .map(|value| value.downloaded_bytes)
        .unwrap_or(measured_bytes);
    let bounded_downloaded = total_bytes
        .map(|total| downloaded_bytes.min(total))
        .unwrap_or(downloaded_bytes);
    let sampled_speed = sampler.sample(bounded_downloaded);
    let reported_speed = update.as_ref().map(|value| value.speed_bps).unwrap_or(0.0);
    let previous_speed = connection
        .query_row(
            "SELECT speed_bps FROM torrent_jobs WHERE job_id=?1",
            params![id],
            |row| row.get::<_, f64>(0),
        )
        .unwrap_or(0.0);
    let stable_speed = stabilize_reported_speed(
        previous_speed,
        if reported_speed > 0.0 {
            reported_speed
        } else {
            sampled_speed
        },
    );
    let eta_seconds = update
        .as_ref()
        .and_then(|value| value.eta_seconds)
        .or_else(|| {
            total_bytes
                .filter(|total| *total > bounded_downloaded)
                .and_then(|total| {
                    (stable_speed > 1.0).then_some(
                        ((total - bounded_downloaded) as f64 / stable_speed).ceil() as u64,
                    )
                })
        });

    let progress_for_gate = total_bytes
        .map(|total| (bounded_downloaded as f64 * 100.0 / total as f64).clamp(0.0, 99.4))
        .unwrap_or(0.0);
    if !progress_gate.should_persist(bounded_downloaded, progress_for_gate, Duration::ZERO) {
        return Ok(());
    }
    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    if let Some(total) = total_bytes {
        let progress = (bounded_downloaded as f64 * 100.0 / total as f64).clamp(0.0, 99.4);
        transaction
            .execute(
                "UPDATE jobs SET progress=?1,detail=?2,updated_at=CURRENT_TIMESTAMP WHERE id=?3 AND status='running'",
                params![
                    progress,
                    format!(
                        "aria2c · {} de {} · {}/s",
                        human_bytes(bounded_downloaded),
                        human_bytes(total),
                        human_bytes(stable_speed as u64)
                    ),
                    id
                ],
            )
            .map_err(|error| error.to_string())?;
    } else {
        transaction
            .execute(
                "UPDATE jobs SET progress=0,detail=?1,updated_at=CURRENT_TIMESTAMP WHERE id=?2 AND status='running'",
                params![
                    if bounded_downloaded > 0 {
                        format!(
                            "aria2c · {} descargados · {}/s · calculando total",
                            human_bytes(bounded_downloaded),
                            human_bytes(stable_speed as u64)
                        )
                    } else {
                        "aria2c · obteniendo metadatos y pares…".to_string()
                    },
                    id
                ],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction
        .execute(
            "UPDATE torrent_jobs SET downloaded_bytes=?1,total_bytes=COALESCE(?2,total_bytes),speed_bps=?3,eta_seconds=?4,updated_at=CURRENT_TIMESTAMP WHERE job_id=?5",
            params![
                bounded_downloaded.min(i64::MAX as u64) as i64,
                total_bytes.map(|value| value.min(i64::MAX as u64) as i64),
                stable_speed,
                eta_seconds.map(|value| value.min(i64::MAX as u64) as i64),
                id
            ],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    progress_gate.mark_persisted(bounded_downloaded, progress_for_gate);
    Ok(())
}

pub(crate) fn fail_torrent_job(db_path: &Path, id: i64, message: &str) {
    if let Ok(connection) = Connection::open(db_path) {
        let _ = connection.execute(
            "UPDATE jobs SET status='failed',detail=?1,updated_at=CURRENT_TIMESTAMP WHERE id=?2",
            params![message, id],
        );
        let _ = connection.execute(
            "UPDATE torrent_jobs SET error=?1,speed_bps=0,updated_at=CURRENT_TIMESTAMP WHERE job_id=?2",
            params![message, id],
        );
    }
}

pub(crate) fn run_torrent_worker_inner(
    db_path: &Path,
    aria2_path: &Path,
    active: Arc<Mutex<HashMap<i64, u32>>>,
    id: i64,
) -> Result<(), String> {
    let connection = Connection::open(db_path).map_err(|error| error.to_string())?;
    configure_connection(&connection).map_err(|error| error.to_string())?;
    let bandwidth_policy = crate::downloads::read_job_bandwidth_policy(&connection, id);
    let (source, destination_dir): (String, String) = connection
        .query_row(
            "SELECT source,destination_dir FROM torrent_jobs WHERE job_id=?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| error.to_string())?;
    let destination_dir = PathBuf::from(destination_dir);
    fs::create_dir_all(&destination_dir).map_err(|error| error.to_string())?;
    connection
        .execute(
            "UPDATE jobs SET status='running',detail='aria2c · obteniendo metadatos y pares…',updated_at=CURRENT_TIMESTAMP WHERE id=?1 AND status IN ('queued','running')",
            params![id],
        )
        .map_err(|error| error.to_string())?;
    shadow_begin_aria2(id);

    let mut command = background_command(aria2_path);
    command.args([
        "--no-conf=true",
        "--continue=true",
        "--check-integrity=true",
        "--file-allocation=none",
        "--auto-file-renaming=false",
        "--allow-overwrite=false",
        "--seed-time=0",
        "--bt-save-metadata=true",
        "--enable-dht=true",
        "--bt-enable-lpd=false",
        "--summary-interval=1",
        "--console-log-level=notice",
        "--show-console-readout=true",
        "--download-result=hide",
        "--enable-color=false",
        "--max-connection-per-server=16",
        "--split=16",
        "--min-split-size=1M",
    ]);
    bandwidth_policy.apply_to_aria2(&mut command);
    command
        .arg("--dir")
        .arg(&destination_dir)
        .arg(&source)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("No se pudo iniciar aria2c: {error}"))?;
    let pid = child.id();
    if let Ok(mut processes) = active.lock() {
        processes.insert(id, pid);
    }
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "No se pudo leer el progreso de aria2c".to_string())?;
    let (progress_sender, progress_receiver) = mpsc::channel::<String>();
    let stdout_reader = thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut chunk = [0_u8; 1024];
        let mut pending = Vec::new();
        loop {
            let read = match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(read) => read,
                Err(_) => break,
            };
            for byte in &chunk[..read] {
                if matches!(*byte, b'\r' | b'\n') {
                    if pending.is_empty() {
                        continue;
                    }
                    let line = String::from_utf8_lossy(&pending).into_owned();
                    pending.clear();
                    if progress_sender.send(line).is_err() {
                        return;
                    }
                } else {
                    pending.push(*byte);
                }
            }
        }
        if !pending.is_empty() {
            let _ = progress_sender.send(String::from_utf8_lossy(&pending).into_owned());
        }
    });
    let stderr = child.stderr.take();
    let stderr_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(stderr) = stderr {
            let _ = BufReader::new(stderr).read_to_end(&mut bytes);
        }
        String::from_utf8_lossy(&bytes).into_owned()
    });
    let initial_bytes = directory_size(&destination_dir);
    let mut speed_sampler = TransferRateSampler::new(initial_bytes);
    let mut progress_gate = ProgressPersistenceGate::new();

    loop {
        let status: String = connection
            .query_row("SELECT status FROM jobs WHERE id=?1", params![id], |row| {
                row.get(0)
            })
            .map_err(|error| error.to_string())?;
        if matches!(status.as_str(), "paused" | "cancelled") {
            if status == "cancelled" {
                shadow_mark_aria2_cancelling(id);
            }
            kill_process_tree(pid);
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            if status == "cancelled" {
                shadow_mark_aria2_cancelled(id);
            } else {
                shadow_mark_aria2_paused(id);
            }
            let delete_partial = status == "cancelled"
                && connection
                    .query_row(
                        "SELECT cancel_cleanup FROM jobs WHERE id=?1",
                        params![id],
                        |row| row.get::<_, i64>(0),
                    )
                    .unwrap_or(1)
                    != 0;
            let detail = match (status.as_str(), delete_partial) {
                ("cancelled", true) => "Cancelada · limpieza segura solicitada",
                ("cancelled", false) => "Cancelada · datos torrent conservados",
                _ => "En pausa · aria2 conservará el estado para reanudar",
            };
            connection
                .execute(
                    "UPDATE jobs SET detail=?1,updated_at=CURRENT_TIMESTAMP WHERE id=?2",
                    params![detail, id],
                )
                .map_err(|error| error.to_string())?;
            connection
                .execute(
                    "UPDATE torrent_jobs SET speed_bps=0,updated_at=CURRENT_TIMESTAMP WHERE job_id=?1",
                    params![id],
                )
                .map_err(|error| error.to_string())?;
            return Ok(());
        }

        if let Some(exit_status) = child.try_wait().map_err(|error| error.to_string())? {
            let _ = stdout_reader.join();
            let stderr = stderr_reader.join().unwrap_or_default();
            if !exit_status.success() {
                let message = stderr
                    .lines()
                    .rev()
                    .find(|line| !line.trim().is_empty())
                    .unwrap_or("aria2c terminó con un error")
                    .chars()
                    .take(420)
                    .collect::<String>();
                return Err(message);
            }
            let bytes = directory_size(&destination_dir);
            shadow_mark_aria2_finalizing(id);
            connection
                .execute(
                    "UPDATE torrent_jobs SET downloaded_bytes=?1,total_bytes=?1,speed_bps=0,eta_seconds=0,error=NULL,updated_at=CURRENT_TIMESTAMP WHERE job_id=?2",
                    params![bytes.min(i64::MAX as u64) as i64, id],
                )
                .map_err(|error| error.to_string())?;
            connection
                .execute(
                    "UPDATE jobs SET status='completed',progress=100,detail='Torrent completado y verificado',updated_at=CURRENT_TIMESTAMP WHERE id=?1",
                    params![id],
                )
                .map_err(|error| error.to_string())?;
            connection
                .execute(
                    "INSERT INTO recent_files(name,path,category,kind,opened_at) VALUES(?1,?2,'Torrents','torrent',CURRENT_TIMESTAMP)
                     ON CONFLICT(path) DO UPDATE SET name=excluded.name,category=excluded.category,kind=excluded.kind,opened_at=CURRENT_TIMESTAMP",
                    params![
                        destination_dir
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or("Torrent"),
                        destination_dir.to_string_lossy().to_string()
                    ],
                )
                .map_err(|error| error.to_string())?;
            shadow_mark_aria2_completed(id, bytes);
            return Ok(());
        }

        let line = progress_receiver
            .recv_timeout(Duration::from_millis(500))
            .ok();
        let update = line.as_deref().and_then(parse_aria2_progress_line);
        if let Some(line) = line {
            if let Some(input) = Aria2ProgressInput::from_console_line(&line) {
                let progress_percent = input.total_length.map(|total| {
                    if total == 0 {
                        0.0
                    } else {
                        (input.completed_length as f64 * 100.0 / total as f64).clamp(0.0, 100.0)
                    }
                });
                let v1 = Aria2V1Observation {
                    status: input.status,
                    downloaded_bytes: input.completed_length,
                    total_bytes: input.total_length,
                    progress_percent,
                    speed_bps: input.download_speed_bps,
                    eta_seconds: input.eta_seconds,
                };
                shadow_observe_aria2(id, input, v1);
            }
        }
        update_torrent_progress(
            &connection,
            id,
            update,
            directory_size(&destination_dir),
            &mut speed_sampler,
            &mut progress_gate,
        )?;
    }
}

pub(crate) fn run_torrent_worker(
    db_path: PathBuf,
    aria2_path: PathBuf,
    active: Arc<Mutex<HashMap<i64, u32>>>,
    id: i64,
) {
    {
        let mut processes = match active.lock() {
            Ok(processes) => processes,
            Err(_) => {
                fail_torrent_job(&db_path, id, "No se pudo bloquear el motor aria2c");
                return;
            }
        };
        if processes.contains_key(&id) {
            return;
        }
        processes.insert(id, 0);
    }
    thread::spawn(move || {
        let _guard = ActiveMediaGuard {
            id,
            active: active.clone(),
        };
        if let Err(error) = run_torrent_worker_inner(&db_path, &aria2_path, active, id) {
            if EXIT_REQUESTED.load(Ordering::SeqCst) {
                return;
            }
            let status = Connection::open(&db_path)
                .ok()
                .and_then(|connection| {
                    connection
                        .query_row("SELECT status FROM jobs WHERE id=?1", params![id], |row| {
                            row.get::<_, String>(0)
                        })
                        .ok()
                })
                .unwrap_or_else(|| "failed".into());
            if !matches!(status.as_str(), "paused" | "cancelled" | "completed") {
                shadow_mark_aria2_failed(id);
                fail_torrent_job(&db_path, id, &error);
            }
        }
    });
}

pub(crate) fn resume_torrent_worker_when_idle(
    db_path: PathBuf,
    aria2_path: PathBuf,
    active: Arc<Mutex<HashMap<i64, u32>>>,
    id: i64,
) {
    thread::spawn(move || {
        for _ in 0..200 {
            let busy = active
                .lock()
                .map(|processes| processes.contains_key(&id))
                .unwrap_or(true);
            if !busy {
                if let Ok(connection) = Connection::open(&db_path) {
                    let _ = connection.execute(
                        "UPDATE jobs SET status='queued',detail='Reanudando torrent con aria2c…',updated_at=CURRENT_TIMESTAMP WHERE id=?1 AND status NOT IN ('completed','cancelled')",
                        params![id],
                    );
                }
                run_torrent_worker(db_path, aria2_path, active, id);
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        fail_torrent_job(
            &db_path,
            id,
            "No fue posible reanudar el torrent porque el proceso anterior no terminó",
        );
    });
}
pub(crate) fn choose_torrent_file(app: AppHandle) -> Result<Option<String>, String> {
    let selected = app
        .dialog()
        .file()
        .set_title("Elegir archivo BitTorrent")
        .blocking_pick_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|error| format!("El archivo seleccionado no es válido: {error}"))?;
    let source = path.to_string_lossy().to_string();
    let (normalized, source_kind, _) = normalize_torrent_source(&source)?;
    if source_kind != "file" {
        return Err("Selecciona un archivo local con extensión .torrent".into());
    }
    Ok(Some(normalized))
}
pub(crate) fn queue_torrent_download(
    source: String,
    state: State<'_, LocalState>,
) -> Result<DownloadQueueReceipt, String> {
    let aria2_path = state
        .aria2_path
        .clone()
        .ok_or_else(|| "aria2c no está disponible en esta instalación".to_string())?;
    let (source, source_kind, label) = normalize_torrent_source(&source)?;
    let downloads_dir = current_downloads_dir(&state)?.join("Torrents");
    fs::create_dir_all(&downloads_dir).map_err(|error| error.to_string())?;
    let destination = unique_directory(&downloads_dir, &label);

    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "No se pudo bloquear la base local".to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO jobs(title,detail,progress,status,updated_at) VALUES(?1,'Torrent en cola · aria2c',0,'queued',CURRENT_TIMESTAMP)",
            params![label],
        )
        .map_err(|error| error.to_string())?;
    let job_id = transaction.last_insert_rowid();
    transaction
        .execute(
            "INSERT INTO torrent_jobs(job_id,source,source_kind,destination_dir) VALUES(?1,?2,?3,?4)",
            params![
                job_id,
                source,
                source_kind,
                destination.to_string_lossy().to_string()
            ],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    drop(connection);

    run_torrent_worker(
        state.db_path.clone(),
        aria2_path,
        state.active_media_pids.clone(),
        job_id,
    );
    Ok(DownloadQueueReceipt {
        job_id,
        filename: label,
        destination: destination.to_string_lossy().to_string(),
        resumable: true,
    })
}

pub(crate) fn queued_torrent_jobs_for_recovery(
    connection: &Connection,
) -> rusqlite::Result<Vec<i64>> {
    let mut statement = connection.prepare(
        "SELECT torrent_jobs.job_id
           FROM torrent_jobs
           JOIN jobs ON jobs.id=torrent_jobs.job_id
          WHERE jobs.status IN ('queued','running')
          ORDER BY CASE lower(COALESCE(jobs.priority,'normal'))
                       WHEN 'high' THEN 0
                       WHEN 'low' THEN 2
                       ELSE 1
                   END,
                   jobs.id",
    )?;
    let rows = statement.query_map([], |row| row.get(0))?;
    rows.collect()
}

#[cfg(test)]
mod priority_tests {
    use super::*;
    use crate::migrate;

    #[test]
    fn priority_runtime_torrent_recovery_backlog_uses_priority_then_original_job_id() {
        let connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        let mut ids = Vec::new();
        for priority in ["normal", "high", "normal", "high", "low"] {
            connection
                .execute(
                    "INSERT INTO jobs(title,status,priority) VALUES(?1,'queued',?2)",
                    params![priority, priority],
                )
                .unwrap();
            let id = connection.last_insert_rowid();
            connection
                .execute(
                    "INSERT INTO torrent_jobs(job_id,source,source_kind,destination_dir) VALUES(?1,?2,'magnet','downloads')",
                    params![id, format!("magnet:?xt=urn:btih:{id:040x}")],
                )
                .unwrap();
            ids.push(id);
        }
        assert_eq!(
            queued_torrent_jobs_for_recovery(&connection).unwrap(),
            vec![ids[1], ids[3], ids[0], ids[2], ids[4]]
        );
    }
}
