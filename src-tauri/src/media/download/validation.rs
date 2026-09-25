use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use rusqlite::Connection;
use serde_json::Value;

use super::progress::{ensure_media_job_running, set_media_processing_stage};
use super::worker::{minimum_acceptable_duration, wait_for_stable_file};
use crate::progress::adapter::{shadow_begin_ffmpeg, shadow_observe_ffmpeg_line};
use crate::{
    background_command, json_number, supervised_command_output,
    supervised_command_output_with_progress, ExternalProcessKind, ExternalProcessRegistry,
    MediaRuntimePaths,
};
pub(crate) fn run_ffmpeg_validation(
    command: &mut Command,
    external_processes: &ExternalProcessRegistry,
    id: i64,
    context: &str,
) -> Result<(), String> {
    let output = supervised_command_output(
        command,
        external_processes,
        id,
        ExternalProcessKind::Ffmpeg,
        &format!("la comprobación de {context} con FFmpeg"),
    )?;
    if output.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr)
        .trim()
        .chars()
        .take(600)
        .collect::<String>();
    Err(if detail.is_empty() {
        format!("FFmpeg detectó daños al comprobar {context}")
    } else {
        format!("FFmpeg detectó un archivo dañado al comprobar {context}: {detail}")
    })
}

pub(crate) fn run_ffmpeg_live(
    command: &mut Command,
    external_processes: &ExternalProcessRegistry,
    id: i64,
    stage: crate::progress::model::ProcessingStage,
    duration_seconds: Option<f64>,
    context: &str,
) -> Result<Output, String> {
    shadow_begin_ffmpeg(id, stage, duration_seconds);
    supervised_command_output_with_progress(
        command,
        external_processes,
        id,
        ExternalProcessKind::Ffmpeg,
        context,
        |line| shadow_observe_ffmpeg_line(id, line),
    )
}

pub(crate) fn validate_media_packets(
    runtime: &MediaRuntimePaths,
    path: &Path,
    connection: &Connection,
    external_processes: &ExternalProcessRegistry,
    id: i64,
) -> Result<(), String> {
    ensure_media_job_running(connection, id)?;
    let ffmpeg = runtime.ffmpeg_dir.join(if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    });
    let mut command = background_command(ffmpeg);
    command
        .args(["-hide_banner", "-loglevel", "error", "-i"])
        .arg(path)
        .args([
            "-map", "0:v?", "-map", "0:a?", "-c", "copy", "-f", "null", "-",
        ]);
    run_ffmpeg_validation(
        &mut command,
        external_processes,
        id,
        "la estructura completa del archivo",
    )
}

pub(crate) fn duration_needs_normalization(
    container_duration: f64,
    expected_duration: Option<f64>,
) -> bool {
    expected_duration.is_some_and(|expected| {
        expected.is_finite()
            && expected >= 0.5
            && container_duration.is_finite()
            && container_duration > expected * 1.5
            && container_duration - expected > 2.0
    })
}

pub(crate) fn validate_decodable_samples(
    runtime: &MediaRuntimePaths,
    path: &Path,
    duration: f64,
    expected_duration_seconds: Option<f64>,
    connection: &Connection,
    external_processes: &ExternalProcessRegistry,
    id: i64,
) -> Result<(), String> {
    let ffmpeg = runtime.ffmpeg_dir.join(if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    });
    let mut offsets = vec![0.0];
    // Some platform responses expose a bogus video timebase (TikTok is a
    // known example): ffprobe can report several minutes while the source
    // metadata says the item is only a few seconds long. Sampling that fake
    // tail produces thousands of misleading H.264 diagnostics. The caller
    // normalizes an MP4 with this mismatch before validation; keep this cap as
    // a second guard for other containers and recovery paths.
    let sampling_duration = expected_duration_seconds
        .filter(|expected| duration_needs_normalization(duration, Some(*expected)))
        .unwrap_or(duration);
    if sampling_duration > 16.0 {
        offsets.push((sampling_duration / 2.0 - 3.0).max(0.0));
        offsets.push((sampling_duration - 6.0).max(0.0));
    } else if sampling_duration > 7.0 {
        offsets.push((sampling_duration - 5.0).max(0.0));
    }
    offsets.sort_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal));
    offsets.dedup_by(|left, right| (*left - *right).abs() < 0.5);

    for (index, offset) in offsets.into_iter().enumerate() {
        ensure_media_job_running(connection, id)?;
        let mut command = background_command(&ffmpeg);
        command.args(["-hide_banner", "-loglevel", "error"]);
        if offset > 0.0 {
            command.arg("-ss").arg(format!("{offset:.3}"));
        }
        command
            .arg("-i")
            .arg(path)
            .args(["-t", "5", "-map", "0:v?", "-map", "0:a?", "-f", "null", "-"]);
        run_ffmpeg_validation(
            &mut command,
            external_processes,
            id,
            &format!("la muestra reproducible {}", index + 1),
        )?;
    }
    Ok(())
}

pub(crate) fn ensure_windows_compatible_mp4(
    runtime: &MediaRuntimePaths,
    path: &Path,
    connection: &Connection,
    id: i64,
    external_processes: &ExternalProcessRegistry,
    expected_duration_seconds: Option<f64>,
) -> Result<PathBuf, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    // yt-dlp already muxes video_mp4 jobs to an MP4 container. Re-encoding a
    // valid 1440p/2160p MP4 merely to force H.264/AAC can take many minutes and
    // changes both quality and file size. Preserve the completed MP4 as-is,
    // except when a source reports a reliable duration but its container has a
    // corrupt timestamp tail. That exact mismatch makes FFmpeg fail only near
    // the end of otherwise playable TikTok downloads.
    if extension == "mp4" {
        let Some(expected) =
            expected_duration_seconds.filter(|value| value.is_finite() && *value >= 0.5)
        else {
            return Ok(path.to_path_buf());
        };
        let ffprobe = runtime.ffmpeg_dir.join(if cfg!(windows) {
            "ffprobe.exe"
        } else {
            "ffprobe"
        });
        let mut probe_command = background_command(ffprobe);
        probe_command
            .args([
                "-v",
                "error",
                "-show_entries",
                "format=duration:stream=duration",
                "-of",
                "json",
            ])
            .arg(path);
        let probe = supervised_command_output(
            &mut probe_command,
            external_processes,
            id,
            ExternalProcessKind::Ffprobe,
            "la comprobacion de la duracion del MP4",
        )?;
        if !probe.status.success() {
            return Ok(path.to_path_buf());
        }
        let container_duration = serde_json::from_slice::<Value>(&probe.stdout)
            .ok()
            .map(|json| {
                let format_duration =
                    json_number(json.get("format").and_then(|format| format.get("duration")))
                        .unwrap_or(0.0);
                let stream_duration = json
                    .get("streams")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|stream| json_number(stream.get("duration")))
                    .fold(0.0, f64::max);
                format_duration.max(stream_duration)
            })
            .unwrap_or(0.0);
        if !duration_needs_normalization(container_duration, Some(expected)) {
            return Ok(path.to_path_buf());
        }

        let stem = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("video");
        let normalized = path.with_file_name(format!("{stem}.cacatools-normalized.mp4"));
        let _ = fs::remove_file(&normalized);
        set_media_processing_stage(
            connection,
            id,
            "converting",
            "Corrigiendo la duracion del contenedor multimedia...",
        );
        ensure_media_job_running(connection, id)?;
        let ffmpeg = runtime.ffmpeg_dir.join(if cfg!(windows) {
            "ffmpeg.exe"
        } else {
            "ffmpeg"
        });
        let mut normalize_command = background_command(&ffmpeg);
        normalize_command
            .args(["-y", "-hide_banner", "-loglevel", "error", "-i"])
            .arg(path)
            .args([
                "-t",
                &format!("{expected:.3}"),
                "-map",
                "0:v:0",
                "-map",
                "0:a:0?",
                "-c",
                "copy",
                "-movflags",
                "+faststart",
                "-map_metadata",
                "0",
            ])
            .args(["-progress", "pipe:1"])
            .arg(&normalized);
        let output = run_ffmpeg_live(
            &mut normalize_command,
            external_processes,
            id,
            crate::progress::model::ProcessingStage::Remuxing,
            Some(expected),
            "la normalizacion de la duracion multimedia",
        )?;
        if !output.status.success()
            || normalized.metadata().map(|value| value.len()).unwrap_or(0) < 32 * 1024
        {
            let _ = fs::remove_file(&normalized);
            return Err("FFmpeg no pudo normalizar la duracion del archivo multimedia".into());
        }
        ensure_media_job_running(connection, id)?;
        fs::remove_file(path).map_err(|error| {
            format!("No se pudo sustituir el contenedor multimedia defectuoso: {error}")
        })?;
        return Ok(normalized);
    }

    set_media_processing_stage(connection, id, "converting", "Preparando contenedor MP4…");
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("video");
    let converted = path.with_file_name(format!("{stem}.cacatools-converting.mp4"));
    let ffmpeg = runtime.ffmpeg_dir.join(if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    });

    ensure_media_job_running(connection, id)?;
    let mut copy_command = background_command(&ffmpeg);
    copy_command
        .args(["-y", "-hide_banner", "-loglevel", "error", "-i"])
        .arg(path)
        .args([
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            "-map_metadata",
            "0",
        ])
        .args(["-progress", "pipe:1"])
        .arg(&converted);
    let copy_output = run_ffmpeg_live(
        &mut copy_command,
        external_processes,
        id,
        crate::progress::model::ProcessingStage::Remuxing,
        expected_duration_seconds,
        "la preparación del MP4",
    )?;

    if !copy_output.status.success() {
        let _ = fs::remove_file(&converted);
        set_media_processing_stage(
            connection,
            id,
            "converting",
            "El contenedor necesita conversión de compatibilidad…",
        );
        ensure_media_job_running(connection, id)?;
        let mut transcode_command = background_command(&ffmpeg);
        transcode_command
            .args(["-y", "-hide_banner", "-loglevel", "error", "-i"])
            .arg(path)
            .args([
                "-map",
                "0:v:0",
                "-map",
                "0:a:0?",
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "20",
                "-pix_fmt",
                "yuv420p",
                "-tag:v",
                "avc1",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-movflags",
                "+faststart",
                "-map_metadata",
                "0",
            ])
            .args(["-progress", "pipe:1"])
            .arg(&converted);
        let transcode_output = run_ffmpeg_live(
            &mut transcode_command,
            external_processes,
            id,
            crate::progress::model::ProcessingStage::Converting,
            expected_duration_seconds,
            "la conversión del vídeo a MP4",
        )?;
        if !transcode_output.status.success() {
            let detail = String::from_utf8_lossy(&transcode_output.stderr)
                .trim()
                .chars()
                .take(700)
                .collect::<String>();
            return Err(if detail.is_empty() {
                "FFmpeg no pudo generar el MP4 final".into()
            } else {
                format!("FFmpeg no pudo generar el MP4 final: {detail}")
            });
        }
    }

    if converted.metadata().map(|value| value.len()).unwrap_or(0) < 32 * 1024 {
        let _ = fs::remove_file(&converted);
        return Err("La preparación del MP4 produjo un archivo incompleto".into());
    }
    Ok(converted)
}

pub(crate) fn validate_downloaded_media(
    runtime: &MediaRuntimePaths,
    path: &Path,
    output_mode: &str,
    expected_duration_seconds: Option<f64>,
    connection: &Connection,
    external_processes: &ExternalProcessRegistry,
    id: i64,
) -> Result<(), String> {
    ensure_media_job_running(connection, id)?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(extension.as_str(), "part" | "ytdl" | "tmp" | "temp") {
        return Err("yt-dlp informó un archivo temporal en lugar del resultado final".into());
    }
    let size = wait_for_stable_file(path)?;
    let minimum_size = if expected_duration_seconds.unwrap_or(0.0) >= 30.0 {
        128 * 1024
    } else {
        32 * 1024
    };
    if size < minimum_size {
        return Err("El archivo generado es demasiado pequeño y parece incompleto".into());
    }

    let ffprobe = runtime.ffmpeg_dir.join(if cfg!(windows) {
        "ffprobe.exe"
    } else {
        "ffprobe"
    });
    let mut probe_command = background_command(ffprobe);
    probe_command
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration,format_name,size:stream=codec_type,codec_name,duration",
            "-of",
            "json",
        ])
        .arg(path);
    set_media_processing_stage(
        connection,
        id,
        "probing",
        "Inspeccionando el archivo final…",
    );
    let probe = supervised_command_output(
        &mut probe_command,
        external_processes,
        id,
        ExternalProcessKind::Ffprobe,
        "la validación del archivo con FFprobe",
    )?;
    if !probe.status.success() {
        let detail = String::from_utf8_lossy(&probe.stderr)
            .trim()
            .chars()
            .take(500)
            .collect::<String>();
        return Err(if detail.is_empty() {
            "FFprobe detectó un archivo multimedia inválido".into()
        } else {
            format!("Archivo multimedia inválido: {detail}")
        });
    }

    let json: Value = serde_json::from_slice(&probe.stdout)
        .map_err(|error| format!("FFprobe devolvió datos inválidos: {error}"))?;
    let format = json.get("format");
    let format_duration =
        json_number(format.and_then(|entry| entry.get("duration"))).unwrap_or(0.0);
    let format_name = format
        .and_then(|entry| entry.get("format_name"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let streams = json
        .get("streams")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let has_audio = streams
        .iter()
        .any(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("audio"));
    let has_video = streams
        .iter()
        .any(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("video"));
    let stream_duration = streams
        .iter()
        .filter_map(|stream| json_number(stream.get("duration")))
        .fold(0.0, f64::max);
    let duration = format_duration.max(stream_duration);

    if format_name.trim().is_empty() || !duration.is_finite() || duration < 0.5 {
        return Err(
            "El archivo final no contiene un contenedor o una duración reproducible".into(),
        );
    }
    set_media_processing_stage(
        connection,
        id,
        "validating",
        "Verificando el archivo final…",
    );
    if output_mode.starts_with("audio_") && !has_audio {
        return Err("El archivo final no contiene una pista de audio reproducible".into());
    }
    if output_mode.starts_with("video_") && (!has_video || !has_audio) {
        return Err("El archivo final no contiene las pistas de vídeo y audio solicitadas".into());
    }
    if output_mode == "source" && !has_audio && !has_video {
        return Err("El archivo final no contiene pistas multimedia".into());
    }
    if let Some(minimum_duration) = minimum_acceptable_duration(expected_duration_seconds) {
        if duration + 0.25 < minimum_duration {
            return Err(format!(
                "El archivo solo dura {:.1}s; se esperaban al menos {:.1}s según el análisis previo",
                duration, minimum_duration
            ));
        }
    }
    ensure_media_job_running(connection, id)?;
    validate_media_packets(runtime, path, connection, external_processes, id)?;
    validate_decodable_samples(
        runtime,
        path,
        duration,
        expected_duration_seconds,
        connection,
        external_processes,
        id,
    )?;
    Ok(())
}
