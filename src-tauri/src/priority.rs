use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use tauri::State;

use crate::{dispatcher, LocalState};

pub(crate) const MAX_PRIORITY_TARGETS: usize = 256;

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum DownloadPriority {
    High,
    #[default]
    Normal,
    Low,
}

impl DownloadPriority {
    pub(crate) fn from_persisted(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "high" => Self::High,
            "low" => Self::Low,
            _ => Self::Normal,
        }
    }

    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::High => "high",
            Self::Normal => "normal",
            Self::Low => "low",
        }
    }

    #[cfg(test)]
    pub(crate) const fn rank(self) -> u8 {
        match self {
            Self::High => 0,
            Self::Normal => 1,
            Self::Low => 2,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum DownloadPriorityTarget {
    Job { job_id: i64 },
    Playlist { batch_id: i64 },
}

impl DownloadPriorityTarget {
    fn id(&self) -> i64 {
        match self {
            Self::Job { job_id } => *job_id,
            Self::Playlist { batch_id } => *batch_id,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadPriorityReceipt {
    priority: DownloadPriority,
    updated_targets: usize,
    updated_jobs: usize,
}

fn validate_targets(
    connection: &Connection,
    targets: Vec<DownloadPriorityTarget>,
) -> Result<Vec<DownloadPriorityTarget>, String> {
    if targets.is_empty() {
        return Err("Selecciona al menos una descarga".into());
    }
    if targets.len() > MAX_PRIORITY_TARGETS {
        return Err(format!(
            "Solo se pueden actualizar hasta {MAX_PRIORITY_TARGETS} descargas a la vez"
        ));
    }

    let mut unique = Vec::with_capacity(targets.len());
    let mut seen = HashSet::with_capacity(targets.len());
    for target in targets {
        if target.id() <= 0 {
            return Err("La descarga seleccionada no es válida".into());
        }
        if seen.insert(target.clone()) {
            unique.push(target);
        }
    }

    for target in &unique {
        match target {
            DownloadPriorityTarget::Job { job_id } => {
                let playlist_batch_id = connection
                    .query_row(
                        "SELECT media_jobs.playlist_batch_id FROM jobs LEFT JOIN media_jobs ON media_jobs.job_id=jobs.id WHERE jobs.id=?1",
                        params![job_id],
                        |row| row.get::<_, Option<i64>>(0),
                    )
                    .optional()
                    .map_err(|error| error.to_string())?;
                let Some(playlist_batch_id) = playlist_batch_id else {
                    return Err(format!("La descarga #{job_id} ya no existe"));
                };
                if playlist_batch_id.is_some() {
                    return Err(
                        "La prioridad de una playlist se cambia desde su tarjeta principal".into(),
                    );
                }
            }
            DownloadPriorityTarget::Playlist { batch_id } => {
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
            }
        }
    }
    Ok(unique)
}

pub(crate) fn update_download_priorities(
    connection: &mut Connection,
    targets: Vec<DownloadPriorityTarget>,
    priority: DownloadPriority,
) -> Result<DownloadPriorityReceipt, String> {
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let targets = validate_targets(&transaction, targets)?;
    let mut updated_jobs = 0usize;
    for target in &targets {
        match target {
            DownloadPriorityTarget::Job { job_id } => {
                updated_jobs += transaction
                    .execute(
                        "UPDATE jobs SET priority=?1 WHERE id=?2",
                        params![priority.as_str(), job_id],
                    )
                    .map_err(|error| error.to_string())?;
            }
            DownloadPriorityTarget::Playlist { batch_id } => {
                transaction
                    .execute(
                        "UPDATE playlist_batches SET priority=?1 WHERE id=?2",
                        params![priority.as_str(), batch_id],
                    )
                    .map_err(|error| error.to_string())?;
                updated_jobs += transaction
                    .execute(
                        "UPDATE jobs SET priority=?1 WHERE id IN (SELECT job_id FROM playlist_items WHERE batch_id=?2 AND job_id IS NOT NULL)",
                        params![priority.as_str(), batch_id],
                    )
                    .map_err(|error| error.to_string())?;
            }
        }
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(DownloadPriorityReceipt {
        priority,
        updated_targets: targets.len(),
        updated_jobs,
    })
}

pub(crate) fn set_download_priority(
    targets: Vec<DownloadPriorityTarget>,
    priority: DownloadPriority,
    state: State<'_, LocalState>,
) -> Result<DownloadPriorityReceipt, String> {
    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "No se pudo bloquear la base local".to_string())?;
    let receipt = update_download_priorities(&mut connection, targets, priority)?;
    drop(connection);
    dispatcher::wake_if_installed();
    Ok(receipt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migrate;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn database() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        connection
    }

    fn add_job(connection: &Connection, title: &str) -> i64 {
        connection
            .execute(
                "INSERT INTO jobs(title,status) VALUES(?1,'queued')",
                params![title],
            )
            .unwrap();
        connection.last_insert_rowid()
    }

    #[test]
    fn persisted_values_have_closed_ranks_and_safe_fallback() {
        assert_eq!(DownloadPriority::High.rank(), 0);
        assert_eq!(DownloadPriority::Normal.rank(), 1);
        assert_eq!(DownloadPriority::Low.rank(), 2);
        assert_eq!(
            DownloadPriority::from_persisted("HIGH"),
            DownloadPriority::High
        );
        assert_eq!(
            DownloadPriority::from_persisted("unexpected"),
            DownloadPriority::Normal
        );
    }

    #[test]
    fn migration_defaults_historical_jobs_and_reopens() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "cacatools-priority-{}-{nonce}.sqlite",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        {
            let connection = Connection::open(&path).unwrap();
            connection
                .execute_batch(
                    "CREATE TABLE jobs(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '',progress REAL NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'queued',cancel_cleanup INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);",
                )
                .unwrap();
            connection
                .execute("INSERT INTO jobs(title) VALUES('historical')", [])
                .unwrap();
            migrate(&connection).unwrap();
            migrate(&connection).unwrap();
        }
        let connection = Connection::open(&path).unwrap();
        let value: String = connection
            .query_row("SELECT priority FROM jobs WHERE id=1", [], |row| row.get(0))
            .unwrap();
        assert_eq!(value, "normal");
        drop(connection);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn batch_is_deduplicated_and_transactional() {
        let mut connection = database();
        let first = add_job(&connection, "first");
        let second = add_job(&connection, "second");
        let receipt = update_download_priorities(
            &mut connection,
            vec![
                DownloadPriorityTarget::Job { job_id: first },
                DownloadPriorityTarget::Job { job_id: first },
                DownloadPriorityTarget::Job { job_id: second },
            ],
            DownloadPriority::High,
        )
        .unwrap();
        assert_eq!(receipt.updated_targets, 2);
        assert_eq!(receipt.updated_jobs, 2);

        let error = update_download_priorities(
            &mut connection,
            vec![
                DownloadPriorityTarget::Job { job_id: first },
                DownloadPriorityTarget::Job { job_id: 999 },
            ],
            DownloadPriority::Low,
        )
        .unwrap_err();
        assert!(error.contains("999"));
        let value: String = connection
            .query_row(
                "SELECT priority FROM jobs WHERE id=?1",
                params![first],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(value, "high");
    }

    #[test]
    fn playlist_parent_updates_all_children_in_one_operation() {
        let mut connection = database();
        connection
            .execute(
                "INSERT INTO playlist_batches(title,format) VALUES('list','audio')",
                [],
            )
            .unwrap();
        let batch_id = connection.last_insert_rowid();
        let mut child_ids = Vec::new();
        for position in 0..2 {
            let job_id = add_job(&connection, &format!("item-{position}"));
            child_ids.push(job_id);
            connection
                .execute(
                    "INSERT INTO playlist_items(batch_id,source_id,position,job_id) VALUES(?1,?2,?3,?4)",
                    params![batch_id, format!("source-{position}"), position, job_id],
                )
                .unwrap();
        }
        let default_parent: String = connection
            .query_row(
                "SELECT priority FROM playlist_batches WHERE id=?1",
                params![batch_id],
                |row| row.get(0),
            )
            .unwrap();
        let default_children: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM jobs WHERE priority='normal' AND id IN (SELECT job_id FROM playlist_items WHERE batch_id=?1)",
                params![batch_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(default_parent, "normal");
        assert_eq!(default_children, 2);
        connection
            .execute(
                "UPDATE jobs SET status='running' WHERE id=?1",
                params![child_ids[0]],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE jobs SET status='failed' WHERE id=?1",
                params![child_ids[1]],
            )
            .unwrap();
        update_download_priorities(
            &mut connection,
            vec![DownloadPriorityTarget::Playlist { batch_id }],
            DownloadPriority::Low,
        )
        .unwrap();
        let parent: String = connection
            .query_row(
                "SELECT priority FROM playlist_batches WHERE id=?1",
                params![batch_id],
                |row| row.get(0),
            )
            .unwrap();
        let children: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM jobs WHERE priority='low' AND id IN (SELECT job_id FROM playlist_items WHERE batch_id=?1)",
                params![batch_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(parent, "low");
        assert_eq!(children, 2);
        let statuses: Vec<(String, String)> = {
            let mut statement = connection
                .prepare("SELECT status,priority FROM jobs WHERE id IN (?1,?2) ORDER BY id")
                .unwrap();
            statement
                .query_map(params![child_ids[0], child_ids[1]], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })
                .unwrap()
                .flatten()
                .collect()
        };
        assert_eq!(
            statuses,
            vec![
                ("running".to_string(), "low".to_string()),
                ("failed".to_string(), "low".to_string())
            ]
        );
        connection
            .execute(
                "UPDATE jobs SET status='queued' WHERE id=?1",
                params![child_ids[1]],
            )
            .unwrap();
        let retried: (String, String) = connection
            .query_row(
                "SELECT status,priority FROM jobs WHERE id=?1",
                params![child_ids[1]],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(retried, ("queued".to_string(), "low".to_string()));
    }

    #[test]
    fn invalid_target_counts_and_ids_are_rejected() {
        let mut connection = database();
        assert!(
            update_download_priorities(&mut connection, vec![], DownloadPriority::Normal)
                .unwrap_err()
                .contains("al menos")
        );
        let too_many = (0..=MAX_PRIORITY_TARGETS)
            .map(|index| DownloadPriorityTarget::Job {
                job_id: index as i64 + 1,
            })
            .collect();
        assert!(
            update_download_priorities(&mut connection, too_many, DownloadPriority::Normal)
                .unwrap_err()
                .contains("256")
        );
        assert!(update_download_priorities(
            &mut connection,
            vec![DownloadPriorityTarget::Job { job_id: 0 }],
            DownloadPriority::Normal,
        )
        .is_err());
    }

    #[test]
    fn lifecycle_statuses_are_preserved_while_priority_changes() {
        let mut connection = database();
        for status in ["running", "paused", "failed", "completed"] {
            let id = add_job(&connection, status);
            connection
                .execute("UPDATE jobs SET status=?1 WHERE id=?2", params![status, id])
                .unwrap();
            update_download_priorities(
                &mut connection,
                vec![DownloadPriorityTarget::Job { job_id: id }],
                DownloadPriority::High,
            )
            .unwrap();
            let stored: (String, String) = connection
                .query_row(
                    "SELECT status,priority FROM jobs WHERE id=?1",
                    params![id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!(stored, (status.to_string(), "high".to_string()));
        }
    }

    #[test]
    fn ipc_json_rejects_unknown_fields_kinds_and_priorities() {
        assert!(
            serde_json::from_value::<DownloadPriorityTarget>(serde_json::json!({
                "kind": "job",
                "jobId": 1,
                "weight": 5
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<DownloadPriorityTarget>(serde_json::json!({
                "kind": "process",
                "jobId": 1
            }))
            .is_err()
        );
        assert!(serde_json::from_value::<DownloadPriority>(serde_json::json!("urgent")).is_err());
    }
}
