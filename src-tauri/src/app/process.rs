use std::{
    collections::HashMap,
    ffi::OsStr,
    io::{BufReader, Read},
    process::{Command, Output, Stdio},
    sync::{atomic::Ordering, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use crate::{kill_process_tree, register_window_process, WindowOperation};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ExternalProcessKind {
    Aria2,
    HttpFallback,
    YtDlp,
    Ffmpeg,
    Ffprobe,
    Tagging,
}

pub(crate) type ExternalProcessRegistry =
    Arc<Mutex<HashMap<i64, HashMap<u32, ExternalProcessKind>>>>;

pub(crate) struct ExternalProcessGuard {
    registry: ExternalProcessRegistry,
    job_id: i64,
    pid: u32,
}

impl Drop for ExternalProcessGuard {
    fn drop(&mut self) {
        if let Ok(mut processes) = self.registry.lock() {
            if let Some(job_processes) = processes.get_mut(&self.job_id) {
                job_processes.remove(&self.pid);
                if job_processes.is_empty() {
                    processes.remove(&self.job_id);
                }
            }
        }
    }
}

pub(crate) fn register_external_process(
    registry: &ExternalProcessRegistry,
    job_id: i64,
    pid: u32,
    kind: ExternalProcessKind,
) -> Result<ExternalProcessGuard, String> {
    if pid == 0 {
        return Err("El proceso externo devolvió un PID inválido".into());
    }
    registry
        .lock()
        .map_err(|_| "No se pudo registrar el proceso externo".to_string())?
        .entry(job_id)
        .or_default()
        .insert(pid, kind);
    Ok(ExternalProcessGuard {
        registry: registry.clone(),
        job_id,
        pid,
    })
}

pub(crate) fn terminate_external_processes(registry: &ExternalProcessRegistry, job_id: i64) {
    let pids = registry
        .lock()
        .map(|processes| {
            processes
                .get(&job_id)
                .map(|job_processes| job_processes.keys().copied().collect::<Vec<_>>())
                .unwrap_or_default()
        })
        .unwrap_or_default();
    for pid in pids {
        kill_process_tree(pid);
    }
}

pub(crate) fn external_processes_active(registry: &ExternalProcessRegistry, job_id: i64) -> bool {
    registry
        .lock()
        .map(|processes| processes.contains_key(&job_id))
        .unwrap_or(true)
}

pub(crate) fn wait_for_external_processes_idle(
    registry: &ExternalProcessRegistry,
    job_id: i64,
    timeout: Duration,
) -> bool {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if !external_processes_active(registry, job_id) {
            return true;
        }
        thread::sleep(Duration::from_millis(25));
    }
    !external_processes_active(registry, job_id)
}

#[cfg(windows)]
pub(crate) fn background_command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(not(windows))]
pub(crate) fn background_command(program: impl AsRef<OsStr>) -> Command {
    Command::new(program)
}

pub(crate) fn command_output_with_timeout(
    command: &mut Command,
    timeout: Duration,
    context: &str,
) -> Result<Output, String> {
    command_output_with_timeout_cancelable_owned(command, timeout, context, || false, None)
}

pub(crate) fn command_output_with_timeout_cancelable<F>(
    command: &mut Command,
    timeout: Duration,
    context: &str,
    is_cancelled: F,
) -> Result<Output, String>
where
    F: Fn() -> bool,
{
    command_output_with_timeout_cancelable_owned(command, timeout, context, is_cancelled, None)
}

pub(crate) fn command_output_with_timeout_cancelable_owned<F>(
    command: &mut Command,
    timeout: Duration,
    context: &str,
    is_cancelled: F,
    owner: Option<&Arc<WindowOperation>>,
) -> Result<Output, String>
where
    F: Fn() -> bool,
{
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("No se pudo iniciar {context}: {error}"))?;
    let _owned_process = if let Some(owner) = owner {
        match register_window_process(owner, child.id()) {
            Ok(guard) => Some(guard),
            Err(_) => {
                kill_process_tree(child.id());
                let _ = child.wait();
                return Err("preparation_cancelled".into());
            }
        }
    } else {
        None
    };
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("No se pudo leer la salida de {context}"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("No se pudo leer el diagnóstico de {context}"))?;
    let stdout_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = BufReader::new(stdout).read_to_end(&mut bytes);
        bytes
    });
    let stderr_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = BufReader::new(stderr).read_to_end(&mut bytes);
        bytes
    });
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            break status;
        }
        if is_cancelled()
            || owner.is_some_and(|operation| operation.cancelled.load(Ordering::SeqCst))
        {
            if owner.is_some() {
                kill_process_tree(child.id());
            } else {
                let _ = child.kill();
            }
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(if owner.is_some() {
                "preparation_cancelled"
            } else {
                "search_cancelled"
            }
            .into());
        }
        if started.elapsed() >= timeout {
            if owner.is_some() {
                kill_process_tree(child.id());
            } else {
                let _ = child.kill();
            }
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(format!(
                "{context} tardó demasiado y se canceló para evitar una carga infinita"
            ));
        }
        thread::sleep(Duration::from_millis(90));
    };
    Ok(Output {
        status,
        stdout: stdout_reader.join().unwrap_or_default(),
        stderr: stderr_reader.join().unwrap_or_default(),
    })
}
