# SQLite schema and migration review

Date: 2026-09-24  
Scope: source schema and migration code in `src-tauri/src/db/mod.rs`, call
sites that delete related records, and in-memory migration tests. No installed
database/profile was opened or changed.

## Declared schema

The source declares 13 application tables:

| Table | Declared columns (including additive fields) |
| --- | --- |
| `jobs` | `id`, `title`, `detail`, `progress`, `status`, `cancel_cleanup`, `priority`, `updated_at` |
| `download_jobs` | `job_id`, `url`, `destination`, `temp_path`, `total_bytes`, `downloaded_bytes`, `resumable`, `error`, `http_engine_attempts`, `remote_size`, `strong_etag`, `last_modified`, `representation_fingerprint`, `ownership_generation`, `ownership_token`, `finalization_state`, `speed_bps`, `eta_seconds`, `referrer`, `created_at`, `updated_at` |
| `torrent_jobs` | `job_id`, `source`, `source_kind`, `destination_dir`, `total_bytes`, `downloaded_bytes`, `speed_bps`, `eta_seconds`, `error`, `created_at`, `updated_at` |
| `recent_files` | `id`, `name`, `path`, `category`, `kind`, `opened_at` |
| `settings` | `key`, `value`, `updated_at` |
| `download_speed_limits` | `job_id`, `bytes_per_second`, `updated_at` |
| `playlist_batches` | `id`, `title`, `format`, `status`, `current_position`, `priority`, `created_at`, `updated_at` |
| `playlist_items` | `id`, `batch_id`, `source_id`, `source_url`, `title`, `creator`, `thumbnail`, `duration_label`, `position`, `status`, `progress`, `job_id`, `output_path`, `metadata_url`, `spotify_url`, `selected_source_url`, `resolution_state`, `match_score`, `provider_id`, `last_error`, `automatic_retries` |
| `media_jobs` | `job_id`, `source_url`, `format_selector`, `output_mode`, `destination_dir`, `output_path`, `thumbnail`, `requested_filename`, `expected_duration_seconds`, `playlist_batch_id`, `playlist_item_id`, `error`, `metadata_url`, `download_url`, `provider_id`, `resolution_state`, `match_score`, `downloaded_bytes`, `total_bytes`, `total_bytes_estimated`, `speed_bps`, `eta_seconds`, `isrc`, `album`, `album_artist`, `release_date`, `track_number`, `disc_number`, `explicit`, `artist`, `created_at`, `updated_at` |
| `saved_links` | `id`, `title`, `url`, `tags`, `created_at`, `updated_at` |
| `download_schedules` | `id`, `job_id`, `action`, `run_at`, `repeat_daily`, `enabled`, `last_run_at`, `created_at`, `updated_at` |
| `progress_v2_jobs` | `job_id`, `schema_version`, `attempt`, `phase`, `stage`, `downloaded_bytes`, `transfer_total`, `total_kind`, `progress_kind`, `final_size`, `updated_at_ms`, `resume_reused_bytes`, `session_transferred_bytes`, `snapshot_json` |
| `progress_v2_batches` | `batch_id`, `schema_version`, `updated_at_ms`, `snapshot_json` |

The declared schema contains 10 named indexes. They cover due schedules,
job status/update time, download URL, speed-limit update time, recent-file open
time, playlist-batch status/update time, playlist-item batch/status/position,
playlist-item job, media-job playlist batch/job, and progress-job update time.

There are 11 declared foreign-key relationships. Job-owned download, torrent,
speed-limit, media, schedule, and progress rows cascade when their job is
deleted. Playlist items cascade with their batch and set `job_id` to NULL when
the linked job is deleted. Media rows also reference playlist batches and
items with cascade behavior; batch progress rows cascade with their batch.
Deletion call sites remove jobs, playlist batches, schedules, and recent-file
entries through explicit commands. No `DROP TABLE`, `DROP INDEX`, or
`DROP COLUMN` statement was found in the SQLite module.

## Migration behavior and changes

Startup configures a 750 ms busy timeout, WAL mode, and
`PRAGMA foreign_keys=ON`, declares missing tables/indexes with `IF NOT EXISTS`,
normalizes interrupted `running` job/batch states back to `queued`, and applies
50 additive `ALTER TABLE ... ADD COLUMN` statements. The additive migration
sequence has no separate schema-version ledger (`PRAGMA user_version` was not
found).

Before this phase, every additive `ALTER` error was discarded. That could let
startup continue after an error unrelated to an already-present column. The
migration helper now ignores only SQLite's duplicate-column error and returns
all other errors. The additive sequence runs in a SQLite transaction, so a
later failure rolls back earlier column additions from that sequence. Table
creation and interrupted-job normalization remain in the preceding schema
batch.

`playlist_items.spotify_url` remains intentionally present. Startup recovery
queries use it to prevent removed Spotify/spotDL records from being resumed,
and the regression test verifies that the historical value remains readable.
Removing the field would require a separately justified data migration and is
outside this cleanup.

## Verification and limits

In-memory tests verified that duplicate columns are tolerated, other migration
errors propagate, earlier additive changes roll back after a later failure,
the schema migration can run twice, foreign-key enforcement is enabled, and
`PRAGMA foreign_key_check` reports no violations in the empty migrated schema.
A separate synthetic SQLite file fixture now models the pre-additive playlist
schema (without `playlist_items.job_id`) and a legacy Spotify URL. It opens a
new disposable file, runs migration twice, checks the historical marker and
synthetic job remain readable, and checks `foreign_key_check`. The fixture
found and drove correction of an index created before its additive column.
The existing legacy Spotify preservation/non-resume test also passed.

No real installation database was opened, backed up, repaired, or scanned.
The fixture covers one documented pre-additive schema shape; it does not prove
that every historical schema is supported. This review does not claim that
installed databases contain no orphan rows or that old profile migrations
have been validated against real user data. Those checks remain pending and
must use a user-authorized copy/fixture rather than the active profile.
