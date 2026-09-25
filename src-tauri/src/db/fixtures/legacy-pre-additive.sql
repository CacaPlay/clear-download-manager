PRAGMA foreign_keys = ON;

CREATE TABLE jobs (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '',
    progress REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'queued',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE playlist_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    format TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    current_position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE playlist_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER NOT NULL,
    source_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    progress REAL NOT NULL DEFAULT 0,
    spotify_url TEXT NOT NULL DEFAULT '',
    FOREIGN KEY(batch_id) REFERENCES playlist_batches(id) ON DELETE CASCADE
);

CREATE TABLE media_jobs (
    job_id INTEGER PRIMARY KEY,
    source_url TEXT NOT NULL,
    format_selector TEXT NOT NULL,
    output_mode TEXT NOT NULL,
    destination_dir TEXT NOT NULL,
    output_path TEXT,
    expected_duration_seconds REAL,
    playlist_batch_id INTEGER,
    playlist_item_id INTEGER,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE,
    FOREIGN KEY(playlist_batch_id) REFERENCES playlist_batches(id) ON DELETE CASCADE,
    FOREIGN KEY(playlist_item_id) REFERENCES playlist_items(id) ON DELETE CASCADE
);

CREATE TABLE download_jobs (
    job_id INTEGER PRIMARY KEY,
    url TEXT NOT NULL,
    destination TEXT NOT NULL,
    temp_path TEXT NOT NULL,
    total_bytes INTEGER,
    downloaded_bytes INTEGER NOT NULL DEFAULT 0,
    resumable INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

INSERT INTO jobs(id, title, detail, progress, status)
VALUES(7, 'Synthetic legacy record', '', 0, 'queued');
INSERT INTO playlist_batches(id, title, format, status, current_position)
VALUES(3, 'Synthetic legacy batch', 'audio_best', 'queued', 0);
INSERT INTO playlist_items(batch_id, source_id, position, status, progress, spotify_url)
VALUES(3, 'synthetic-spotify-track', 1, 'queued', 0,
       'https://open.spotify.com/track/synthetic-legacy');
INSERT INTO media_jobs(
    job_id, source_url, format_selector, output_mode, destination_dir,
    playlist_batch_id, playlist_item_id
)
VALUES(7, 'https://youtube.com/watch?v=synthetic', 'best', 'audio_best',
       'C:/SyntheticDownloads', 3, 1);
