use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
};

use rusqlite::Connection;

use crate::kill_process_tree;
use crate::{
    DownloadDispatcher, ExternalProcessRegistry, MediaRuntimePaths, WindowBehaviorSettings,
};

pub(crate) struct LocalState {
    pub(crate) connection: Mutex<Connection>,
    pub(crate) db_path: PathBuf,
    pub(crate) downloads_dir: Mutex<PathBuf>,
    pub(crate) window_behavior: Mutex<WindowBehaviorSettings>,
    pub(crate) active_downloads: Arc<Mutex<HashSet<i64>>>,
    pub(crate) active_media_pids: Arc<Mutex<HashMap<i64, u32>>>,
    pub(crate) external_processes: ExternalProcessRegistry,
    pub(crate) preparation_operations: WindowOperationRegistry,
    pub(crate) media_runtime: Option<MediaRuntimePaths>,
    pub(crate) aria2_path: Option<PathBuf>,
    pub(crate) dispatcher: Arc<DownloadDispatcher>,
}

pub(crate) type WorkerCompletion = Box<dyn FnOnce() + Send + 'static>;

pub(crate) struct WorkerCompletionGuard(Option<WorkerCompletion>);

impl WorkerCompletionGuard {
    pub(crate) fn new(completion: Option<WorkerCompletion>) -> Self {
        Self(completion)
    }
}

impl Drop for WorkerCompletionGuard {
    fn drop(&mut self) {
        if let Some(completion) = self.0.take() {
            completion();
        }
    }
}

/// Preparation/player processes are deliberately isolated from download jobs.
/// Closing one window must never cancel another window or a persisted download.
pub(crate) struct WindowOperation {
    pub(crate) generation: u64,
    pub(crate) cancelled: AtomicBool,
    pub(crate) closed: AtomicBool,
    processes: Mutex<HashSet<u32>>,
}

pub(crate) type WindowOperationRegistry = Arc<Mutex<HashMap<String, Arc<WindowOperation>>>>;

static NEXT_WINDOW_OPERATION: AtomicU64 = AtomicU64::new(0);

pub(crate) struct WindowProcessGuard {
    operation: Arc<WindowOperation>,
    pid: u32,
}

impl Drop for WindowProcessGuard {
    fn drop(&mut self) {
        if let Ok(mut processes) = self.operation.processes.lock() {
            processes.remove(&self.pid);
        }
    }
}

fn cancel_window_operation(operation: &Arc<WindowOperation>, closed: bool) {
    if closed {
        operation.closed.store(true, Ordering::SeqCst);
    }
    operation.cancelled.store(true, Ordering::SeqCst);
    let pids = operation
        .processes
        .lock()
        .map(|mut processes| processes.drain().collect::<Vec<_>>())
        .unwrap_or_default();
    if pids.is_empty() {
        return;
    }
    thread::spawn(move || {
        for pid in pids {
            kill_process_tree(pid);
        }
    });
}

pub(crate) fn begin_window_operation(
    registry: &WindowOperationRegistry,
    label: &str,
) -> Arc<WindowOperation> {
    let operation = Arc::new(WindowOperation {
        generation: NEXT_WINDOW_OPERATION.fetch_add(1, Ordering::SeqCst) + 1,
        cancelled: AtomicBool::new(false),
        closed: AtomicBool::new(false),
        processes: Mutex::new(HashSet::new()),
    });
    let previous = registry
        .lock()
        .ok()
        .and_then(|mut operations| operations.insert(label.to_string(), operation.clone()));
    if let Some(previous) = previous {
        cancel_window_operation(&previous, false);
    }
    operation
}

pub(crate) fn current_window_operation(
    registry: &WindowOperationRegistry,
    label: &str,
) -> Option<Arc<WindowOperation>> {
    registry
        .lock()
        .ok()
        .and_then(|operations| operations.get(label).cloned())
}

pub(crate) fn finish_window_operation(
    registry: &WindowOperationRegistry,
    label: &str,
    operation: &Arc<WindowOperation>,
) {
    let Ok(mut operations) = registry.lock() else {
        return;
    };
    let remove = operations.get(label).is_some_and(|current| {
        Arc::ptr_eq(current, operation) && !current.closed.load(Ordering::SeqCst)
    });
    if remove {
        operations.remove(label);
    }
}

/// CloseRequested and programmatic close call this before allowing the native
/// close to proceed. The cancelled tombstone stays until the next open, so a
/// queued late IPC call cannot create work for a window that is already gone.
pub(crate) fn invalidate_window_operation(registry: &WindowOperationRegistry, label: &str) {
    let operation = registry.lock().ok().map(|mut operations| {
        if let Some(operation) = operations.get(label).cloned() {
            operation
        } else {
            let operation = Arc::new(WindowOperation {
                generation: NEXT_WINDOW_OPERATION.fetch_add(1, Ordering::SeqCst) + 1,
                cancelled: AtomicBool::new(false),
                closed: AtomicBool::new(false),
                processes: Mutex::new(HashSet::new()),
            });
            operations.insert(label.to_string(), operation.clone());
            operation
        }
    });
    if let Some(operation) = operation {
        cancel_window_operation(&operation, true);
    }
}

pub(crate) fn register_window_process(
    operation: &Arc<WindowOperation>,
    pid: u32,
) -> Result<WindowProcessGuard, String> {
    if pid == 0 {
        return Err("El proceso de preparación devolvió un PID inválido".into());
    }
    let mut processes = operation
        .processes
        .lock()
        .map_err(|_| "No se pudo registrar el proceso de preparación".to_string())?;
    if operation.cancelled.load(Ordering::SeqCst) || operation.closed.load(Ordering::SeqCst) {
        return Err("preparation_cancelled".into());
    }
    processes.insert(pid);
    Ok(WindowProcessGuard {
        operation: operation.clone(),
        pid,
    })
}

pub(crate) fn window_operation_is_cancelled(operation: &WindowOperation) -> bool {
    operation.cancelled.load(Ordering::SeqCst) || operation.closed.load(Ordering::SeqCst)
}
