use crate::*;

#[tauri::command]
pub(crate) fn choose_torrent_file(app: AppHandle) -> Result<Option<String>, String> {
    crate::torrents::choose_torrent_file(app)
}

#[tauri::command]
pub(crate) fn queue_torrent_download(
    source: String,
    app: AppHandle,
    state: State<'_, LocalState>,
) -> Result<DownloadQueueReceipt, String> {
    if state.aria2_path().is_none() {
        return Err(crate::components::torrent_engine_required_error());
    }
    let destination_root = crate::downloads::choose_job_download_root(&app, &state)?;
    crate::torrents::queue_torrent_download(source, destination_root, state)
}
