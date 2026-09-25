#![allow(clippy::items_after_test_module)]

use crate::{
    chaos, configure_connection, downloads, media, DownloadConcurrencySettings,
    ExternalProcessRegistry, MediaRuntimePaths, WorkerCompletion,
};
use rusqlite::{params, Connection};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tokio::sync::mpsc;

const DISPATCHER_RECONCILIATION_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Clone)]
pub(crate) struct DispatcherContext {
    pub(crate) db_path: PathBuf,
    pub(crate) active_downloads: Arc<Mutex<HashSet<i64>>>,
    pub(crate) active_media_pids: Arc<Mutex<std::collections::HashMap<i64, u32>>>,
    pub(crate) external_processes: ExternalProcessRegistry,
    pub(crate) media_runtime: Option<MediaRuntimePaths>,
}

#[derive(Clone, Copy)]
enum DispatchKind {
    Http,
    Media,
}

enum DispatcherEvent {
    Wake,
}

#[derive(Debug)]
struct DynamicSlotState {
    limit: usize,
    active: usize,
}

#[derive(Debug)]
struct DynamicSlotGate {
    state: Mutex<DynamicSlotState>,
}

impl DynamicSlotGate {
    fn new(limit: usize) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(DynamicSlotState { limit, active: 0 }),
        })
    }

    fn try_acquire(self: &Arc<Self>) -> Option<DynamicSlotPermit> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.active >= state.limit {
            return None;
        }
        state.active += 1;
        Some(DynamicSlotPermit { gate: self.clone() })
    }

    fn set_limit(&self, limit: usize) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.limit = limit;
    }

    #[cfg(test)]
    fn snapshot(&self) -> (usize, usize) {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        (state.limit, state.active)
    }
}

struct DynamicSlotPermit {
    gate: Arc<DynamicSlotGate>,
}

impl Drop for DynamicSlotPermit {
    fn drop(&mut self) {
        let mut state = self
            .gate
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.active = state.active.saturating_sub(1);
    }
}

pub(crate) struct DownloadDispatcher {
    tx: mpsc::UnboundedSender<DispatcherEvent>,
    http_slots: Arc<DynamicSlotGate>,
    media_slots: Arc<DynamicSlotGate>,
    media_sessions: Arc<Mutex<HashMap<i64, media::MediaSessionOptions>>>,
}

static GLOBAL_DISPATCHER: OnceLock<Arc<DownloadDispatcher>> = OnceLock::new();

impl DownloadDispatcher {
    pub(crate) fn start(
        context: DispatcherContext,
        concurrency: DownloadConcurrencySettings,
    ) -> Arc<Self> {
        let (tx, rx) = mpsc::unbounded_channel();
        let dispatcher = Arc::new(Self {
            tx,
            http_slots: DynamicSlotGate::new(usize::from(concurrency.http)),
            media_slots: DynamicSlotGate::new(usize::from(concurrency.multimedia)),
            media_sessions: Arc::new(Mutex::new(HashMap::new())),
        });
        let runner = dispatcher.clone();
        tauri::async_runtime::spawn(async move {
            runner.run(rx, context).await;
        });
        dispatcher
    }

    pub(crate) fn wake(&self) {
        let _ = self.tx.send(DispatcherEvent::Wake);
    }

    pub(crate) fn update_concurrency(&self, concurrency: DownloadConcurrencySettings) {
        self.http_slots.set_limit(usize::from(concurrency.http));
        self.media_slots
            .set_limit(usize::from(concurrency.multimedia));
        self.wake();
    }

    pub(crate) fn register_media_session(&self, job_id: i64, session: media::MediaSessionOptions) {
        if let Ok(mut sessions) = self.media_sessions.lock() {
            sessions.insert(job_id, session);
        }
        self.wake();
    }

    fn take_media_session(&self, job_id: i64) -> media::MediaSessionOptions {
        self.media_sessions
            .lock()
            .ok()
            .and_then(|mut sessions| sessions.remove(&job_id))
            .unwrap_or_default()
    }

    async fn run(
        self: Arc<Self>,
        mut rx: mpsc::UnboundedReceiver<DispatcherEvent>,
        context: DispatcherContext,
    ) {
        let tick_period = Duration::from_millis(16);
        let mut next_tick = Instant::now() + tick_period;
        let mut next_reconciliation = Instant::now();
        loop {
            let wait = next_tick.saturating_duration_since(Instant::now());
            match tokio::time::timeout(wait, rx.recv()).await {
                Ok(Some(_)) => self.drain(&context).await,
                Ok(None) => break,
                Err(_) => {
                    let now = Instant::now();
                    if now >= next_reconciliation {
                        // A queued job must not depend forever on a single
                        // wake event. This low-frequency reconciliation only
                        // claims queued work; it does not alter any worker or
                        // media extraction policy.
                        self.drain(&context).await;
                        next_reconciliation = now + DISPATCHER_RECONCILIATION_INTERVAL;
                    }
                    let lag = now.saturating_duration_since(next_tick);
                    if lag > tick_period {
                        chaos::record_dispatcher_lag(context.db_path.clone(), lag);
                    }
                    next_tick = Instant::now() + tick_period;
                }
            }
        }
    }

    async fn drain(&self, context: &DispatcherContext) {
        loop {
            let mut started = false;
            if self.try_start(DispatchKind::Http, context).await {
                started = true;
            }
            if self.try_start(DispatchKind::Media, context).await {
                started = true;
            }
            if !started {
                break;
            }
        }
    }

    async fn try_start(&self, kind: DispatchKind, context: &DispatcherContext) -> bool {
        let permit = match kind {
            DispatchKind::Http => self.http_slots.try_acquire(),
            DispatchKind::Media => self.media_slots.try_acquire(),
        };
        let Some(permit) = permit else {
            return false;
        };
        if matches!(kind, DispatchKind::Media) && context.media_runtime.is_none() {
            drop(permit);
            return false;
        }

        let database_context = context.clone();
        let claimed =
            tauri::async_runtime::spawn_blocking(move || claim_next_job(kind, &database_context))
                .await
                .ok()
                .and_then(Result::ok)
                .flatten();
        let Some(job_id) = claimed else {
            drop(permit);
            return false;
        };

        match kind {
            DispatchKind::Http => self.launch_http(context, job_id, permit),
            DispatchKind::Media => self.launch_media(context, job_id, permit),
        }
        true
    }

    fn launch_http(&self, context: &DispatcherContext, job_id: i64, permit: DynamicSlotPermit) {
        let dispatcher = global().unwrap_or_else(|| {
            panic!("el dispatcher global debe estar instalado antes de iniciar workers")
        });
        let completion_dispatcher = dispatcher.clone();
        let completion: WorkerCompletion = Box::new(move || {
            drop(permit);
            completion_dispatcher.wake();
        });
        let _ = downloads::run_download_worker_with_completion(
            context.db_path.clone(),
            context.active_downloads.clone(),
            job_id,
            Some(completion),
        );
    }

    fn launch_media(&self, context: &DispatcherContext, job_id: i64, permit: DynamicSlotPermit) {
        let Some(runtime) = context.media_runtime.clone() else {
            drop(permit);
            return;
        };
        let dispatcher = global().unwrap_or_else(|| {
            panic!("el dispatcher global debe estar instalado antes de iniciar workers")
        });
        let completion_dispatcher = dispatcher.clone();
        let completion: WorkerCompletion = Box::new(move || {
            drop(permit);
            completion_dispatcher.wake();
        });
        let session = dispatcher.take_media_session(job_id);
        let _ = media::run_media_worker_with_completion_options(
            context.db_path.clone(),
            runtime,
            context.active_media_pids.clone(),
            context.external_processes.clone(),
            job_id,
            session,
            Some(completion),
        );
    }
}

pub(crate) fn install_global(dispatcher: Arc<DownloadDispatcher>) {
    let _ = GLOBAL_DISPATCHER.set(dispatcher);
}

pub(crate) fn global() -> Option<Arc<DownloadDispatcher>> {
    GLOBAL_DISPATCHER.get().cloned()
}

pub(crate) fn wake_if_installed() -> bool {
    let Some(dispatcher) = global() else {
        return false;
    };
    dispatcher.wake();
    true
}

pub(crate) fn register_media_session(job_id: i64, session: media::MediaSessionOptions) -> bool {
    let Some(dispatcher) = global() else {
        return false;
    };
    dispatcher.register_media_session(job_id, session);
    true
}

fn claim_next_job(kind: DispatchKind, context: &DispatcherContext) -> Result<Option<i64>, String> {
    let mut connection = Connection::open(&context.db_path).map_err(|error| error.to_string())?;
    configure_connection(&connection).map_err(|error| error.to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let ids = candidate_ids(&transaction, kind)?;
    for job_id in ids {
        if is_active(kind, context, job_id) {
            continue;
        }
        let changed = transaction
            .execute(
                "UPDATE jobs SET status='running',detail=?1,updated_at=CURRENT_TIMESTAMP WHERE id=?2 AND status IN ('queued','running')",
                params![
                    match kind {
                        DispatchKind::Http => "Preparando conexión HTTP…",
                        DispatchKind::Media => "Preparando descarga multimedia…",
                    },
                    job_id
                ],
            )
            .map_err(|error| error.to_string())?;
        if changed == 0 {
            continue;
        }
        if matches!(kind, DispatchKind::Media) {
            transaction
                .execute(
                    "UPDATE playlist_items SET status='running' WHERE job_id=?1 AND status IN ('queued','running')",
                    params![job_id],
                )
                .map_err(|error| error.to_string())?;
            transaction
                .execute(
                    "UPDATE playlist_batches SET status='running',current_position=(SELECT MIN(position) FROM playlist_items WHERE job_id=?1 AND status='running'),updated_at=CURRENT_TIMESTAMP WHERE id=(SELECT playlist_batch_id FROM media_jobs WHERE job_id=?1)",
                    params![job_id],
                )
                .map_err(|error| error.to_string())?;
        }
        transaction.commit().map_err(|error| error.to_string())?;
        return Ok(Some(job_id));
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(None)
}

fn candidate_ids(
    transaction: &rusqlite::Transaction<'_>,
    kind: DispatchKind,
) -> Result<Vec<i64>, String> {
    let sql = match kind {
        DispatchKind::Http => {
            "SELECT jobs.id FROM jobs JOIN download_jobs ON download_jobs.job_id=jobs.id LEFT JOIN media_jobs ON media_jobs.job_id=jobs.id LEFT JOIN torrent_jobs ON torrent_jobs.job_id=jobs.id WHERE jobs.status IN ('queued','running') AND media_jobs.job_id IS NULL AND torrent_jobs.job_id IS NULL ORDER BY CASE lower(COALESCE(jobs.priority,'normal')) WHEN 'high' THEN 0 WHEN 'low' THEN 2 ELSE 1 END, jobs.id LIMIT 64"
        }
        DispatchKind::Media => {
            "SELECT job_id FROM (
                SELECT jobs.id AS job_id,
                       CASE lower(COALESCE(jobs.priority,'normal')) WHEN 'high' THEN 0 WHEN 'low' THEN 2 ELSE 1 END AS priority_rank,
                       jobs.id AS enqueue_order
                  FROM jobs
                  JOIN media_jobs ON media_jobs.job_id=jobs.id
                 WHERE jobs.status IN ('queued','running')
                   AND media_jobs.playlist_batch_id IS NULL
                UNION ALL
                SELECT jobs.id AS job_id,
                       CASE lower(COALESCE(jobs.priority,'normal')) WHEN 'high' THEN 0 WHEN 'low' THEN 2 ELSE 1 END AS priority_rank,
                       jobs.id AS enqueue_order
                  FROM jobs
                  JOIN media_jobs ON media_jobs.job_id=jobs.id
                  JOIN playlist_items ON playlist_items.job_id=jobs.id
                 WHERE jobs.status IN ('queued','running')
                   AND media_jobs.playlist_batch_id IS NOT NULL
                   AND playlist_items.position=(
                       SELECT MIN(candidate.position)
                         FROM playlist_items candidate
                         JOIN jobs candidate_job ON candidate_job.id=candidate.job_id
                        WHERE candidate.batch_id=playlist_items.batch_id
                          AND candidate_job.status IN ('queued','running')
                   )
            ) ORDER BY priority_rank,enqueue_order LIMIT 64"
        }
    };
    let mut statement = transaction
        .prepare(sql)
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, i64>(0))
        .map_err(|error| error.to_string())?;
    let ids = rows.flatten().collect::<Vec<_>>();
    drop(statement);
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migrate;
    use sha2::{Digest, Sha256};
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::atomic::{AtomicUsize, Ordering},
        thread,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };

    fn database() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        connection
    }

    fn add_job(connection: &Connection, priority: &str, status: &str) -> i64 {
        connection
            .execute(
                "INSERT INTO jobs(title,status,priority) VALUES(?1,?2,?3)",
                params![format!("{priority}-{status}"), status, priority],
            )
            .unwrap();
        connection.last_insert_rowid()
    }

    fn add_http(connection: &Connection, priority: &str, status: &str) -> i64 {
        let id = add_job(connection, priority, status);
        connection
            .execute(
                "INSERT INTO download_jobs(job_id,url,destination,temp_path) VALUES(?1,?2,?3,?4)",
                params![
                    id,
                    format!("https://example.invalid/{id}"),
                    format!("file-{id}"),
                    format!("file-{id}.part")
                ],
            )
            .unwrap();
        id
    }

    fn add_http_url(connection: &Connection, priority: &str, status: &str, url: &str) -> i64 {
        let id = add_job(connection, priority, status);
        connection
            .execute(
                "INSERT INTO download_jobs(job_id,url,destination,temp_path) VALUES(?1,?2,?3,?4)",
                params![
                    id,
                    url,
                    format!("priority-{id}.bin"),
                    format!("priority-{id}.bin.part")
                ],
            )
            .unwrap();
        id
    }

    fn loopback_fixture(body: Vec<u8>, requests: usize) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let worker = thread::spawn(move || {
            for _ in 0..requests {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0_u8; 2048];
                let _ = stream.read(&mut request);
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .unwrap();
                stream.write_all(&body).unwrap();
                stream.flush().unwrap();
            }
        });
        (format!("http://{address}/priority-fixture.bin"), worker)
    }

    fn concurrent_loopback_fixture(
        body: Vec<u8>,
        requests: usize,
    ) -> (String, thread::JoinHandle<()>, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let reported_maximum = maximum.clone();
        let worker = thread::spawn(move || {
            let mut handlers = Vec::new();
            for _ in 0..requests {
                let (mut stream, _) = listener.accept().unwrap();
                let body = body.clone();
                let active = active.clone();
                let maximum = maximum.clone();
                handlers.push(thread::spawn(move || {
                    let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                    maximum.fetch_max(current, Ordering::SeqCst);
                    let mut request = [0_u8; 2048];
                    let _ = stream.read(&mut request);
                    thread::sleep(Duration::from_millis(25));
                    write!(
                        stream,
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    )
                    .unwrap();
                    stream.write_all(&body).unwrap();
                    stream.flush().unwrap();
                    active.fetch_sub(1, Ordering::SeqCst);
                }));
            }
            for handler in handlers {
                handler.join().unwrap();
            }
        });
        (
            format!("http://{address}/concurrency-fixture.bin"),
            worker,
            reported_maximum,
        )
    }

    fn run_concurrency_loopback(limit: usize, requests: usize) -> usize {
        let body = (0..65_536_u32)
            .map(|value| (value % 251) as u8)
            .collect::<Vec<_>>();
        let expected_hash = Sha256::digest(&body).to_vec();
        let (url, server, maximum) = concurrent_loopback_fixture(body, requests);
        let gate = DynamicSlotGate::new(limit);
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let mut started = 0;
        let mut completed = 0;
        while completed < requests {
            while started < requests {
                let Some(permit) = gate.try_acquire() else {
                    break;
                };
                let client_url = url.clone();
                let expected_hash = expected_hash.clone();
                let done_tx = done_tx.clone();
                thread::spawn(move || {
                    let bandwidth = downloads::BandwidthPolicy::try_from(
                        downloads::BandwidthSettings::Limited {
                            bytes_per_second: downloads::MAX_BANDWIDTH_BYTES_PER_SECOND,
                        },
                    )
                    .unwrap()
                    .limiter()
                    .unwrap();
                    let downloaded = reqwest::blocking::get(client_url).unwrap().bytes().unwrap();
                    assert_eq!(Sha256::digest(&downloaded).to_vec(), expected_hash);
                    assert!(bandwidth
                        .throttle_bytes(downloaded.len(), || Ok(false))
                        .unwrap());
                    drop(permit);
                    done_tx.send(()).unwrap();
                });
                started += 1;
            }
            done_rx.recv().unwrap();
            completed += 1;
        }
        server.join().unwrap();
        assert_eq!(gate.snapshot(), (limit, 0));
        maximum.load(Ordering::SeqCst)
    }

    fn add_media(connection: &Connection, priority: &str) -> i64 {
        let id = add_job(connection, priority, "queued");
        connection
            .execute(
                "INSERT INTO media_jobs(job_id,source_url,format_selector,output_mode,destination_dir) VALUES(?1,?2,'best','video_mp4','media')",
                params![id, format!("https://example.invalid/{id}")],
            )
            .unwrap();
        id
    }

    #[test]
    fn concurrency_runtime_http_enforces_one_two_and_four_slots_with_sha256_integrity() {
        for limit in [1, 2, 4] {
            let observed = run_concurrency_loopback(limit, 4);
            println!(
                "CONCURRENCY_RUNTIME http_limit={limit} observed_max={observed} sha256=preserved"
            );
            assert_eq!(observed, limit);
        }
    }

    #[test]
    fn concurrency_runtime_reduction_keeps_active_work_and_increase_opens_slots() {
        let gate = DynamicSlotGate::new(4);
        let mut active = (0..4)
            .map(|_| gate.try_acquire().expect("initial active slot"))
            .collect::<Vec<_>>();
        gate.set_limit(2);
        assert_eq!(gate.snapshot(), (2, 4));
        assert!(gate.try_acquire().is_none());
        drop(active.pop());
        drop(active.pop());
        assert_eq!(gate.snapshot(), (2, 2));
        assert!(gate.try_acquire().is_none());
        drop(active.pop());
        let replacement = gate
            .try_acquire()
            .expect("slot after active falls below limit");
        assert_eq!(gate.snapshot(), (2, 2));
        drop(replacement);
        drop(active);

        let gate = DynamicSlotGate::new(1);
        let first = gate.try_acquire().unwrap();
        gate.set_limit(4);
        let added = (0..3)
            .map(|_| gate.try_acquire().expect("newly available slot"))
            .collect::<Vec<_>>();
        assert_eq!(gate.snapshot(), (4, 4));
        assert!(gate.try_acquire().is_none());
        drop(added);
        drop(first);
        assert_eq!(gate.snapshot(), (4, 0));
    }

    #[test]
    fn concurrency_runtime_media_one_and_two_slots_are_independent_from_http() {
        let http = DynamicSlotGate::new(4);
        let media = DynamicSlotGate::new(1);
        let http_permits = (0..4)
            .map(|_| http.try_acquire().unwrap())
            .collect::<Vec<_>>();
        let media_first = media.try_acquire().unwrap();
        assert!(media.try_acquire().is_none());
        media.set_limit(2);
        let media_second = media.try_acquire().expect("second media slot");
        assert!(media.try_acquire().is_none());
        assert_eq!(http.snapshot(), (4, 4));
        assert_eq!(media.snapshot(), (2, 2));
        drop(media_second);
        drop(media_first);
        drop(http_permits);

        let connection = database();
        let normal = add_media(&connection, "normal");
        let high = add_media(&connection, "high");
        let low = add_media(&connection, "low");
        let mut connection = connection;
        let transaction = connection.transaction().unwrap();
        assert_eq!(
            candidate_ids(&transaction, DispatchKind::Media).unwrap(),
            vec![high, normal, low]
        );
    }

    #[test]
    fn concurrency_runtime_priority_controls_each_new_http_slot() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "cacatools-concurrency-priority-{}-{nonce}.sqlite",
            std::process::id()
        ));
        let (low, high_1, normal, high_2) = {
            let connection = Connection::open(&path).unwrap();
            migrate(&connection).unwrap();
            (
                add_http(&connection, "low", "queued"),
                add_http(&connection, "high", "queued"),
                add_http(&connection, "normal", "queued"),
                add_http(&connection, "high", "queued"),
            )
        };
        let active_downloads = Arc::new(Mutex::new(HashSet::new()));
        let context = DispatcherContext {
            db_path: path.clone(),
            active_downloads: active_downloads.clone(),
            active_media_pids: Arc::new(Mutex::new(HashMap::new())),
            external_processes: Arc::new(Mutex::new(HashMap::new())),
            media_runtime: None,
        };
        let gate = DynamicSlotGate::new(2);
        let first_permit = gate.try_acquire().unwrap();
        let first = claim_next_job(DispatchKind::Http, &context)
            .unwrap()
            .unwrap();
        active_downloads.lock().unwrap().insert(first);
        let second_permit = gate.try_acquire().unwrap();
        let second = claim_next_job(DispatchKind::Http, &context)
            .unwrap()
            .unwrap();
        active_downloads.lock().unwrap().insert(second);
        assert_eq!([first, second], [high_1, high_2]);
        assert!(gate.try_acquire().is_none());

        active_downloads.lock().unwrap().remove(&first);
        Connection::open(&path)
            .unwrap()
            .execute(
                "UPDATE jobs SET status='completed' WHERE id=?1",
                params![first],
            )
            .unwrap();
        drop(first_permit);
        let third_permit = gate.try_acquire().unwrap();
        let third = claim_next_job(DispatchKind::Http, &context)
            .unwrap()
            .unwrap();
        assert_eq!(third, normal);
        assert_ne!(third, low);

        drop(third_permit);
        drop(second_permit);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
    }

    #[test]
    fn concurrency_runtime_pause_resume_retry_and_restart_keep_the_configured_limit() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "cacatools-concurrency-lifecycle-{}-{nonce}.sqlite",
            std::process::id()
        ));
        let (paused, retry, normal) = {
            let connection = Connection::open(&path).unwrap();
            migrate(&connection).unwrap();
            downloads::persist_download_concurrency_settings(
                &connection,
                DownloadConcurrencySettings {
                    http: 1,
                    multimedia: 1,
                },
            )
            .unwrap();
            (
                add_http(&connection, "high", "paused"),
                add_http(&connection, "high", "failed"),
                add_http(&connection, "normal", "queued"),
            )
        };
        let active_downloads = Arc::new(Mutex::new(HashSet::new()));
        let context = DispatcherContext {
            db_path: path.clone(),
            active_downloads: active_downloads.clone(),
            active_media_pids: Arc::new(Mutex::new(HashMap::new())),
            external_processes: Arc::new(Mutex::new(HashMap::new())),
            media_runtime: None,
        };
        let gate = DynamicSlotGate::new(1);
        let first_permit = gate.try_acquire().unwrap();
        let first = claim_next_job(DispatchKind::Http, &context)
            .unwrap()
            .unwrap();
        assert_eq!(first, normal);
        active_downloads.lock().unwrap().insert(first);
        assert!(gate.try_acquire().is_none());
        Connection::open(&path)
            .unwrap()
            .execute(
                "UPDATE jobs SET status='completed' WHERE id=?1",
                params![first],
            )
            .unwrap();
        active_downloads.lock().unwrap().remove(&first);
        drop(first_permit);

        {
            let connection = Connection::open(&path).unwrap();
            migrate(&connection).unwrap();
            assert_eq!(
                downloads::read_download_concurrency_settings(&connection),
                DownloadConcurrencySettings {
                    http: 1,
                    multimedia: 1,
                }
            );
            connection
                .execute(
                    "UPDATE jobs SET status='queued' WHERE id IN (?1,?2)",
                    params![paused, retry],
                )
                .unwrap();
        }
        let resumed_permit = gate.try_acquire().unwrap();
        let resumed = claim_next_job(DispatchKind::Http, &context)
            .unwrap()
            .unwrap();
        assert_eq!(resumed, paused);
        active_downloads.lock().unwrap().insert(resumed);
        assert!(gate.try_acquire().is_none());
        Connection::open(&path)
            .unwrap()
            .execute(
                "UPDATE jobs SET status='completed' WHERE id=?1",
                params![resumed],
            )
            .unwrap();
        active_downloads.lock().unwrap().remove(&resumed);
        drop(resumed_permit);

        let retry_permit = gate.try_acquire().unwrap();
        assert_eq!(
            claim_next_job(DispatchKind::Http, &context).unwrap(),
            Some(retry)
        );
        drop(retry_permit);

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
    }

    #[test]
    fn http_candidates_use_strict_priority_and_stable_fifo() {
        let mut connection = database();
        let normal_1 = add_http(&connection, "normal", "queued");
        let high_1 = add_http(&connection, "high", "queued");
        let normal_2 = add_http(&connection, "normal", "queued");
        let high_2 = add_http(&connection, "high", "queued");
        let low_1 = add_http(&connection, "low", "queued");
        let transaction = connection.transaction().unwrap();
        let ids = candidate_ids(&transaction, DispatchKind::Http).unwrap();
        assert_eq!(ids, vec![high_1, high_2, normal_1, normal_2, low_1]);
    }

    #[test]
    fn cancelled_and_completed_jobs_are_not_candidates() {
        let mut connection = database();
        let active = add_http(&connection, "normal", "queued");
        add_http(&connection, "high", "cancelled");
        add_http(&connection, "high", "completed");
        let transaction = connection.transaction().unwrap();
        assert_eq!(
            candidate_ids(&transaction, DispatchKind::Http).unwrap(),
            vec![active]
        );
    }

    #[test]
    fn media_exposes_only_first_playlist_position_and_compares_with_standalone() {
        let mut connection = database();
        let standalone = add_media(&connection, "normal");
        connection
            .execute(
                "INSERT INTO playlist_batches(title,format,priority) VALUES('list','video','high')",
                [],
            )
            .unwrap();
        let batch_id = connection.last_insert_rowid();
        let mut children = Vec::new();
        for position in 0..2 {
            let id = add_job(&connection, "high", "queued");
            connection
                .execute(
                    "INSERT INTO playlist_items(batch_id,source_id,position,job_id) VALUES(?1,?2,?3,?4)",
                    params![batch_id, format!("item-{position}"), position, id],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO media_jobs(job_id,source_url,format_selector,output_mode,destination_dir,playlist_batch_id,playlist_item_id) VALUES(?1,?2,'best','video_mp4','media',?3,(SELECT id FROM playlist_items WHERE job_id=?1))",
                    params![id, format!("https://example.invalid/{id}"), batch_id],
                )
                .unwrap();
            children.push(id);
        }
        let transaction = connection.transaction().unwrap();
        assert_eq!(
            candidate_ids(&transaction, DispatchKind::Media).unwrap(),
            vec![children[0], standalone]
        );
    }

    #[test]
    fn promoted_and_demoted_waiting_jobs_change_the_next_claim_without_new_ids() {
        let mut connection = database();
        let first = add_http(&connection, "low", "queued");
        let second = add_http(&connection, "normal", "queued");
        connection
            .execute(
                "UPDATE jobs SET priority='high' WHERE id=?1",
                params![first],
            )
            .unwrap();
        {
            let transaction = connection.transaction().unwrap();
            assert_eq!(
                candidate_ids(&transaction, DispatchKind::Http).unwrap()[0],
                first
            );
        }
        connection
            .execute("UPDATE jobs SET priority='low' WHERE id=?1", params![first])
            .unwrap();
        let transaction = connection.transaction().unwrap();
        assert_eq!(
            candidate_ids(&transaction, DispatchKind::Http).unwrap()[0],
            second
        );
    }

    #[test]
    fn priority_runtime_active_job_is_not_preempted_and_free_slots_claim_high_before_normal() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "cacatools-dispatch-priority-{}-{nonce}.sqlite",
            std::process::id()
        ));
        let (active_normal, high, waiting_normal) = {
            let connection = Connection::open(&path).unwrap();
            migrate(&connection).unwrap();
            let active_normal = add_http(&connection, "normal", "running");
            let high = add_http(&connection, "high", "queued");
            let waiting_normal = add_http(&connection, "normal", "queued");
            (active_normal, high, waiting_normal)
        };
        let active_downloads = Arc::new(Mutex::new(HashSet::from([active_normal])));
        let context = DispatcherContext {
            db_path: path.clone(),
            active_downloads: active_downloads.clone(),
            active_media_pids: Arc::new(Mutex::new(HashMap::new())),
            external_processes: Arc::new(Mutex::new(HashMap::new())),
            media_runtime: None,
        };
        assert_eq!(
            claim_next_job(DispatchKind::Http, &context).unwrap(),
            Some(high)
        );
        active_downloads.lock().unwrap().insert(high);
        assert_eq!(
            claim_next_job(DispatchKind::Http, &context).unwrap(),
            Some(waiting_normal)
        );
        let connection = Connection::open(&path).unwrap();
        let active_status: String = connection
            .query_row(
                "SELECT status FROM jobs WHERE id=?1",
                params![active_normal],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(active_status, "running");
        drop(connection);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
    }

    #[test]
    fn priority_runtime_http_loopback_restart_lifecycle_and_sha256() {
        let body = (0..131_072_u32)
            .map(|value| (value % 251) as u8)
            .collect::<Vec<_>>();
        let expected_hash = Sha256::digest(&body).to_vec();
        let (url, server) = loopback_fixture(body, 7);
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "cacatools-priority-runtime-{}-{nonce}.sqlite",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let connection = Connection::open(&path).unwrap();
        migrate(&connection).unwrap();

        let occupied_1 = add_http_url(&connection, "normal", "running", &url);
        let occupied_2 = add_http_url(&connection, "normal", "running", &url);
        let low_1 = add_http_url(&connection, "low", "queued", &url);
        let high_1 = add_http_url(&connection, "high", "queued", &url);
        let normal_1 = add_http_url(&connection, "normal", "queued", &url);
        let high_2 = add_http_url(&connection, "high", "queued", &url);
        let active_downloads = Arc::new(Mutex::new(HashSet::from([occupied_1, occupied_2])));
        let context = DispatcherContext {
            db_path: path.clone(),
            active_downloads: active_downloads.clone(),
            active_media_pids: Arc::new(Mutex::new(HashMap::new())),
            external_processes: Arc::new(Mutex::new(HashMap::new())),
            media_runtime: None,
        };
        drop(connection);

        let client = reqwest::blocking::Client::new();
        let mut starts = Vec::new();
        for _ in 0..4 {
            let job_id = claim_next_job(DispatchKind::Http, &context)
                .unwrap()
                .unwrap();
            let connection = Connection::open(&path).unwrap();
            let source: String = connection
                .query_row(
                    "SELECT url FROM download_jobs WHERE job_id=?1",
                    params![job_id],
                    |row| row.get(0),
                )
                .unwrap();
            let downloaded = client.get(source).send().unwrap().bytes().unwrap();
            assert_eq!(Sha256::digest(&downloaded).to_vec(), expected_hash);
            connection
                .execute(
                    "UPDATE jobs SET status='completed' WHERE id=?1",
                    params![job_id],
                )
                .unwrap();
            starts.push(job_id);
        }
        assert_eq!(starts, vec![high_1, high_2, normal_1, low_1]);
        assert_eq!(
            Connection::open(&path)
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM jobs WHERE id IN (?1,?2) AND status='running'",
                    params![occupied_1, occupied_2],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            2
        );

        let connection = Connection::open(&path).unwrap();
        let promoted = add_http_url(&connection, "low", "queued", &url);
        let later_high = add_http_url(&connection, "high", "queued", &url);
        connection
            .execute(
                "UPDATE jobs SET priority='high' WHERE id=?1",
                params![promoted],
            )
            .unwrap();
        drop(connection);

        let mut reopened = Connection::open(&path).unwrap();
        migrate(&reopened).unwrap();
        {
            let transaction = reopened.transaction().unwrap();
            assert_eq!(
                candidate_ids(&transaction, DispatchKind::Http).unwrap()[0..2],
                [promoted, later_high]
            );
        }
        reopened
            .execute(
                "UPDATE jobs SET status='paused' WHERE id=?1",
                params![promoted],
            )
            .unwrap();
        {
            let transaction = reopened.transaction().unwrap();
            assert_eq!(
                candidate_ids(&transaction, DispatchKind::Http).unwrap()[0],
                later_high
            );
        }
        reopened
            .execute(
                "UPDATE jobs SET status='queued' WHERE id=?1",
                params![promoted],
            )
            .unwrap();
        drop(reopened);
        for expected in [promoted, later_high] {
            let job_id = claim_next_job(DispatchKind::Http, &context)
                .unwrap()
                .unwrap();
            assert_eq!(job_id, expected);
            let downloaded = client.get(&url).send().unwrap().bytes().unwrap();
            assert_eq!(Sha256::digest(&downloaded).to_vec(), expected_hash);
            Connection::open(&path)
                .unwrap()
                .execute(
                    "UPDATE jobs SET status='completed' WHERE id=?1",
                    params![job_id],
                )
                .unwrap();
        }

        let connection = Connection::open(&path).unwrap();
        let retry = add_http_url(&connection, "high", "failed", &url);
        connection
            .execute(
                "UPDATE jobs SET status='queued' WHERE id=?1",
                params![retry],
            )
            .unwrap();
        drop(connection);
        let claimed_retry = claim_next_job(DispatchKind::Http, &context)
            .unwrap()
            .unwrap();
        assert_eq!(claimed_retry, retry);
        let downloaded = client.get(&url).send().unwrap().bytes().unwrap();
        assert_eq!(Sha256::digest(&downloaded).to_vec(), expected_hash);
        server.join().unwrap();
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
    }

    #[test]
    fn priority_runtime_strict_priority_intentionally_allows_low_starvation() {
        let mut connection = database();
        let low = add_http(&connection, "low", "queued");
        let highs = (0..4)
            .map(|_| add_http(&connection, "high", "queued"))
            .collect::<Vec<_>>();
        let transaction = connection.transaction().unwrap();
        let candidates = candidate_ids(&transaction, DispatchKind::Http).unwrap();
        assert_eq!(&candidates[..highs.len()], highs.as_slice());
        assert_eq!(candidates.last(), Some(&low));
    }

    #[test]
    fn priority_runtime_media_high_wins_without_restarting_active_item() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "cacatools-priority-media-{}-{nonce}.sqlite",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let connection = Connection::open(&path).unwrap();
        migrate(&connection).unwrap();
        let active_normal = add_media(&connection, "normal");
        connection
            .execute(
                "UPDATE jobs SET status='running' WHERE id=?1",
                params![active_normal],
            )
            .unwrap();
        let queued_low = add_media(&connection, "low");
        let queued_high = add_media(&connection, "high");
        drop(connection);
        let active_media = Arc::new(Mutex::new(HashMap::from([(active_normal, 4242_u32)])));
        let context = DispatcherContext {
            db_path: path.clone(),
            active_downloads: Arc::new(Mutex::new(HashSet::new())),
            active_media_pids: active_media,
            external_processes: Arc::new(Mutex::new(HashMap::new())),
            media_runtime: None,
        };
        assert_eq!(
            claim_next_job(DispatchKind::Media, &context).unwrap(),
            Some(queued_high)
        );
        let connection = Connection::open(&path).unwrap();
        let active_status: String = connection
            .query_row(
                "SELECT status FROM jobs WHERE id=?1",
                params![active_normal],
                |row| row.get(0),
            )
            .unwrap();
        let low_status: String = connection
            .query_row(
                "SELECT status FROM jobs WHERE id=?1",
                params![queued_low],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(active_status, "running");
        assert_eq!(low_status, "queued");
        drop(connection);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
    }
}

fn is_active(kind: DispatchKind, context: &DispatcherContext, job_id: i64) -> bool {
    match kind {
        DispatchKind::Http => context
            .active_downloads
            .lock()
            .map(|active| active.contains(&job_id))
            .unwrap_or(true),
        DispatchKind::Media => context
            .active_media_pids
            .lock()
            .map(|active| active.contains_key(&job_id))
            .unwrap_or(true),
    }
}
