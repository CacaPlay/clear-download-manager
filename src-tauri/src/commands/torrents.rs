use crate::*;

#[tauri::command]
pub(crate) fn choose_torrent_file(app: AppHandle) -> Result<Option<String>, String> {
    crate::torrents::choose_torrent_file(app)
}

#[tauri::command]
pub(crate) fn queue_torrent_download(
    source: String,
    state: State<'_, LocalState>,
) -> Result<DownloadQueueReceipt, String> {
    crate::torrents::queue_torrent_download(source, state)
}
