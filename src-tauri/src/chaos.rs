use std::{
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

/// Hot Chaos is deliberately opt-in. It pauses only the child process owned
/// by a CacaTools worker, never the network adapter or the user's other apps.
/// On Windows this exercises the same partial-file/retry path without
/// requiring administrator privileges or changing global firewall state.
pub(crate) fn hot_chaos_enabled() -> bool {
    std::env::var("CACATOOLS_HOT_CHAOS")
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "on"
            )
        })
        .unwrap_or(false)
}

pub(crate) fn telemetry_enabled() -> bool {
    std::env::var("CACATOOLS_DEBUG_TELEMETRY")
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "on"
            )
        })
        .unwrap_or(false)
}

pub(crate) fn telemetry_path(db_path: &Path) -> PathBuf {
    db_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("debug_telemetry.log")
}

pub(crate) fn record_dispatcher_lag(db_path: PathBuf, lag: Duration) {
    if !telemetry_enabled() {
        return;
    }
    let path = telemetry_path(&db_path);
    tauri::async_runtime::spawn_blocking(move || {
        let Some(parent) = path.parent() else {
            return;
        };
        let _ = std::fs::create_dir_all(parent);
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_millis())
            .unwrap_or_default();
        let line = format!(
            "{timestamp} dispatcher_event_loop_lag_ms={} threshold_ms=16\n",
            lag.as_millis()
        );
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = file.write_all(line.as_bytes());
        }
    });
}

#[derive(Debug)]
pub(crate) struct HotChaosController {
    enabled: bool,
    next_cut: std::time::Instant,
    seed: u64,
}

impl HotChaosController {
    pub(crate) fn new() -> Self {
        let seed = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos() as u64)
            .unwrap_or(0xCACA_7001);
        Self {
            enabled: hot_chaos_enabled(),
            next_cut: std::time::Instant::now() + Duration::from_secs(8),
            seed,
        }
    }

    pub(crate) fn due(&self) -> bool {
        self.enabled && std::time::Instant::now() >= self.next_cut
    }

    /// Returns true when a cut was injected. The worker thread sleeps while
    /// its child is suspended; the Tauri/UI thread is never blocked.
    pub(crate) fn maybe_cut(&mut self, pid: u32, _label: &str) -> bool {
        if !self.enabled || pid == 0 || std::time::Instant::now() < self.next_cut {
            return false;
        }
        let seconds = 3 + (self.next_random() % 5);
        #[cfg(windows)]
        {
            if suspend_process(pid) {
                std::thread::sleep(Duration::from_secs(seconds));
                let _ = resume_process(pid);
                self.next_cut = std::time::Instant::now() + Duration::from_secs(8);
                return true;
            }
        }
        #[cfg(not(windows))]
        let _ = seconds;
        self.next_cut = std::time::Instant::now() + Duration::from_secs(8);
        false
    }

    fn next_random(&mut self) -> u64 {
        // Small local LCG; this is test scheduling, not security-sensitive
        // randomness and avoids adding a dependency.
        self.seed = self
            .seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.seed
    }
}

#[cfg(windows)]
const PROCESS_SUSPEND_RESUME: u32 = 0x0800;
#[cfg(windows)]
const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn OpenProcess(access: u32, inherit_handle: i32, process_id: u32) -> *mut std::ffi::c_void;
    fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
}

#[cfg(windows)]
#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtSuspendProcess(handle: *mut std::ffi::c_void) -> i32;
    fn NtResumeProcess(handle: *mut std::ffi::c_void) -> i32;
}

#[cfg(windows)]
fn suspend_process(pid: u32) -> bool {
    unsafe {
        let handle = OpenProcess(
            PROCESS_SUSPEND_RESUME | PROCESS_QUERY_LIMITED_INFORMATION,
            0,
            pid,
        );
        if handle.is_null() {
            return false;
        }
        let status = NtSuspendProcess(handle);
        let _ = CloseHandle(handle);
        status >= 0
    }
}

#[cfg(windows)]
fn resume_process(pid: u32) -> bool {
    unsafe {
        let handle = OpenProcess(
            PROCESS_SUSPEND_RESUME | PROCESS_QUERY_LIMITED_INFORMATION,
            0,
            pid,
        );
        if handle.is_null() {
            return false;
        }
        let status = NtResumeProcess(handle);
        let _ = CloseHandle(handle);
        status >= 0
    }
}
