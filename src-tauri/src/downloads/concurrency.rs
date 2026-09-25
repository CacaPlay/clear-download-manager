use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

pub(crate) const DOWNLOAD_CONCURRENCY_SETTINGS_KEY: &str = "download_concurrency_v1";
pub(crate) const MIN_HTTP_CONCURRENCY: u8 = 1;
pub(crate) const MAX_HTTP_CONCURRENCY: u8 = 8;
pub(crate) const MIN_MULTIMEDIA_CONCURRENCY: u8 = 1;
pub(crate) const MAX_MULTIMEDIA_CONCURRENCY: u8 = 4;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct DownloadConcurrencySettings {
    pub(crate) http: u8,
    pub(crate) multimedia: u8,
}

impl Default for DownloadConcurrencySettings {
    fn default() -> Self {
        Self {
            http: 2,
            multimedia: 1,
        }
    }
}

impl DownloadConcurrencySettings {
    pub(crate) fn validate(self) -> Result<Self, String> {
        if !(MIN_HTTP_CONCURRENCY..=MAX_HTTP_CONCURRENCY).contains(&self.http) {
            return Err(format!(
                "Las descargas HTTP simultáneas deben estar entre {MIN_HTTP_CONCURRENCY} y {MAX_HTTP_CONCURRENCY}; se recibió {}",
                self.http
            ));
        }
        if !(MIN_MULTIMEDIA_CONCURRENCY..=MAX_MULTIMEDIA_CONCURRENCY).contains(&self.multimedia) {
            return Err(format!(
                "Las descargas multimedia simultáneas deben estar entre {MIN_MULTIMEDIA_CONCURRENCY} y {MAX_MULTIMEDIA_CONCURRENCY}; se recibió {}",
                self.multimedia
            ));
        }
        Ok(self)
    }
}

pub(crate) fn read_download_concurrency_settings(
    connection: &Connection,
) -> DownloadConcurrencySettings {
    let stored = connection
        .query_row(
            "SELECT value FROM settings WHERE key=?1",
            params![DOWNLOAD_CONCURRENCY_SETTINGS_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten();
    let Some(stored) = stored else {
        return DownloadConcurrencySettings::default();
    };
    match serde_json::from_str::<DownloadConcurrencySettings>(&stored)
        .map_err(|error| error.to_string())
        .and_then(DownloadConcurrencySettings::validate)
    {
        Ok(settings) => settings,
        Err(error) => {
            eprintln!("[concurrency] persisted setting rejected; using defaults 2/1: {error}");
            DownloadConcurrencySettings::default()
        }
    }
}

pub(crate) fn persist_download_concurrency_settings(
    connection: &Connection,
    settings: DownloadConcurrencySettings,
) -> Result<DownloadConcurrencySettings, String> {
    let validated = settings.validate()?;
    let serialized = serde_json::to_string(&validated).map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,CURRENT_TIMESTAMP)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP",
            params![DOWNLOAD_CONCURRENCY_SETTINGS_KEY, serialized],
        )
        .map_err(|error| error.to_string())?;
    Ok(validated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migrate;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn settings_connection() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        connection
    }

    #[test]
    fn concurrency_defaults_match_existing_dispatcher_behavior() {
        let connection = settings_connection();
        assert_eq!(
            read_download_concurrency_settings(&connection),
            DownloadConcurrencySettings {
                http: 2,
                multimedia: 1,
            }
        );
    }

    #[test]
    fn concurrency_minimum_maximum_and_invalid_values_are_strict() {
        for settings in [
            DownloadConcurrencySettings {
                http: MIN_HTTP_CONCURRENCY,
                multimedia: MIN_MULTIMEDIA_CONCURRENCY,
            },
            DownloadConcurrencySettings {
                http: MAX_HTTP_CONCURRENCY,
                multimedia: MAX_MULTIMEDIA_CONCURRENCY,
            },
        ] {
            assert_eq!(settings.validate().unwrap(), settings);
        }
        for settings in [
            DownloadConcurrencySettings {
                http: 0,
                multimedia: 1,
            },
            DownloadConcurrencySettings {
                http: 9,
                multimedia: 1,
            },
            DownloadConcurrencySettings {
                http: 2,
                multimedia: 0,
            },
            DownloadConcurrencySettings {
                http: 2,
                multimedia: 5,
            },
        ] {
            assert!(settings.validate().is_err());
        }
        assert!(serde_json::from_str::<DownloadConcurrencySettings>(
            r#"{"http":2,"multimedia":1,"scheduler":true}"#
        )
        .is_err());
        assert!(serde_json::from_str::<DownloadConcurrencySettings>(
            r#"{"http":2.5,"multimedia":1}"#
        )
        .is_err());
    }

    #[test]
    fn concurrency_persists_across_restart_and_invalid_write_preserves_last_value() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "cacatools-concurrency-settings-{}-{nonce}.sqlite",
            std::process::id()
        ));
        let expected = DownloadConcurrencySettings {
            http: 4,
            multimedia: 2,
        };
        {
            let connection = Connection::open(&path).unwrap();
            migrate(&connection).unwrap();
            assert_eq!(
                persist_download_concurrency_settings(&connection, expected).unwrap(),
                expected
            );
            assert!(persist_download_concurrency_settings(
                &connection,
                DownloadConcurrencySettings {
                    http: 9,
                    multimedia: 2,
                },
            )
            .is_err());
        }
        {
            let connection = Connection::open(&path).unwrap();
            migrate(&connection).unwrap();
            assert_eq!(read_download_concurrency_settings(&connection), expected);
        }
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
    }

    #[test]
    fn corrupt_persisted_concurrency_fails_safe_to_existing_defaults() {
        let connection = settings_connection();
        for value in [
            r#"{"http":0,"multimedia":1}"#,
            r#"{"http":2,"multimedia":5}"#,
            r#"{"http":2}"#,
            "not-json",
        ] {
            connection
                .execute(
                    "INSERT INTO settings(key,value) VALUES(?1,?2)
                     ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    params![DOWNLOAD_CONCURRENCY_SETTINGS_KEY, value],
                )
                .unwrap();
            assert_eq!(
                read_download_concurrency_settings(&connection),
                DownloadConcurrencySettings::default()
            );
        }
    }
}
