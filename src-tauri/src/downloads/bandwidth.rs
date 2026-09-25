use rusqlite::{params, Connection, OptionalExtension};
use serde::{de, Deserialize, Deserializer, Serialize};
use std::{
    num::NonZeroU64,
    process::Command,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

pub(crate) const BANDWIDTH_SETTINGS_KEY: &str = "download_bandwidth_v1";
pub(crate) const MIN_BANDWIDTH_BYTES_PER_SECOND: u64 = 64_000;
pub(crate) const MAX_BANDWIDTH_BYTES_PER_SECOND: u64 = 10_000_000_000;
const NANOS_PER_SECOND: u128 = 1_000_000_000;
// Keep pacing corrections short so the observed rate does not oscillate by a
// whole 50 ms chunk at low limits (the old 25 ms sleep made 512 KB/s visibly
// jump between roughly 400 and 600 KB/s in the UI).
const MAX_WAIT_SLICE: Duration = Duration::from_millis(5);
const MIN_READ_GRANT: u64 = 4 * 1024;
const MAX_READ_GRANT: u64 = 256 * 1024;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) enum BandwidthPolicy {
    #[default]
    Unlimited,
    PerDownload {
        bytes_per_second: NonZeroU64,
    },
}

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(tag = "mode")]
pub(crate) enum BandwidthSettings {
    #[default]
    #[serde(rename = "unlimited")]
    Unlimited,
    #[serde(rename = "limited")]
    Limited {
        #[serde(rename = "bytesPerSecond")]
        bytes_per_second: u64,
    },
}

impl<'de> Deserialize<'de> for BandwidthSettings {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct WireSettings {
            mode: String,
            #[serde(rename = "bytesPerSecond")]
            bytes_per_second: Option<u64>,
        }

        let wire = WireSettings::deserialize(deserializer)?;
        match (wire.mode.as_str(), wire.bytes_per_second) {
            ("unlimited", None) => Ok(Self::Unlimited),
            ("limited", Some(bytes_per_second)) => Ok(Self::Limited { bytes_per_second }),
            ("unlimited", Some(_)) => Err(de::Error::custom("unlimited no acepta bytesPerSecond")),
            ("limited", None) => Err(de::Error::missing_field("bytesPerSecond")),
            _ => Err(de::Error::unknown_variant(
                &wire.mode,
                &["unlimited", "limited"],
            )),
        }
    }
}

impl TryFrom<BandwidthSettings> for BandwidthPolicy {
    type Error = String;

    fn try_from(value: BandwidthSettings) -> Result<Self, Self::Error> {
        match value {
            BandwidthSettings::Unlimited => Ok(Self::Unlimited),
            BandwidthSettings::Limited { bytes_per_second }
                if (MIN_BANDWIDTH_BYTES_PER_SECOND..=MAX_BANDWIDTH_BYTES_PER_SECOND)
                    .contains(&bytes_per_second) =>
            {
                Ok(Self::PerDownload {
                    bytes_per_second: NonZeroU64::new(bytes_per_second)
                        .expect("validated non-zero bandwidth"),
                })
            }
            BandwidthSettings::Limited { bytes_per_second } => Err(format!(
                "La velocidad debe estar entre {MIN_BANDWIDTH_BYTES_PER_SECOND} y {MAX_BANDWIDTH_BYTES_PER_SECOND} bytes por segundo; se recibió {bytes_per_second}"
            )),
        }
    }
}

impl From<&BandwidthPolicy> for BandwidthSettings {
    fn from(value: &BandwidthPolicy) -> Self {
        match value {
            BandwidthPolicy::Unlimited => Self::Unlimited,
            BandwidthPolicy::PerDownload { bytes_per_second } => Self::Limited {
                bytes_per_second: bytes_per_second.get(),
            },
        }
    }
}

impl BandwidthPolicy {
    pub(crate) fn bytes_per_second(&self) -> Option<u64> {
        match self {
            Self::Unlimited => None,
            Self::PerDownload { bytes_per_second } => Some(bytes_per_second.get()),
        }
    }

    pub(crate) fn limiter(&self) -> Option<Arc<BandwidthLimiter>> {
        self.bytes_per_second()
            .map(|value| Arc::new(BandwidthLimiter::new(value)))
    }

    pub(crate) fn apply_to_yt_dlp(&self, command: &mut Command) {
        if let Some(value) = self.bytes_per_second() {
            command.arg("--limit-rate").arg(value.to_string());
        }
    }

    pub(crate) fn apply_to_aria2(&self, command: &mut Command) {
        if let Some(value) = self.bytes_per_second() {
            command.arg(format!("--max-download-limit={value}"));
        }
    }

    pub(crate) fn allows_ffmpeg_network_downloader(&self) -> bool {
        matches!(self, Self::Unlimited)
    }
}

pub(crate) fn read_bandwidth_settings(connection: &Connection) -> BandwidthSettings {
    let stored = connection
        .query_row(
            "SELECT value FROM settings WHERE key=?1",
            params![BANDWIDTH_SETTINGS_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten();
    let Some(stored) = stored else {
        return BandwidthSettings::Unlimited;
    };
    match serde_json::from_str::<BandwidthSettings>(&stored)
        .map_err(|error| error.to_string())
        .and_then(BandwidthPolicy::try_from)
    {
        Ok(policy) => BandwidthSettings::from(&policy),
        Err(error) => {
            eprintln!("[bandwidth] persisted setting rejected; using unlimited: {error}");
            BandwidthSettings::Unlimited
        }
    }
}

pub(crate) fn read_bandwidth_policy(connection: &Connection) -> BandwidthPolicy {
    BandwidthPolicy::try_from(read_bandwidth_settings(connection)).unwrap_or_default()
}

/// Reads the explicit limit for one job, falling back to the application-wide
/// per-download policy when the user has not overridden it from the context
/// menu. A stored zero is an explicit "Sin límite" override.
pub(crate) fn read_job_bandwidth_policy(connection: &Connection, job_id: i64) -> BandwidthPolicy {
    let stored = connection
        .query_row(
            "SELECT bytes_per_second FROM download_speed_limits WHERE job_id=?1",
            params![job_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .ok()
        .flatten();
    match stored {
        Some(0) => BandwidthPolicy::Unlimited,
        Some(bytes_per_second) if bytes_per_second > 0 => {
            BandwidthPolicy::try_from(BandwidthSettings::Limited {
                bytes_per_second: bytes_per_second as u64,
            })
            .unwrap_or_else(|_| read_bandwidth_policy(connection))
        }
        Some(_) => read_bandwidth_policy(connection),
        None => read_bandwidth_policy(connection),
    }
}

pub(crate) fn persist_job_bandwidth_settings(
    connection: &Connection,
    job_id: i64,
    settings: BandwidthSettings,
) -> Result<BandwidthSettings, String> {
    if job_id <= 0 {
        return Err("La descarga indicada no es válida".into());
    }
    let policy = BandwidthPolicy::try_from(settings)?;
    let normalized = BandwidthSettings::from(&policy);
    let bytes_per_second = policy.bytes_per_second().unwrap_or(0) as i64;
    connection
        .execute(
            "INSERT INTO download_speed_limits(job_id,bytes_per_second,updated_at) VALUES(?1,?2,CURRENT_TIMESTAMP)
             ON CONFLICT(job_id) DO UPDATE SET bytes_per_second=excluded.bytes_per_second,updated_at=CURRENT_TIMESTAMP",
            params![job_id, bytes_per_second],
        )
        .map_err(|error| error.to_string())?;
    Ok(normalized)
}

/// Applies a context-menu limit to every child job that belongs to a playlist
/// batch.  Playlist cards are aggregate rows (their synthetic UI id is
/// negative), so persisting the policy against the real child jobs keeps the
/// existing worker/runtime path unchanged while making the setting durable.
pub(crate) fn persist_playlist_bandwidth_settings(
    connection: &Connection,
    batch_id: i64,
    settings: BandwidthSettings,
) -> Result<BandwidthSettings, String> {
    if batch_id <= 0 {
        return Err("La playlist indicada no es válida".into());
    }
    let exists = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM playlist_batches WHERE id=?1)",
            params![batch_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?
        != 0;
    if !exists {
        return Err(format!("La playlist #{batch_id} ya no existe"));
    }
    let policy = BandwidthPolicy::try_from(settings)?;
    let normalized = BandwidthSettings::from(&policy);
    let bytes_per_second = policy.bytes_per_second().unwrap_or(0) as i64;
    let mut statement = connection
        .prepare("SELECT job_id FROM playlist_items WHERE batch_id=?1 AND job_id IS NOT NULL")
        .map_err(|error| error.to_string())?;
    let job_ids = statement
        .query_map(params![batch_id], |row| row.get::<_, i64>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    for job_id in job_ids {
        connection
            .execute(
                "INSERT INTO download_speed_limits(job_id,bytes_per_second,updated_at) VALUES(?1,?2,CURRENT_TIMESTAMP)
                 ON CONFLICT(job_id) DO UPDATE SET bytes_per_second=excluded.bytes_per_second,updated_at=CURRENT_TIMESTAMP",
                params![job_id, bytes_per_second],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(normalized)
}

pub(crate) fn persist_bandwidth_settings(
    connection: &Connection,
    settings: BandwidthSettings,
) -> Result<BandwidthSettings, String> {
    let policy = BandwidthPolicy::try_from(settings)?;
    let normalized = BandwidthSettings::from(&policy);
    let serialized = serde_json::to_string(&normalized).map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,CURRENT_TIMESTAMP)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP",
            params![BANDWIDTH_SETTINGS_KEY, serialized],
        )
        .map_err(|error| error.to_string())?;
    Ok(normalized)
}

trait BandwidthClock: Send + Sync {
    fn elapsed_nanos(&self) -> u128;
    fn sleep(&self, duration: Duration);
}

struct SystemBandwidthClock {
    origin: Instant,
}

impl SystemBandwidthClock {
    fn new() -> Self {
        Self {
            origin: Instant::now(),
        }
    }
}

impl BandwidthClock for SystemBandwidthClock {
    fn elapsed_nanos(&self) -> u128 {
        self.origin.elapsed().as_nanos()
    }

    fn sleep(&self, duration: Duration) {
        thread::sleep(duration);
    }
}

#[derive(Default)]
struct PacingState {
    next_available_nanos: u128,
}

pub(crate) struct BandwidthLimiter {
    bytes_per_second: u64,
    read_grant: usize,
    schedule: Mutex<PacingState>,
    clock: Arc<dyn BandwidthClock>,
}

impl BandwidthLimiter {
    fn new(bytes_per_second: u64) -> Self {
        Self::with_clock(bytes_per_second, Arc::new(SystemBandwidthClock::new()))
    }

    fn with_clock(bytes_per_second: u64, clock: Arc<dyn BandwidthClock>) -> Self {
        // Grant about 25 ms of data per read. This is small enough to smooth
        // low-rate measurements while avoiding scheduler overhead on Windows.
        let read_grant = (bytes_per_second / 40)
            .clamp(MIN_READ_GRANT, MAX_READ_GRANT)
            .min(usize::MAX as u64) as usize;
        Self {
            bytes_per_second,
            read_grant,
            schedule: Mutex::new(PacingState::default()),
            clock,
        }
    }

    pub(crate) fn bytes_per_second(&self) -> u64 {
        self.bytes_per_second
    }

    pub(crate) fn read_grant(&self, requested: usize) -> usize {
        requested.min(self.read_grant)
    }

    pub(crate) fn throttle_bytes<F>(
        &self,
        transferred: usize,
        mut interrupted: F,
    ) -> Result<bool, String>
    where
        F: FnMut() -> Result<bool, String>,
    {
        if transferred == 0 {
            return Ok(true);
        }
        let now = self.clock.elapsed_nanos();
        let wait_until = {
            let mut schedule = self
                .schedule
                .lock()
                .map_err(|_| "No se pudo reservar el límite de velocidad".to_string())?;
            let start = schedule.next_available_nanos.max(now);
            let duration = (transferred as u128)
                .saturating_mul(NANOS_PER_SECOND)
                .div_ceil(u128::from(self.bytes_per_second));
            let end = start.saturating_add(duration);
            schedule.next_available_nanos = end;
            end
        };
        loop {
            if interrupted()? {
                return Ok(false);
            }
            let now = self.clock.elapsed_nanos();
            if now >= wait_until {
                return Ok(true);
            }
            let remaining =
                Duration::from_nanos((wait_until - now).min(u128::from(u64::MAX)) as u64);
            self.clock.sleep(remaining.min(MAX_WAIT_SLICE));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::RANGE;
    use rusqlite::Connection;
    use sha2::{Digest, Sha256};
    use std::{
        ffi::OsString,
        io::{Read, Write},
        net::{TcpListener, TcpStream},
        sync::atomic::{AtomicU64, Ordering},
    };

    #[derive(Default)]
    struct FakeClock {
        nanos: AtomicU64,
    }

    impl BandwidthClock for FakeClock {
        fn elapsed_nanos(&self) -> u128 {
            u128::from(self.nanos.load(Ordering::SeqCst))
        }

        fn sleep(&self, duration: Duration) {
            self.nanos.fetch_add(
                duration.as_nanos().min(u128::from(u64::MAX)) as u64,
                Ordering::SeqCst,
            );
        }
    }

    fn settings_connection() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE settings(
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );",
            )
            .unwrap();
        connection
    }

    fn args(command: &Command) -> Vec<OsString> {
        command.get_args().map(OsString::from).collect()
    }

    fn fixture_bytes(size: usize) -> Vec<u8> {
        (0..size).map(|index| (index % 251) as u8).collect()
    }

    fn read_request(stream: &mut TcpStream) -> String {
        let mut request = Vec::new();
        let mut chunk = [0_u8; 1024];
        while !request.windows(4).any(|window| window == b"\r\n\r\n") {
            let read = stream.read(&mut chunk).unwrap();
            if read == 0 {
                break;
            }
            request.extend_from_slice(&chunk[..read]);
        }
        String::from_utf8_lossy(&request).into_owned()
    }

    fn requested_range(request: &str, total: usize) -> Option<(usize, usize)> {
        request.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            if !name.eq_ignore_ascii_case("range") {
                return None;
            }
            let value = value.trim().strip_prefix("bytes=")?;
            let (start, end) = value.trim().split_once('-')?;
            let start = start.parse::<usize>().ok()?;
            let end = if end.is_empty() {
                total.checked_sub(1)?
            } else {
                end.parse::<usize>().ok()?.min(total.checked_sub(1)?)
            };
            (start <= end).then_some((start, end))
        })
    }

    fn start_range_server(
        body: Arc<Vec<u8>>,
        request_count: usize,
    ) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            for _ in 0..request_count {
                let (mut stream, _) = listener.accept().unwrap();
                let request = read_request(&mut stream);
                let range = requested_range(&request, body.len());
                let (start, end, status) = range
                    .map(|(start, end)| (start, end, "206 Partial Content"))
                    .unwrap_or((0, body.len() - 1, "200 OK"));
                let mut headers = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n",
                    end - start + 1
                );
                if range.is_some() {
                    headers.push_str(&format!(
                        "Content-Range: bytes {start}-{end}/{}\r\n",
                        body.len()
                    ));
                }
                headers.push_str("\r\n");
                stream.write_all(headers.as_bytes()).unwrap();
                stream.write_all(&body[start..=end]).unwrap();
            }
        });
        (format!("http://{address}/fixture.bin"), handle)
    }

    fn fetch_with_limiter(
        url: &str,
        range: Option<(usize, usize)>,
        limiter: Arc<BandwidthLimiter>,
    ) -> Vec<u8> {
        let client = reqwest::blocking::Client::new();
        let mut request = client.get(url);
        if let Some((start, end)) = range {
            request = request.header(RANGE, format!("bytes={start}-{end}"));
        }
        let mut response = request.send().unwrap();
        assert!(response.status().is_success());
        let mut output = Vec::new();
        let mut buffer = [0_u8; 256 * 1024];
        loop {
            let budget = limiter.read_grant(buffer.len());
            let read = response.read(&mut buffer[..budget]).unwrap();
            if read == 0 {
                break;
            }
            assert!(limiter.throttle_bytes(read, || Ok(false)).unwrap());
            output.extend_from_slice(&buffer[..read]);
        }
        output
    }

    fn fetch_unlimited(url: &str) -> Vec<u8> {
        reqwest::blocking::get(url)
            .unwrap()
            .bytes()
            .unwrap()
            .to_vec()
    }

    fn fetch_unlimited_range(url: &str, start: usize, end: usize) -> Vec<u8> {
        reqwest::blocking::Client::new()
            .get(url)
            .header(RANGE, format!("bytes={start}-{end}"))
            .send()
            .unwrap()
            .bytes()
            .unwrap()
            .to_vec()
    }

    fn sha256(bytes: &[u8]) -> Vec<u8> {
        Sha256::digest(bytes).to_vec()
    }

    #[test]
    fn missing_setting_defaults_to_unlimited() {
        let connection = settings_connection();
        assert_eq!(
            read_bandwidth_settings(&connection),
            BandwidthSettings::Unlimited
        );
    }

    #[test]
    fn limited_setting_round_trips_and_rejects_invalid_without_overwrite() {
        let connection = settings_connection();
        let valid = BandwidthSettings::Limited {
            bytes_per_second: 1_000_000,
        };
        assert_eq!(
            persist_bandwidth_settings(&connection, valid.clone()).unwrap(),
            valid
        );
        assert!(persist_bandwidth_settings(
            &connection,
            BandwidthSettings::Limited {
                bytes_per_second: 0
            }
        )
        .is_err());
        assert_eq!(read_bandwidth_settings(&connection), valid);
    }

    #[test]
    fn job_speed_override_is_isolated_and_supports_explicit_unlimited() {
        let connection = settings_connection();
        connection
            .execute_batch(
                "CREATE TABLE jobs(id INTEGER PRIMARY KEY);
                 CREATE TABLE download_speed_limits(
                    job_id INTEGER PRIMARY KEY,
                    bytes_per_second INTEGER NOT NULL,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                 );
                 INSERT INTO jobs(id) VALUES (7), (8);",
            )
            .unwrap();
        persist_bandwidth_settings(
            &connection,
            BandwidthSettings::Limited {
                bytes_per_second: 5_000_000,
            },
        )
        .unwrap();
        persist_job_bandwidth_settings(
            &connection,
            7,
            BandwidthSettings::Limited {
                bytes_per_second: 1_000_000,
            },
        )
        .unwrap();
        assert_eq!(
            read_job_bandwidth_policy(&connection, 7).bytes_per_second(),
            Some(1_000_000)
        );
        assert_eq!(
            read_job_bandwidth_policy(&connection, 8).bytes_per_second(),
            Some(5_000_000)
        );
        persist_job_bandwidth_settings(&connection, 7, BandwidthSettings::Unlimited).unwrap();
        assert_eq!(
            read_job_bandwidth_policy(&connection, 7).bytes_per_second(),
            None
        );
    }

    #[test]
    fn engine_invocations_keep_their_snapshot_and_new_invocations_read_the_update() {
        let connection = settings_connection();
        persist_bandwidth_settings(
            &connection,
            BandwidthSettings::Limited {
                bytes_per_second: 1_000_000,
            },
        )
        .unwrap();
        let active_snapshot = read_bandwidth_policy(&connection);
        persist_bandwidth_settings(
            &connection,
            BandwidthSettings::Limited {
                bytes_per_second: 5_000_000,
            },
        )
        .unwrap();
        let resumed_snapshot = read_bandwidth_policy(&connection);

        assert_eq!(active_snapshot.bytes_per_second(), Some(1_000_000));
        assert_eq!(resumed_snapshot.bytes_per_second(), Some(5_000_000));
    }

    #[test]
    fn corrupt_or_out_of_range_persistence_fails_safe_to_unlimited() {
        let connection = settings_connection();
        for value in [
            "not-json",
            r#"{"mode":"limited","bytesPerSecond":63999}"#,
            r#"{"mode":"limited","bytesPerSecond":10000000001}"#,
        ] {
            connection
                .execute(
                    "INSERT INTO settings(key,value) VALUES(?1,?2)
                     ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    params![BANDWIDTH_SETTINGS_KEY, value],
                )
                .unwrap();
            assert_eq!(
                read_bandwidth_settings(&connection),
                BandwidthSettings::Unlimited
            );
        }
    }

    #[test]
    fn closed_dto_rejects_unknown_fields_floats_and_overflow() {
        for value in [
            r#"{"mode":"unlimited","args":"--danger"}"#,
            r#"{"mode":"limited","bytesPerSecond":1000000.5}"#,
            r#"{"mode":"limited","bytesPerSecond":18446744073709551616}"#,
        ] {
            assert!(serde_json::from_str::<BandwidthSettings>(value).is_err());
        }
    }

    #[test]
    fn product_range_accepts_exact_minimum_and_maximum() {
        for value in [
            MIN_BANDWIDTH_BYTES_PER_SECOND,
            MAX_BANDWIDTH_BYTES_PER_SECOND,
        ] {
            assert!(BandwidthPolicy::try_from(BandwidthSettings::Limited {
                bytes_per_second: value,
            })
            .is_ok());
        }
    }

    #[test]
    fn active_engine_adapters_use_exact_decimal_bytes_and_unlimited_adds_nothing() {
        let limited = BandwidthPolicy::try_from(BandwidthSettings::Limited {
            bytes_per_second: 5_000_000,
        })
        .unwrap();
        let mut yt_dlp = Command::new("yt-dlp");
        limited.apply_to_yt_dlp(&mut yt_dlp);
        assert_eq!(args(&yt_dlp), ["--limit-rate", "5000000"]);
        let mut aria2 = Command::new("aria2c");
        limited.apply_to_aria2(&mut aria2);
        assert_eq!(args(&aria2), ["--max-download-limit=5000000"]);

        let mut unlimited = Command::new("engine");
        BandwidthPolicy::Unlimited.apply_to_yt_dlp(&mut unlimited);
        BandwidthPolicy::Unlimited.apply_to_aria2(&mut unlimited);
        assert!(args(&unlimited).is_empty());
    }

    #[test]
    fn deterministic_shared_limiter_serializes_grants() {
        let clock = Arc::new(FakeClock::default());
        let limiter = BandwidthLimiter::with_clock(1_000_000, clock.clone());
        assert!(limiter.throttle_bytes(50_000, || Ok(false)).unwrap());
        assert_eq!(clock.elapsed_nanos(), 50_000_000);
        assert!(limiter.throttle_bytes(50_000, || Ok(false)).unwrap());
        assert_eq!(clock.elapsed_nanos(), 100_000_000);
        assert!(limiter.throttle_bytes(50_000, || Ok(false)).unwrap());
        assert_eq!(clock.elapsed_nanos(), 150_000_000);
    }

    #[test]
    fn interruption_stops_a_waiting_grant() {
        let clock = Arc::new(FakeClock::default());
        let limiter = BandwidthLimiter::with_clock(1_000_000, clock);
        assert!(limiter.throttle_bytes(50_000, || Ok(false)).unwrap());
        let mut checks = 0;
        let result = limiter
            .throttle_bytes(50_000, || {
                checks += 1;
                Ok(checks >= 2)
            })
            .unwrap();
        assert!(!result);
    }

    #[test]
    fn bandwidth_runtime_sequential_uses_loopback_and_preserves_sha256() {
        let body = Arc::new(fixture_bytes(350_000));
        let expected_hash = sha256(&body);
        let (url, server) = start_range_server(body, 1);
        let started = Instant::now();
        let downloaded = fetch_with_limiter(&url, None, Arc::new(BandwidthLimiter::new(1_000_000)));
        let elapsed = started.elapsed();
        server.join().unwrap();
        assert_eq!(sha256(&downloaded), expected_hash);
        let measured = downloaded.len() as f64 / elapsed.as_secs_f64();
        eprintln!("BANDWIDTH_RUNTIME sequential_1mbps={measured:.0} B/s elapsed={elapsed:?}");
        assert!(elapsed >= Duration::from_millis(240), "elapsed={elapsed:?}");
        assert!(elapsed <= Duration::from_secs(2), "elapsed={elapsed:?}");
    }

    #[test]
    fn bandwidth_runtime_segmented_shares_one_budget_and_preserves_sha256() {
        let body = Arc::new(fixture_bytes(400_000));
        let expected_hash = sha256(&body);
        let (url, server) = start_range_server(body, 4);
        let limiter = Arc::new(BandwidthLimiter::new(1_000_000));
        let started = Instant::now();
        let parts = thread::scope(|scope| {
            let mut handles = Vec::new();
            for index in 0..4 {
                let url = url.clone();
                let limiter = limiter.clone();
                handles.push(scope.spawn(move || {
                    fetch_with_limiter(
                        &url,
                        Some((index * 100_000, (index + 1) * 100_000 - 1)),
                        limiter,
                    )
                }));
            }
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .collect::<Vec<_>>()
        });
        let elapsed = started.elapsed();
        server.join().unwrap();
        let downloaded = parts.into_iter().flatten().collect::<Vec<_>>();
        assert_eq!(sha256(&downloaded), expected_hash);
        let measured = downloaded.len() as f64 / elapsed.as_secs_f64();
        eprintln!("BANDWIDTH_RUNTIME segmented_shared_1mbps={measured:.0} B/s elapsed={elapsed:?}");
        assert!(elapsed >= Duration::from_millis(280), "elapsed={elapsed:?}");
        assert!(elapsed <= Duration::from_secs(2), "elapsed={elapsed:?}");
    }

    #[test]
    fn bandwidth_runtime_two_and_three_downloads_each_receive_per_download_budget() {
        for task_count in [2, 3] {
            let body = Arc::new(fixture_bytes(350_000));
            let expected_hash = sha256(&body);
            let (url, server) = start_range_server(body, task_count);
            let started = Instant::now();
            let results = thread::scope(|scope| {
                let mut handles = Vec::new();
                for _ in 0..task_count {
                    let url = url.clone();
                    handles.push(scope.spawn(move || {
                        fetch_with_limiter(&url, None, Arc::new(BandwidthLimiter::new(1_000_000)))
                    }));
                }
                handles
                    .into_iter()
                    .map(|handle| handle.join().unwrap())
                    .collect::<Vec<_>>()
            });
            let elapsed = started.elapsed();
            server.join().unwrap();
            assert!(results.iter().all(|value| sha256(value) == expected_hash));
            let per_download = results[0].len() as f64 / elapsed.as_secs_f64();
            eprintln!(
                "BANDWIDTH_RUNTIME concurrent_{task_count}x1mbps_each={per_download:.0} B/s elapsed={elapsed:?}"
            );
            assert!(elapsed >= Duration::from_millis(240), "elapsed={elapsed:?}");
            assert!(elapsed <= Duration::from_millis(900), "elapsed={elapsed:?}");
        }
    }

    #[test]
    fn bandwidth_runtime_unlimited_and_five_megabytes_per_second() {
        let body = Arc::new(fixture_bytes(5_250_000));
        let expected_hash = sha256(&body);
        let (limited_url, limited_server) = start_range_server(body.clone(), 1);
        let limited_started = Instant::now();
        let limited = fetch_with_limiter(
            &limited_url,
            None,
            Arc::new(BandwidthLimiter::new(5_000_000)),
        );
        let limited_elapsed = limited_started.elapsed();
        limited_server.join().unwrap();
        assert_eq!(sha256(&limited), expected_hash);
        let measured = limited.len() as f64 / limited_elapsed.as_secs_f64();
        eprintln!(
            "BANDWIDTH_RUNTIME sequential_5mbps={measured:.0} B/s elapsed={limited_elapsed:?}"
        );
        assert!(
            (4_500_000.0..=6_500_000.0).contains(&measured),
            "measured={measured}"
        );

        let (unlimited_url, unlimited_server) = start_range_server(body, 1);
        let unlimited_started = Instant::now();
        let unlimited = fetch_unlimited(&unlimited_url);
        let unlimited_elapsed = unlimited_started.elapsed();
        unlimited_server.join().unwrap();
        assert_eq!(sha256(&unlimited), expected_hash);
        eprintln!(
            "BANDWIDTH_RUNTIME unlimited_bytes={} elapsed={unlimited_elapsed:?}",
            unlimited.len()
        );
        assert!(unlimited_elapsed < limited_elapsed);
    }

    #[test]
    fn bandwidth_runtime_segmented_unlimited_and_five_megabytes_per_second() {
        let body = Arc::new(fixture_bytes(5_250_000));
        let expected_hash = sha256(&body);
        let part_size = body.len() / 4;
        let ranges = (0..4)
            .map(|index| {
                let start = index * part_size;
                let end = if index == 3 {
                    body.len() - 1
                } else {
                    (index + 1) * part_size - 1
                };
                (start, end)
            })
            .collect::<Vec<_>>();

        let (limited_url, limited_server) = start_range_server(body.clone(), ranges.len());
        let limiter = Arc::new(BandwidthLimiter::new(5_000_000));
        let limited_started = Instant::now();
        let limited_parts = thread::scope(|scope| {
            ranges
                .iter()
                .copied()
                .map(|range| {
                    let url = limited_url.clone();
                    let limiter = limiter.clone();
                    scope.spawn(move || fetch_with_limiter(&url, Some(range), limiter))
                })
                .collect::<Vec<_>>()
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .collect::<Vec<_>>()
        });
        let limited_elapsed = limited_started.elapsed();
        limited_server.join().unwrap();
        let limited = limited_parts.into_iter().flatten().collect::<Vec<_>>();
        assert_eq!(sha256(&limited), expected_hash);
        let measured = limited.len() as f64 / limited_elapsed.as_secs_f64();
        eprintln!(
            "BANDWIDTH_RUNTIME segmented_shared_5mbps={measured:.0} B/s elapsed={limited_elapsed:?}"
        );
        assert!(
            (4_500_000.0..=6_500_000.0).contains(&measured),
            "measured={measured}"
        );

        let (unlimited_url, unlimited_server) = start_range_server(body, ranges.len());
        let unlimited_started = Instant::now();
        let unlimited_parts = thread::scope(|scope| {
            ranges
                .iter()
                .copied()
                .map(|(start, end)| {
                    let url = unlimited_url.clone();
                    scope.spawn(move || fetch_unlimited_range(&url, start, end))
                })
                .collect::<Vec<_>>()
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .collect::<Vec<_>>()
        });
        let unlimited_elapsed = unlimited_started.elapsed();
        unlimited_server.join().unwrap();
        let unlimited = unlimited_parts.into_iter().flatten().collect::<Vec<_>>();
        assert_eq!(sha256(&unlimited), expected_hash);
        eprintln!(
            "BANDWIDTH_RUNTIME segmented_unlimited_bytes={} elapsed={unlimited_elapsed:?}",
            unlimited.len()
        );
        assert!(unlimited_elapsed < limited_elapsed);
    }
}
