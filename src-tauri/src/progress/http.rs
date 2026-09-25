use super::model::{
    EtaKind, JobPhase, ProgressKind, ProgressSnapshotV2, SpeedKind, TotalKind, TransferProgress,
};
use super::state_machine::JobStateMachine;
use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_HTTP_COMPARISONS: usize = 64;
const MAX_HTTP_JOBS: usize = 128;
const MIN_SPEED_SAMPLE: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ContentRangeFacts {
    pub(crate) start: u64,
    pub(crate) end: u64,
    pub(crate) total: Option<u64>,
}

pub(crate) fn parse_content_range(value: &str) -> Option<ContentRangeFacts> {
    let (unit, range) = value.trim().split_once(' ')?;
    if !unit.eq_ignore_ascii_case("bytes") {
        return None;
    }
    let (bounds, total) = range.split_once('/')?;
    let (start, end) = bounds.split_once('-')?;
    let start = start.parse::<u64>().ok()?;
    let end = end.parse::<u64>().ok()?;
    if end < start {
        return None;
    }
    let total = (total != "*").then(|| total.parse::<u64>().ok()).flatten();
    if total.is_some_and(|total| total <= end) {
        return None;
    }
    Some(ContentRangeFacts { start, end, total })
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct HttpV1Observation {
    pub(crate) downloaded_bytes: u64,
    pub(crate) total_bytes: Option<u64>,
    pub(crate) progress: Option<f64>,
    pub(crate) speed_bps: Option<f64>,
    pub(crate) eta_seconds: Option<u64>,
    pub(crate) status: String,
    pub(crate) final_size: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HttpDivergence {
    None,
    DownloadedRegression,
    TotalMismatch,
    ProgressMismatch,
    CompletedBeforeFinalSize,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct HttpComparison {
    pub(crate) timestamp_ms: u64,
    pub(crate) job_id: i64,
    pub(crate) v1: HttpV1Observation,
    pub(crate) v2: ProgressSnapshotV2,
    pub(crate) divergence: HttpDivergence,
}

#[derive(Debug)]
pub(crate) struct HttpProgressAdapterV2 {
    job_id: i64,
    machine: JobStateMachine,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    total_kind: TotalKind,
    speed_bps: Option<f64>,
    eta_seconds: Option<u64>,
    last_sample: Option<(Instant, u64)>,
    final_size: Option<u64>,
}

impl HttpProgressAdapterV2 {
    pub(crate) fn new(job_id: i64, reused_bytes: u64) -> Self {
        Self {
            job_id,
            machine: JobStateMachine::new(),
            downloaded_bytes: reused_bytes,
            total_bytes: None,
            total_kind: TotalKind::Unknown,
            speed_bps: None,
            eta_seconds: None,
            last_sample: None,
            final_size: None,
        }
    }

    pub(crate) fn mark_preparing(&mut self) -> Option<ProgressSnapshotV2> {
        if self.machine.phase() == JobPhase::Queued {
            let _ = self.machine.transition(JobPhase::Preparing);
        }
        self.snapshot()
    }

    pub(crate) fn response_headers(
        &mut self,
        status_code: u16,
        existing_bytes: u64,
        content_length: Option<u64>,
        content_range: Option<ContentRangeFacts>,
    ) -> Option<ProgressSnapshotV2> {
        let (logical_downloaded, total) = if status_code == 206 {
            match content_range {
                Some(range) if range.start == existing_bytes => (existing_bytes, range.total),
                Some(range) => (0, range.total),
                None => (0, None),
            }
        } else {
            // A 200 response after a Range request is a complete restart. The
            // productive worker truncates the .part file before reading it.
            (0, content_length)
        };
        self.downloaded_bytes = logical_downloaded;
        self.final_size = None;
        self.last_sample = None;
        self.speed_bps = None;
        self.eta_seconds = None;
        self.set_total(total);
        self.start_downloading();
        self.snapshot()
    }

    pub(crate) fn start_stream(
        &mut self,
        logical_downloaded: u64,
        total_bytes: Option<u64>,
    ) -> Option<ProgressSnapshotV2> {
        self.downloaded_bytes = logical_downloaded;
        self.last_sample = None;
        self.set_total(total_bytes);
        self.start_downloading();
        self.snapshot()
    }

    pub(crate) fn observe(&mut self, downloaded_bytes: u64) -> Option<ProgressSnapshotV2> {
        self.observe_at(downloaded_bytes, Instant::now())
    }

    fn observe_at(&mut self, downloaded_bytes: u64, now: Instant) -> Option<ProgressSnapshotV2> {
        if self.machine.phase().is_terminal() {
            return None;
        }
        if downloaded_bytes < self.downloaded_bytes {
            // The worker restarted the transfer after a server ignored Range;
            // never add the old partial to the new full response.
            self.last_sample = None;
            self.speed_bps = None;
            self.eta_seconds = None;
        }
        if let Some((previous_at, previous_bytes)) = self.last_sample {
            let elapsed = now.saturating_duration_since(previous_at);
            if elapsed >= MIN_SPEED_SAMPLE {
                let observed = downloaded_bytes.saturating_sub(previous_bytes) as f64
                    / elapsed.as_secs_f64().max(0.001);
                self.speed_bps = Some(smooth_speed(self.speed_bps.unwrap_or(0.0), observed));
            }
        }
        self.last_sample = Some((now, downloaded_bytes));
        self.downloaded_bytes = downloaded_bytes;
        self.update_eta();
        self.snapshot()
    }

    pub(crate) fn mark_paused(&mut self) -> Option<ProgressSnapshotV2> {
        let _ = self.machine.transition(JobPhase::Paused);
        self.speed_bps = None;
        self.eta_seconds = None;
        self.last_sample = None;
        self.snapshot()
    }

    pub(crate) fn mark_resumed(&mut self) -> Option<ProgressSnapshotV2> {
        let _ = self.machine.transition(JobPhase::Downloading);
        self.last_sample = None;
        self.snapshot()
    }

    pub(crate) fn mark_cancelling(&mut self) -> Option<ProgressSnapshotV2> {
        let _ = self.machine.cancel();
        self.speed_bps = None;
        self.eta_seconds = None;
        self.snapshot()
    }

    pub(crate) fn mark_cancelled(&mut self) -> Option<ProgressSnapshotV2> {
        let _ = self.machine.process_terminated();
        self.snapshot()
    }

    pub(crate) fn mark_failed(&mut self) -> Option<ProgressSnapshotV2> {
        let _ = self.machine.transition(JobPhase::Failed);
        self.speed_bps = None;
        self.eta_seconds = None;
        self.snapshot()
    }

    pub(crate) fn begin_retry(&mut self, reused_bytes: u64) -> Option<ProgressSnapshotV2> {
        let _ = self.machine.begin_retry();
        self.downloaded_bytes = reused_bytes;
        self.total_bytes = None;
        self.total_kind = TotalKind::Unknown;
        self.speed_bps = None;
        self.eta_seconds = None;
        self.last_sample = None;
        self.final_size = None;
        self.snapshot()
    }

    pub(crate) fn mark_post_processing(&mut self) -> Option<ProgressSnapshotV2> {
        let _ = self.machine.transition(JobPhase::PostProcessing);
        self.speed_bps = None;
        self.eta_seconds = None;
        self.snapshot()
    }

    pub(crate) fn mark_finalizing(&mut self) -> Option<ProgressSnapshotV2> {
        let _ = self.machine.transition(JobPhase::Finalizing);
        self.snapshot()
    }

    pub(crate) fn mark_completed(&mut self, final_size: u64) -> Option<ProgressSnapshotV2> {
        let _ = self.machine.transition(JobPhase::Completed);
        self.downloaded_bytes = final_size;
        self.total_bytes = Some(final_size);
        self.total_kind = TotalKind::Exact;
        self.speed_bps = None;
        self.eta_seconds = None;
        self.final_size = Some(final_size);
        self.snapshot()
    }

    fn start_downloading(&mut self) {
        if matches!(self.machine.phase(), JobPhase::Preparing | JobPhase::Paused) {
            let _ = self.machine.transition(JobPhase::Downloading);
        }
    }

    fn set_total(&mut self, total_bytes: Option<u64>) {
        let Some(total_bytes) = total_bytes.filter(|total| *total > 0) else {
            return;
        };
        if self.total_kind == TotalKind::Exact && self.total_bytes.is_some() {
            return;
        }
        self.total_bytes = Some(total_bytes);
        self.total_kind = TotalKind::Exact;
    }

    fn update_eta(&mut self) {
        self.eta_seconds = self.total_bytes.and_then(|total| {
            self.speed_bps.filter(|speed| *speed > 0.0).map(|speed| {
                let remaining = total.saturating_sub(self.downloaded_bytes);
                (remaining as f64 / speed).ceil() as u64
            })
        });
    }

    fn snapshot(&self) -> Option<ProgressSnapshotV2> {
        let progress = self
            .total_bytes
            .map(|total| super::model::fraction(self.downloaded_bytes, total));
        let (progress_kind, total_kind) = match self.total_kind {
            TotalKind::Exact => (ProgressKind::Exact, TotalKind::Exact),
            TotalKind::Estimated => (ProgressKind::Estimated, TotalKind::Estimated),
            TotalKind::Unknown => (ProgressKind::Unavailable, TotalKind::Unknown),
        };
        let mut snapshot = ProgressSnapshotV2::new(
            self.job_id as u64,
            self.machine.phase(),
            TransferProgress {
                downloaded_bytes: self.downloaded_bytes,
                total_bytes: self.total_bytes,
                total_kind,
                reported_percent: None,
                progress,
                progress_kind,
                speed_bps: self.speed_bps,
                speed_kind: self
                    .speed_bps
                    .map(|_| SpeedKind::Derived)
                    .unwrap_or(SpeedKind::Unavailable),
                eta_seconds: self.eta_seconds,
                eta_kind: self
                    .eta_seconds
                    .map(|_| EtaKind::Estimated)
                    .unwrap_or(EtaKind::Unavailable),
            },
        );
        snapshot.final_size = self.final_size;
        snapshot.validate().ok()?;
        Some(snapshot)
    }
}

fn smooth_speed(previous: f64, observed: f64) -> f64 {
    let observed = observed.max(0.0);
    if previous <= 0.0 {
        return observed;
    }
    let bounded = observed.min(previous * 2.75 + 512.0 * 1024.0);
    let weight = if bounded > previous { 0.22 } else { 0.38 };
    previous * (1.0 - weight) + bounded * weight
}

#[derive(Debug, Default)]
pub(crate) struct HttpShadowStore {
    jobs: HashMap<i64, HttpProgressAdapterV2>,
    comparisons: HashMap<i64, VecDeque<HttpComparison>>,
}

impl HttpShadowStore {
    pub(crate) fn begin(&mut self, job_id: i64, reused_bytes: u64) {
        if !self.jobs.contains_key(&job_id) && self.jobs.len() >= MAX_HTTP_JOBS {
            if let Some(oldest) = self.jobs.keys().next().copied() {
                self.jobs.remove(&oldest);
                self.comparisons.remove(&oldest);
            }
        }
        self.jobs
            .insert(job_id, HttpProgressAdapterV2::new(job_id, reused_bytes));
        self.comparisons.remove(&job_id);
    }

    pub(crate) fn retry(&mut self, job_id: i64, reused_bytes: u64) {
        if let Some(adapter) = self.jobs.get_mut(&job_id) {
            let _ = adapter.mark_failed();
            let _ = adapter.begin_retry(reused_bytes);
        } else {
            self.begin(job_id, reused_bytes);
        }
    }

    pub(crate) fn mark_preparing(&mut self, job_id: i64) {
        let _ = self
            .jobs
            .get_mut(&job_id)
            .and_then(|job| job.mark_preparing());
    }

    pub(crate) fn response_headers(
        &mut self,
        job_id: i64,
        status_code: u16,
        existing_bytes: u64,
        content_length: Option<u64>,
        content_range: Option<ContentRangeFacts>,
        v1: HttpV1Observation,
    ) {
        let Some(adapter) = self.jobs.get_mut(&job_id) else {
            return;
        };
        if let Some(snapshot) =
            adapter.response_headers(status_code, existing_bytes, content_length, content_range)
        {
            self.record(job_id, v1, snapshot);
        }
    }

    pub(crate) fn start_stream(
        &mut self,
        job_id: i64,
        downloaded_bytes: u64,
        total_bytes: Option<u64>,
        v1: HttpV1Observation,
    ) {
        let Some(adapter) = self.jobs.get_mut(&job_id) else {
            return;
        };
        if let Some(snapshot) = adapter.start_stream(downloaded_bytes, total_bytes) {
            self.record(job_id, v1, snapshot);
        }
    }

    pub(crate) fn observe(&mut self, job_id: i64, downloaded_bytes: u64, v1: HttpV1Observation) {
        let Some(adapter) = self.jobs.get_mut(&job_id) else {
            return;
        };
        if let Some(snapshot) = adapter.observe(downloaded_bytes) {
            self.record(job_id, v1, snapshot);
        }
    }

    pub(crate) fn mark_paused(&mut self, job_id: i64) {
        let _ = self.jobs.get_mut(&job_id).and_then(|job| job.mark_paused());
    }

    pub(crate) fn mark_resumed(&mut self, job_id: i64) {
        let _ = self
            .jobs
            .get_mut(&job_id)
            .and_then(|job| job.mark_resumed());
    }

    pub(crate) fn mark_cancelling(&mut self, job_id: i64) {
        let _ = self
            .jobs
            .get_mut(&job_id)
            .and_then(|job| job.mark_cancelling());
    }

    pub(crate) fn mark_cancelled(&mut self, job_id: i64) {
        let _ = self
            .jobs
            .get_mut(&job_id)
            .and_then(|job| job.mark_cancelled());
    }

    pub(crate) fn mark_failed(&mut self, job_id: i64) {
        let _ = self.jobs.get_mut(&job_id).and_then(|job| job.mark_failed());
    }

    pub(crate) fn mark_post_processing(&mut self, job_id: i64) {
        let _ = self
            .jobs
            .get_mut(&job_id)
            .and_then(|job| job.mark_post_processing());
    }

    pub(crate) fn mark_finalizing(&mut self, job_id: i64) {
        let _ = self
            .jobs
            .get_mut(&job_id)
            .and_then(|job| job.mark_finalizing());
    }

    pub(crate) fn mark_completed(&mut self, job_id: i64, final_size: u64) {
        let _ = self
            .jobs
            .get_mut(&job_id)
            .and_then(|job| job.mark_completed(final_size));
    }

    pub(crate) fn snapshot(&self, job_id: i64) -> Option<ProgressSnapshotV2> {
        self.jobs
            .get(&job_id)
            .and_then(HttpProgressAdapterV2::snapshot)
    }

    pub(crate) fn comparisons(&self, job_id: i64) -> Vec<HttpComparison> {
        self.comparisons
            .get(&job_id)
            .map(|values| values.iter().cloned().collect())
            .unwrap_or_default()
    }

    pub(crate) fn remove(&mut self, job_id: i64) {
        self.jobs.remove(&job_id);
        self.comparisons.remove(&job_id);
    }

    fn record(&mut self, job_id: i64, v1: HttpV1Observation, v2: ProgressSnapshotV2) {
        let divergence = compare_v1_v2(&v1, &v2);
        let samples = self.comparisons.entry(job_id).or_default();
        samples.push_back(HttpComparison {
            timestamp_ms: now_ms(),
            job_id,
            v1,
            v2,
            divergence,
        });
        while samples.len() > MAX_HTTP_COMPARISONS {
            samples.pop_front();
        }
    }
}

fn compare_v1_v2(v1: &HttpV1Observation, v2: &ProgressSnapshotV2) -> HttpDivergence {
    if v2.transfer.downloaded_bytes < v1.downloaded_bytes {
        HttpDivergence::DownloadedRegression
    } else if v1.total_bytes != v2.transfer.total_bytes {
        HttpDivergence::TotalMismatch
    } else if v1
        .progress
        .zip(v2.transfer.progress)
        .is_some_and(|(left, right)| (left - right).abs() > 0.01)
    {
        HttpDivergence::ProgressMismatch
    } else if v1.status == "completed"
        && (v1.final_size.is_none() || v2.phase != JobPhase::Completed)
    {
        HttpDivergence::CompletedBeforeFinalSize
    } else {
        HttpDivergence::None
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{Shutdown, TcpListener, TcpStream};
    use std::thread;

    fn v1(status: &str, downloaded: u64, total: Option<u64>) -> HttpV1Observation {
        HttpV1Observation {
            downloaded_bytes: downloaded,
            total_bytes: total,
            progress: total.map(|total| downloaded as f64 / total as f64),
            speed_bps: None,
            eta_seconds: None,
            status: status.into(),
            final_size: None,
        }
    }

    fn serve_once(status: &str, headers: &str, body: &[u8]) -> String {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let response = format!(
            "HTTP/1.1 {status}\r\n{headers}\r\n\r\n{}",
            String::from_utf8_lossy(body)
        );
        thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut request = Vec::new();
                let mut buffer = [0_u8; 512];
                while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                    let Ok(count) = stream.read(&mut buffer) else {
                        return;
                    };
                    if count == 0 {
                        return;
                    }
                    request.extend_from_slice(&buffer[..count]);
                    if request.len() > 4096 {
                        return;
                    }
                }
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
                let _ = stream.shutdown(Shutdown::Both);
            }
        });
        format!("http://{address}/fixture")
    }

    fn request_once(url: &str) -> Vec<u8> {
        let parsed = url::Url::parse(url).unwrap();
        let mut stream =
            TcpStream::connect((parsed.host_str().unwrap(), parsed.port().unwrap_or(80))).unwrap();
        write!(
            stream,
            "GET {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
            parsed.path(),
            parsed.host_str().unwrap()
        )
        .unwrap();
        let mut response = Vec::new();
        let mut buffer = [0_u8; 1024];
        loop {
            match stream.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => response.extend_from_slice(&buffer[..count]),
                Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => break,
                Err(error) => panic!("fixture response read failed: {error}"),
            }
        }
        response
    }

    #[test]
    fn local_http_fixture_server_covers_required_response_shapes() {
        let exact = request_once(&serve_once("200 OK", "Content-Length: 10", b"0123456789"));
        assert!(String::from_utf8_lossy(&exact).contains("Content-Length: 10"));

        let chunked = request_once(&serve_once(
            "200 OK",
            "Transfer-Encoding: chunked",
            b"a\r\n0123456789\r\n0\r\n\r\n",
        ));
        assert!(String::from_utf8_lossy(&chunked).contains("Transfer-Encoding: chunked"));

        let range = request_once(&serve_once(
            "206 Partial Content",
            "Content-Range: bytes 4-9/10\r\nContent-Length: 6",
            b"456789",
        ));
        assert!(String::from_utf8_lossy(&range).contains("Content-Range: bytes 4-9/10"));

        let ignored = request_once(&serve_once("200 OK", "Content-Length: 10", b"0123456789"));
        assert!(String::from_utf8_lossy(&ignored).starts_with("HTTP/1.1 200 OK"));

        let redirect = request_once(&serve_once("302 Found", "Location: /fixture", b""));
        assert!(String::from_utf8_lossy(&redirect).contains("Location: /fixture"));

        let truncated = request_once(&serve_once("200 OK", "Content-Length: 10", b"012345"));
        assert!(truncated.windows(6).any(|part| part == b"012345"));
    }

    #[test]
    fn parses_valid_content_range_and_rejects_invalid_ranges() {
        assert_eq!(
            parse_content_range("bytes 41943040-104857599/104857600"),
            Some(ContentRangeFacts {
                start: 41_943_040,
                end: 104_857_599,
                total: Some(104_857_600),
            })
        );
        assert!(parse_content_range("bytes 4-3/10").is_none());
        assert!(parse_content_range("items 0-3/4").is_none());
    }

    #[test]
    fn content_length_is_exact_for_a_full_response() {
        let mut adapter = HttpProgressAdapterV2::new(1, 0);
        adapter.mark_preparing();
        let snapshot = adapter.response_headers(200, 0, Some(100), None).unwrap();
        assert_eq!(snapshot.phase, JobPhase::Downloading);
        assert_eq!(snapshot.transfer.total_kind, TotalKind::Exact);
        assert_eq!(snapshot.transfer.progress_kind, ProgressKind::Exact);
        assert_eq!(snapshot.transfer.downloaded_bytes, 0);
    }

    #[test]
    fn chunked_response_keeps_real_bytes_without_inventing_progress() {
        let mut adapter = HttpProgressAdapterV2::new(2, 0);
        adapter.mark_preparing();
        adapter.response_headers(200, 0, None, None);
        let snapshot = adapter.observe(86 * 1024 * 1024).unwrap();
        assert_eq!(snapshot.transfer.downloaded_bytes, 86 * 1024 * 1024);
        assert_eq!(snapshot.transfer.total_kind, TotalKind::Unknown);
        assert_eq!(snapshot.transfer.progress_kind, ProgressKind::Unavailable);
        assert_eq!(snapshot.transfer.progress, None);
    }

    #[test]
    fn speed_is_derived_from_samples_and_eta_uses_known_total() {
        let mut adapter = HttpProgressAdapterV2::new(21, 0);
        adapter.mark_preparing();
        adapter.response_headers(200, 0, Some(100), None);
        let start = Instant::now();
        adapter.observe_at(40, start);
        let snapshot = adapter
            .observe_at(70, start + Duration::from_secs(1))
            .unwrap();
        assert_eq!(snapshot.transfer.speed_kind, SpeedKind::Derived);
        assert!(snapshot.transfer.speed_bps.is_some_and(|speed| speed > 0.0));
        assert!(snapshot.transfer.eta_seconds.is_some());
    }

    #[test]
    fn valid_range_resume_starts_at_existing_logical_bytes() {
        let mut adapter = HttpProgressAdapterV2::new(3, 4);
        adapter.mark_preparing();
        let snapshot = adapter
            .response_headers(
                206,
                4,
                Some(6),
                Some(ContentRangeFacts {
                    start: 4,
                    end: 9,
                    total: Some(10),
                }),
            )
            .unwrap();
        assert_eq!(snapshot.transfer.downloaded_bytes, 4);
        assert_eq!(snapshot.transfer.total_bytes, Some(10));
        assert_eq!(snapshot.transfer.progress, Some(0.4));
    }

    #[test]
    fn partial_content_length_is_not_mistaken_for_full_file_size() {
        let mut adapter = HttpProgressAdapterV2::new(31, 4);
        adapter.mark_preparing();
        let snapshot = adapter
            .response_headers(
                206,
                4,
                Some(6),
                Some(ContentRangeFacts {
                    start: 4,
                    end: 9,
                    total: None,
                }),
            )
            .unwrap();
        assert_eq!(snapshot.transfer.downloaded_bytes, 4);
        assert_eq!(snapshot.transfer.total_bytes, None);
        assert_eq!(snapshot.transfer.total_kind, TotalKind::Unknown);
    }

    #[test]
    fn range_ignored_restarts_without_double_counting_partial_bytes() {
        let mut adapter = HttpProgressAdapterV2::new(4, 4);
        adapter.mark_preparing();
        let snapshot = adapter.response_headers(200, 0, Some(10), None).unwrap();
        assert_eq!(snapshot.transfer.downloaded_bytes, 0);
        let snapshot = adapter.observe(10).unwrap();
        assert_eq!(snapshot.transfer.downloaded_bytes, 10);
        assert_eq!(snapshot.transfer.progress, Some(1.0));
    }

    #[test]
    fn truncated_transfer_never_becomes_completed() {
        let mut adapter = HttpProgressAdapterV2::new(5, 0);
        adapter.mark_preparing();
        adapter.response_headers(200, 0, Some(100), None);
        adapter.observe(70);
        let failed = adapter.mark_failed().unwrap();
        assert_eq!(failed.phase, JobPhase::Failed);
        assert_eq!(failed.final_size, None);
    }

    #[test]
    fn final_size_only_appears_after_finalizing_and_filesystem_size() {
        let mut adapter = HttpProgressAdapterV2::new(6, 0);
        adapter.mark_preparing();
        adapter.response_headers(200, 0, Some(100), None);
        adapter.observe(100);
        adapter.mark_post_processing();
        let finalizing = adapter.mark_finalizing().unwrap();
        assert_eq!(finalizing.final_size, None);
        let completed = adapter.mark_completed(96).unwrap();
        assert_eq!(completed.phase, JobPhase::Completed);
        assert_eq!(completed.final_size, Some(96));
        assert_eq!(completed.transfer.downloaded_bytes, 96);
    }

    #[test]
    fn pause_resume_cancel_and_late_events_are_state_safe() {
        let mut adapter = HttpProgressAdapterV2::new(7, 0);
        adapter.mark_preparing();
        adapter.response_headers(200, 0, Some(100), None);
        adapter.observe(40);
        assert_eq!(adapter.mark_paused().unwrap().phase, JobPhase::Paused);
        assert_eq!(adapter.mark_resumed().unwrap().phase, JobPhase::Downloading);
        assert_eq!(
            adapter.mark_cancelling().unwrap().phase,
            JobPhase::Cancelling
        );
        assert_eq!(adapter.mark_cancelled().unwrap().phase, JobPhase::Cancelled);
        assert!(adapter.observe(100).is_none());
    }

    #[test]
    fn shadow_comparison_is_bounded_and_keeps_http_facts() {
        let mut store = HttpShadowStore::default();
        store.begin(8, 0);
        store.mark_preparing(8);
        store.response_headers(8, 200, 0, Some(100), None, v1("running", 0, Some(100)));
        for downloaded in 0..(MAX_HTTP_COMPARISONS as u64 + 10) {
            store.observe(8, downloaded, v1("running", downloaded, Some(100)));
        }
        assert_eq!(store.comparisons(8).len(), MAX_HTTP_COMPARISONS);
        assert_eq!(store.snapshot(8).unwrap().job_id, 8);
    }
}
