use rusqlite::{params, Connection, OptionalExtension};
use std::fs;
use tauri::{AppHandle, State};

use super::{
    analyze_media_url_with_session_options, current_downloads_dir, kill_process_tree,
    mode_from_label, next_playlist_job, normalize_tiktok_source_value,
    playlist_batch_uses_legacy_removed_provider, playlist_destination_dir,
    read_playlist_runtime_item, read_playlist_runtime_items, resume_media_worker_when_idle,
    run_media_worker, sanitize_media_error_for_display, saved_media_session_for_db,
    shadow_pause_playlist, shadow_resume_playlist, shadow_retry_playlist,
    terminate_external_processes, validate_media_url,
};
use crate::{
    legacy_removed_provider_error, LocalState, PlaylistAlternativeInput, PlaylistQueueReceipt,
    PlaylistRuntimeSnapshot, PlaylistSelectionInput,
};

pub(crate) fn queue_playlist_selection(
    playlist_title: String,
    items: Vec<PlaylistSelectionInput>,
    format: String,
    app: AppHandle,
    state: State<'_, LocalState>,
) -> Result<PlaylistQueueReceipt, String> {
    let runtime = state.media_runtime.clone().ok_or_else(|| {
        "El motor multimedia local aún no está instalado en esta compilación".to_string()
    })?;
    let title = playlist_title.trim();
    if title.is_empty() {
        return Err("La playlist necesita un título".into());
    }
    if items.is_empty() || items.len() > 500 {
        return Err("Selecciona entre 1 y 500 elementos".into());
    }
    for item in &items {
        let candidate_url = if item.selected_source_url.trim().is_empty() {
            item.source_url.trim()
        } else {
            item.selected_source_url.trim()
        };
        if item.metadata_url.trim().is_empty() && candidate_url.is_empty() {
            return Err(
                "metadata_incomplete: el elemento no tiene origen ni fuente seleccionada".into(),
            );
        }
    }
    let (selector, output_mode) = mode_from_label(&format);
    let playlist_session = saved_media_session_for_db(&state.db_path);
    let playlist_dir = playlist_destination_dir(&current_downloads_dir(&state)?, title);
    fs::create_dir_all(&playlist_dir).map_err(|error| error.to_string())?;

    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "No se pudo bloquear la base local".to_string())?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction.execute(
        "INSERT INTO playlist_batches(title,format,status,current_position,updated_at) VALUES(?1,?2,'queued',0,CURRENT_TIMESTAMP)",
        params![title, format.trim()],
    ).map_err(|error| error.to_string())?;
    let batch_id = transaction.last_insert_rowid();
    for (position, item) in items.iter().enumerate() {
        let source_url = normalize_tiktok_source_value(&validate_media_url(
            if item.selected_source_url.trim().is_empty() {
                &item.source_url
            } else {
                &item.selected_source_url
            },
        )?);
        let item_title: String = if item.title.trim().is_empty() {
            format!("Elemento {}", position + 1)
        } else {
            item.title.trim().chars().take(200).collect()
        };
        let item_selector = if matches!(
            output_mode.as_str(),
            "audio_flac" | "audio_flac_hires" | "audio_flac_max"
        ) {
            let snapshot = analyze_media_url_with_session_options(
                source_url.clone(),
                app.clone(),
                playlist_session.clone(),
                None,
            )?;
            let candidate = snapshot
                .formats
                .iter()
                .find(|candidate| match output_mode.as_str() {
                    "audio_flac" => {
                        candidate.lossless
                            && candidate.sample_rate_hz.is_some_and(|rate| rate >= 44_100)
                    }
                    "audio_flac_hires" => {
                        candidate.lossless
                            && candidate.sample_rate_hz.is_some_and(|rate| rate > 48_000)
                    }
                    "audio_flac_max" => {
                        candidate.lossless
                            && candidate.sample_rate_hz.is_some_and(|rate| rate >= 176_400)
                    }
                    _ => false,
                })
                .ok_or_else(|| {
                    format!(
                        "{}: la fuente no ofrece audio lossless real para esa calidad",
                        item_title
                    )
                })?;
            candidate.id.clone()
        } else {
            selector.clone()
        };
        let selected_source_url = source_url.clone();
        transaction.execute(
            "INSERT INTO jobs(title,detail,progress,status,updated_at) VALUES(?1,'Esperando turno en la playlist',0,'queued',CURRENT_TIMESTAMP)",
            params![item_title],
        ).map_err(|error| error.to_string())?;
        let job_id = transaction.last_insert_rowid();
        transaction.execute(
            "INSERT INTO playlist_items(batch_id,source_id,source_url,metadata_url,selected_source_url,title,creator,thumbnail,duration_label,position,status,progress,job_id,resolution_state,provider_id)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'queued',0,?11,'download_queued',?12)",
             params![batch_id, item.source_id.trim(), source_url, item.metadata_url.trim(), selected_source_url, item_title, item.creator.trim(), item.thumbnail.trim(), item.duration_label.trim(), position as i64, job_id, item.provider_id.trim()],
        ).map_err(|error| error.to_string())?;
        let playlist_item_id = transaction.last_insert_rowid();
        transaction.execute(
            "INSERT INTO media_jobs(job_id,source_url,download_url,metadata_url,provider_id,resolution_state,format_selector,output_mode,destination_dir,expected_duration_seconds,playlist_batch_id,playlist_item_id,artist,thumbnail)
             VALUES(?1,?2,?2,?3,?4,'download_queued',?5,?6,?7,?8,?9,?10,?11,?12)",
            params![job_id, source_url, item.metadata_url.trim(), item.provider_id.trim(), item_selector, output_mode, playlist_dir.to_string_lossy().to_string(), item.expected_duration_seconds, batch_id, playlist_item_id, item.creator.trim(), item.thumbnail.trim()],
        ).map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    drop(connection);
    if let Some(job_id) = next_playlist_job(
        &Connection::open(&state.db_path).map_err(|error| error.to_string())?,
        batch_id,
    ) {
        run_media_worker(
            state.db_path.clone(),
            runtime,
            state.active_media_pids.clone(),
            state.external_processes.clone(),
            job_id,
        );
    }
    Ok(PlaylistQueueReceipt {
        batch_id,
        item_count: items.len(),
        sequential: true,
    })
}
pub(crate) fn set_playlist_batch_paused(
    batch_id: i64,
    paused: bool,
    state: State<'_, LocalState>,
) -> Result<(), String> {
    let runtime = state
        .media_runtime
        .clone()
        .ok_or_else(|| "El motor multimedia local no está disponible".to_string())?;
    let connection = state
        .connection
        .lock()
        .map_err(|_| "No se pudo bloquear la base local".to_string())?;
    if !paused && playlist_batch_uses_legacy_removed_provider(&connection, batch_id)? {
        return Err(legacy_removed_provider_error());
    }
    let job_id = connection
        .query_row(
            "SELECT job_id FROM playlist_items WHERE batch_id=?1 AND status IN ('running','paused','queued') AND job_id IS NOT NULL ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, position LIMIT 1",
            params![batch_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "La playlist no tiene una tarea activa o pendiente".to_string())?;
    let active_job_ids = {
        let mut statement = connection
            .prepare("SELECT job_id FROM playlist_items WHERE batch_id=?1 AND status='running' AND job_id IS NOT NULL")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![batch_id], |row| row.get::<_, i64>(0))
            .map_err(|error| error.to_string())?
            .filter_map(Result::ok)
            .collect::<Vec<_>>();
        rows
    };

    if paused {
        connection
            .execute(
                "UPDATE playlist_batches SET status='paused',updated_at=CURRENT_TIMESTAMP WHERE id=?1",
                params![batch_id],
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "UPDATE jobs SET status='paused',detail='En pausa · archivos parciales conservados',updated_at=CURRENT_TIMESTAMP WHERE id IN (SELECT job_id FROM playlist_items WHERE batch_id=?1) AND status NOT IN ('completed','cancelled','failed')",
                params![batch_id],
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "UPDATE playlist_items SET status='paused' WHERE batch_id=?1 AND status NOT IN ('completed','cancelled','failed')",
                params![batch_id],
            )
            .map_err(|error| error.to_string())?;
        drop(connection);
        shadow_pause_playlist(batch_id);
        if let Ok(active) = state.active_media_pids.lock() {
            for active_job_id in active_job_ids {
                if let Some(pid) = active.get(&active_job_id).copied().filter(|pid| *pid > 0) {
                    kill_process_tree(pid);
                }
                terminate_external_processes(&state.external_processes, active_job_id);
            }
        }
        return Ok(());
    }

    connection
        .execute(
            "UPDATE playlist_batches SET status='running',updated_at=CURRENT_TIMESTAMP WHERE id=?1",
            params![batch_id],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "UPDATE jobs SET status='queued',detail='Reanudando elemento de la playlist…',updated_at=CURRENT_TIMESTAMP WHERE id IN (SELECT job_id FROM playlist_items WHERE batch_id=?1) AND status='paused'",
            params![batch_id],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "UPDATE playlist_items SET status='queued' WHERE batch_id=?1 AND status='paused'",
            params![batch_id],
        )
        .map_err(|error| error.to_string())?;
    drop(connection);
    shadow_resume_playlist(batch_id);
    resume_media_worker_when_idle(
        state.db_path.clone(),
        runtime,
        state.active_media_pids.clone(),
        state.external_processes.clone(),
        job_id,
    );
    Ok(())
}
pub(crate) fn retry_failed_playlist_items(
    batch_id: i64,
    state: State<'_, LocalState>,
) -> Result<usize, String> {
    let runtime = state
        .media_runtime
        .clone()
        .ok_or_else(|| "El motor multimedia local no está disponible".to_string())?;
    let connection = state
        .connection
        .lock()
        .map_err(|_| "No se pudo bloquear la base local".to_string())?;
    if playlist_batch_uses_legacy_removed_provider(&connection, batch_id)? {
        return Err(legacy_removed_provider_error());
    }
    let affected = connection
        .execute(
            "UPDATE jobs SET status='queued',progress=0,detail='Reintentando elemento de la playlist…',updated_at=CURRENT_TIMESTAMP WHERE id IN (SELECT job_id FROM playlist_items WHERE batch_id=?1 AND status='failed')",
            params![batch_id],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "UPDATE playlist_items SET status='queued',progress=0,output_path=NULL WHERE batch_id=?1 AND status='failed'",
            params![batch_id],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "UPDATE media_jobs SET error=NULL,output_path=NULL,updated_at=CURRENT_TIMESTAMP WHERE playlist_batch_id=?1 AND job_id IN (SELECT job_id FROM playlist_items WHERE batch_id=?1 AND status='queued')",
            params![batch_id],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "UPDATE playlist_batches SET status='queued',updated_at=CURRENT_TIMESTAMP WHERE id=?1",
            params![batch_id],
        )
        .map_err(|error| error.to_string())?;
    let first_job = next_playlist_job(&connection, batch_id);
    drop(connection);
    shadow_retry_playlist(batch_id);
    if let Some(job_id) = first_job {
        run_media_worker(
            state.db_path.clone(),
            runtime,
            state.active_media_pids.clone(),
            state.external_processes.clone(),
            job_id,
        );
    }
    Ok(affected)
}
pub(crate) fn playlist_runtime_snapshot(
    batch_id: i64,
    state: State<'_, LocalState>,
) -> Result<PlaylistRuntimeSnapshot, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "No se pudo bloquear la base local".to_string())?;
    let (title, format, status): (String, String, String) = connection
        .query_row(
            "SELECT title,format,status FROM playlist_batches WHERE id=?1",
            params![batch_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|_| "La playlist ya no existe".to_string())?;
    let (total, completed, failed): (i64, i64, i64) = connection.query_row(
        "SELECT COUNT(*),SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END),SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) FROM playlist_items WHERE batch_id=?1",
        params![batch_id],
        |row| Ok((row.get(0)?, row.get::<_, Option<i64>>(1)?.unwrap_or(0), row.get::<_, Option<i64>>(2)?.unwrap_or(0))),
    ).map_err(|error| error.to_string())?;
    let current = read_playlist_runtime_item(
        &connection,
        "SELECT pi.id,pi.job_id,pi.source_id,pi.source_url,pi.position,pi.title,pi.creator,pi.thumbnail,pi.duration_label,pi.status,pi.progress,COALESCE(j.detail,''),COALESCE(mj.error,'') FROM playlist_items pi LEFT JOIN jobs j ON j.id=pi.job_id LEFT JOIN media_jobs mj ON mj.job_id=pi.job_id WHERE pi.batch_id=?1 AND pi.status IN ('running','paused') ORDER BY pi.position LIMIT 1",
        batch_id,
    )?.or_else(|| read_playlist_runtime_item(
        &connection,
        "SELECT pi.id,pi.job_id,pi.source_id,pi.source_url,pi.position,pi.title,pi.creator,pi.thumbnail,pi.duration_label,pi.status,pi.progress,COALESCE(j.detail,''),COALESCE(mj.error,'') FROM playlist_items pi LEFT JOIN jobs j ON j.id=pi.job_id LEFT JOIN media_jobs mj ON mj.job_id=pi.job_id WHERE pi.batch_id=?1 AND pi.status='queued' ORDER BY pi.position LIMIT 1",
        batch_id,
    ).ok().flatten());
    let next = read_playlist_runtime_item(
        &connection,
        "SELECT pi.id,pi.job_id,pi.source_id,pi.source_url,pi.position,pi.title,pi.creator,pi.thumbnail,pi.duration_label,pi.status,pi.progress,COALESCE(j.detail,''),COALESCE(mj.error,'') FROM playlist_items pi LEFT JOIN jobs j ON j.id=pi.job_id LEFT JOIN media_jobs mj ON mj.job_id=pi.job_id WHERE pi.batch_id=?1 AND pi.status='queued' AND pi.job_id != COALESCE((SELECT job_id FROM playlist_items WHERE batch_id=?1 AND status IN ('running','paused') ORDER BY position LIMIT 1),(SELECT job_id FROM playlist_items WHERE batch_id=?1 AND status='queued' ORDER BY position LIMIT 1),-1) ORDER BY pi.position LIMIT 1",
        batch_id,
    )?;
    let upcoming = read_playlist_runtime_items(
        &connection,
        "SELECT pi.id,pi.job_id,pi.source_id,pi.source_url,pi.position,pi.title,pi.creator,pi.thumbnail,pi.duration_label,pi.status,pi.progress,COALESCE(j.detail,''),COALESCE(mj.error,'') FROM playlist_items pi LEFT JOIN jobs j ON j.id=pi.job_id LEFT JOIN media_jobs mj ON mj.job_id=pi.job_id WHERE pi.batch_id=?1 AND pi.status='queued' AND pi.job_id != COALESCE((SELECT job_id FROM playlist_items WHERE batch_id=?1 AND status IN ('running','paused') ORDER BY position LIMIT 1),(SELECT job_id FROM playlist_items WHERE batch_id=?1 AND status='queued' ORDER BY position LIMIT 1),-1) ORDER BY pi.position LIMIT 8",
        batch_id,
    )?;
    let last_error = connection
        .query_row(
            "SELECT mj.error FROM media_jobs mj JOIN playlist_items pi ON pi.job_id=mj.job_id WHERE pi.batch_id=?1 AND mj.error IS NOT NULL AND TRIM(mj.error)<>'' ORDER BY pi.position LIMIT 1",
            params![batch_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .map(|error| sanitize_media_error_for_display(&error));
    let failed_item = read_playlist_runtime_item(
        &connection,
        "SELECT pi.id,pi.job_id,pi.source_id,pi.source_url,pi.position,pi.title,pi.creator,pi.thumbnail,pi.duration_label,pi.status,pi.progress,COALESCE(j.detail,''),COALESCE(mj.error,'') FROM playlist_items pi LEFT JOIN jobs j ON j.id=pi.job_id LEFT JOIN media_jobs mj ON mj.job_id=pi.job_id WHERE pi.batch_id=?1 AND pi.status='failed' ORDER BY pi.position LIMIT 1",
        batch_id,
    )?;
    Ok(PlaylistRuntimeSnapshot {
        batch_id,
        title,
        format,
        status,
        total,
        completed,
        failed,
        last_error,
        failed_item,
        current,
        next,
        upcoming,
    })
}
pub(crate) fn replace_playlist_item_with_alternative(
    input: PlaylistAlternativeInput,
    state: State<'_, LocalState>,
) -> Result<(), String> {
    let runtime = state.media_runtime.clone().ok_or_else(|| {
        "El motor multimedia local aún no está instalado en esta compilación".to_string()
    })?;
    let source_url = normalize_tiktok_source_value(&validate_media_url(&input.source_url)?);
    let title = if input.title.trim().is_empty() {
        "Alternativa multimedia".to_string()
    } else {
        input.title.trim().chars().take(200).collect::<String>()
    };
    let creator = input.creator.unwrap_or_default();
    let thumbnail = input.thumbnail.unwrap_or_default();
    let duration_label = input.duration_label.unwrap_or_default();
    let connection = state
        .connection
        .lock()
        .map_err(|_| "No se pudo bloquear la base local".to_string())?;
    let (batch_id, item_id): (i64, i64) = connection
        .query_row(
            "SELECT playlist_batch_id,playlist_item_id FROM media_jobs WHERE job_id=?1 AND playlist_batch_id IS NOT NULL AND playlist_item_id IS NOT NULL",
            params![input.job_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "El elemento de playlist ya no existe".to_string())?;
    connection
        .execute(
            "UPDATE jobs SET title=?1,detail='Alternativa seleccionada · esperando turno',progress=0,status='queued',updated_at=CURRENT_TIMESTAMP WHERE id=?2",
            params![title, input.job_id],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "UPDATE media_jobs SET source_url=?1,expected_duration_seconds=?2,output_path=NULL,error=NULL,updated_at=CURRENT_TIMESTAMP WHERE job_id=?3",
            params![source_url, input.expected_duration_seconds, input.job_id],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "UPDATE playlist_items SET source_url=?1,title=?2,creator=?3,thumbnail=?4,duration_label=?5,status='queued',progress=0,output_path=NULL WHERE id=?6",
            params![source_url, title, creator.trim(), thumbnail.trim(), duration_label.trim(), item_id],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "UPDATE playlist_batches SET status='queued',updated_at=CURRENT_TIMESTAMP WHERE id=?1",
            params![batch_id],
        )
        .map_err(|error| error.to_string())?;
    let has_active: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM playlist_items WHERE batch_id=?1 AND status IN ('running','paused')",
            params![batch_id],
            |row| row.get(0),
        )
        .unwrap_or(0);
    drop(connection);
    if has_active == 0 {
        run_media_worker(
            state.db_path.clone(),
            runtime,
            state.active_media_pids.clone(),
            state.external_processes.clone(),
            input.job_id,
        );
    }
    Ok(())
}
