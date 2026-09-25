import { runtimeState, setOptimisticJobPriority } from './state.js';
import { playlistJobId } from './core/model.js';

function closeRowMenu() {
  runtimeState.rowMenuJobId = null;
  runtimeState.rowMenuPosition = null;
  runtimeState.rowMenuOpenedAt = 0;
  runtimeState.rowMenuAnchor = null;
}

function dismissRowMenu(rerenderNow) {
  closeRowMenu();
  // The row menu lives in a detached fixed layer. Clearing state alone leaves
  // that layer painted until the next full refresh, which is why it used to
  // remain visible after Copy/Cut and speed actions.
  if (typeof rerenderNow === 'function') rerenderNow();
}

function priorityTarget(job) {
  if (job?.kind === 'playlist' && Number(job.playlistBatchId || 0) > 0) {
    return { kind: 'playlist', batchId: Number(job.playlistBatchId) };
  }
  const jobId = Number(job?.id || 0);
  return jobId > 0 ? { kind: 'job', jobId } : null;
}

export async function changeDownloadPriority(context, jobs, ids, priority, rerenderNow) {
  if (!['high', 'normal', 'low'].includes(priority)) return;
  const currentJobs = runtimeState.liveJobs?.length ? runtimeState.liveJobs : jobs;
  const selected = [...new Set(ids.map(Number))]
    .map((id) => currentJobs.find((job) => Number(job.id) === id))
    .filter(Boolean)
    .map((job) => ({ job, target: priorityTarget(job) }))
    .filter((entry) => entry.target);
  const targets = selected.map((entry) => entry.target);
  if (!targets.length) {
    context.onToast?.('Selecciona al menos una descarga válida.', 'error');
    return;
  }

  closeRowMenu();
  selected.forEach(({ job }) => setOptimisticJobPriority(job.id, priority));
  rerenderNow();
  try {
    if (typeof context.invoke !== 'function') throw new Error('El backend de prioridad no está disponible.');
    await context.invoke('set_download_priority', { targets, priority });
    await context.onRefresh?.({
      liveOnly: true,
      changedJobIds: new Set(selected.map(({ job }) => String(job.id)))
    });
    const label = { high: 'alta', normal: 'normal', low: 'baja' }[priority];
    context.onToast?.(`Prioridad ${label} aplicada.`, 'success');
  } catch (error) {
    selected.forEach(({ job }) => setOptimisticJobPriority(job.id, null));
    rerenderNow();
    context.onToast?.(String(error), 'error');
  }
}

export function bindDownloadManagerActions(root, context, jobs, rerenderNow, copyClipboard) {
    root.querySelectorAll('[data-dm-set-priority]').forEach((button) => button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const jobId = Number(button.dataset.jobId || playlistJobId(button.dataset.playlistBatchId));
      await changeDownloadPriority(context, jobs, [jobId], button.dataset.dmSetPriority, rerenderNow);
    }));
    root.querySelector('[data-dm-bulk-priority]')?.addEventListener('change', async (event) => {
      const priority = event.currentTarget.value;
      if (!priority) return;
      await changeDownloadPriority(context, jobs, [...runtimeState.selectedJobIds], priority, rerenderNow);
    });
    root.querySelectorAll('[data-dm-job-action]').forEach((button) => button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const id = Number(button.dataset.jobId);
      const action = button.dataset.dmJobAction;
      const job = jobs.find((entry) => entry.id === id);
      try {
        if (action === 'reveal') {
          if (!job?.destination) { context.onToast?.('Esta tarea no tiene un archivo local disponible.', 'error'); return; }
          dismissRowMenu(rerenderNow);
          await context.invoke?.('reveal_local_file', { path: job.destination });
        } else {
          const nextStatus = action === 'pause' ? 'paused' : 'running';
          dismissRowMenu(rerenderNow);
          context.onOptimisticJobStatus?.(id, nextStatus);
          await context.invoke?.('set_job_status', { id, status: nextStatus });
          await context.onRefresh?.({ liveOnly: true, changedJobIds: new Set([String(id)]) });
        }
      } catch (error) {
        if (action !== 'reveal') context.onOptimisticJobStatus?.(id, null);
        context.onToast?.(String(error), 'error');
      }
    }));
    root.querySelectorAll('[data-dm-file-action]').forEach((button) => button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const path = button.dataset.dmFilePath || '';
      const cut = button.dataset.dmFileAction === 'cut';
      if (!path) return;
      try {
        dismissRowMenu(rerenderNow);
        await context.invoke?.('set_file_clipboard', { path, cut });
        context.onToast?.(cut ? 'Archivo listo para cortar y pegar.' : 'Archivo copiado al portapapeles.', 'success');
      } catch (error) {
        context.onToast?.(String(error), 'error');
      }
    }));
    root.querySelectorAll('[data-dm-playlist-action]').forEach((button) => button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const batchId = Number(button.dataset.playlistBatchId || 0);
      const action = button.dataset.dmPlaylistAction;
      if (!batchId) return;
      const jobId = playlistJobId(batchId);
      const nextStatus = action === 'pause' ? 'paused' : action === 'retry' ? 'queued' : 'running';
      try {
        dismissRowMenu(rerenderNow);
        context.onOptimisticJobStatus?.(jobId, nextStatus, { resetProgress: action === 'retry' });
        if (action === 'retry') await context.invoke?.('retry_failed_playlist_items', { batchId });
        else await context.invoke?.('set_playlist_batch_paused', { batchId, paused: action === 'pause' });
        await context.onRefresh?.({ liveOnly: true, changedJobIds: new Set([String(jobId)]) });
        context.onToast?.(action === 'pause' ? 'Playlist pausada.' : action === 'retry' ? 'Reintentando elementos fallidos.' : 'Playlist reanudada.', 'success');
      } catch (error) {
        context.onOptimisticJobStatus?.(jobId, null);
        context.onToast?.(String(error), 'error');
      }
    }));
    root.querySelectorAll('[data-dm-reveal-path]').forEach((button) => button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const path = button.dataset.dmRevealPath || '';
      if (!path) return;
      try { dismissRowMenu(rerenderNow); await context.invoke?.('reveal_local_file', { path }); }
      catch (error) { context.onToast?.(String(error), 'error'); }
    }));
    root.querySelectorAll('[data-dm-open-download-directory]').forEach((button) => button.addEventListener('click', async (event) => {
      event.stopPropagation();
      try { await context.invoke?.('open_download_directory'); }
      catch (error) { context.onToast?.(String(error), 'error'); }
    }));
    root.querySelectorAll('[data-dm-open-path]').forEach((button) => button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const path = button.dataset.dmOpenPath || '';
      if (!path) return;
      try { dismissRowMenu(rerenderNow); await context.invoke?.('open_local_file', { path }); }
      catch (error) { context.onToast?.(String(error), 'error'); }
    }));
    root.querySelectorAll('[data-dm-cancel-job]').forEach((button) => button.addEventListener('click', () => { runtimeState.modal = 'cancel'; runtimeState.modalJobId = Number(button.dataset.dmCancelJob); rerenderNow(); }));
    root.querySelectorAll('[data-dm-delete-job]').forEach((button) => button.addEventListener('click', async () => {
      runtimeState.modal = 'delete';
      runtimeState.modalJobId = Number(button.dataset.dmDeleteJob);
      runtimeState.deletePreview = null;
      runtimeState.deletePreviewBusy = true;
      rerenderNow();
      try { runtimeState.deletePreview = await context.invoke?.('job_storage_preview', { id: runtimeState.modalJobId }); }
      catch (error) { runtimeState.deletePreview = { safetyWarning: String(error), safeForStorageDeletion: false, storageExists: false }; context.onToast?.(String(error), 'error'); }
      finally { runtimeState.deletePreviewBusy = false; rerenderNow(); }
    }));
    root.querySelectorAll('[data-dm-confirm-cancel]').forEach((button) => button.addEventListener('click', async () => {
      const id = Number(button.dataset.jobId);
      const deletePartial = button.dataset.dmConfirmCancel === 'delete';
      try { await context.invoke?.('emergency_stop_job', { id, deletePartial }); runtimeState.modal = ''; runtimeState.modalJobId = null; await context.onRefresh?.(); context.onToast?.(deletePartial ? 'Tarea detenida; la limpieza segura quedó programada.' : 'Tarea detenida; los parciales se conservaron.', 'success'); rerenderNow(); }
      catch (error) { context.onToast?.(String(error), 'error'); }
    }));
    root.querySelector('[data-dm-delete-storage-ack]')?.addEventListener('change', (event) => {
      const button = root.querySelector('[data-dm-confirm-delete="storage"]');
      if (button) button.disabled = !event.currentTarget.checked;
    });
    root.querySelectorAll('[data-dm-delete-playlist-batch]').forEach((button) => button.addEventListener('click', async () => {
      const batchId = Number(button.dataset.dmDeletePlaylistBatch || 0);
      const deleteStorage = button.dataset.deleteStorage === '1';
      const destination = button.dataset.playlistDestination || '';
      if (!batchId) return;
      const prompt = deleteStorage
        ? `¿Eliminar esta playlist de CacaTools y borrar sus archivos${destination ? ` en ${destination}` : ''}? Esta acción no se puede deshacer.`
        : '¿Eliminar esta playlist del historial de CacaTools y conservar todos los archivos descargados?';
      if (!window.confirm(prompt)) return;
      button.disabled = true;
      try {
        const receipt = await context.invoke?.('delete_playlist_batch', { batchId, deleteStorage });
        await context.onRefresh?.();
        context.onToast?.(deleteStorage ? `Playlist y almacenamiento eliminados (${receipt?.removedPaths?.length || 0} ruta(s)).` : 'Playlist eliminada del historial; los archivos se conservaron.', 'success');
        rerenderNow();
      } catch (error) {
        button.disabled = false;
        context.onToast?.(String(error), 'error');
      }
    }));
    const bulkStorageAck = root.querySelector('[data-dm-bulk-delete-storage-ack]');
    const bulkStorageButton = root.querySelector('[data-dm-confirm-bulk-delete="storage"]');
    bulkStorageAck?.addEventListener('change', () => { if (bulkStorageButton) bulkStorageButton.disabled = !bulkStorageAck.checked || runtimeState.bulkDeleteBusy; });
    root.querySelectorAll('[data-dm-confirm-bulk-delete]').forEach((button) => button.addEventListener('click', async () => {
      if (runtimeState.bulkDeleteBusy) return;
      const deleteStorage = button.dataset.dmConfirmBulkDelete === 'storage';
      if (deleteStorage && !bulkStorageAck?.checked) return;
      const selectedIds = [...runtimeState.selectedJobIds];
      if (!selectedIds.length) return;
      runtimeState.bulkDeleteBusy = true;
      rerenderNow();
      let removed = 0;
      let failed = 0;
      let pending = 0;
      const outcomes = await Promise.all(selectedIds.map(async (id) => {
        const job = (runtimeState.liveJobs || jobs).find((entry) => Number(entry.id) === Number(id));
        try {
          let receipt;
          if (job?.kind === 'playlist' && Number(job.playlistBatchId || 0) > 0) {
            receipt = await context.invoke?.('delete_playlist_batch', { batchId: Number(job.playlistBatchId), deleteStorage });
          } else if (Number(id) > 0) {
            receipt = await context.invoke?.('delete_download_job', { id: Number(id), deleteStorage });
          } else {
            throw new Error('Elemento no válido');
          }
          return { id, ok: true, pending: Boolean(receipt?.cleanupPending) };
        } catch (error) {
          console.error('CacaTools bulk delete failed', id, error);
          return { id, ok: false, error };
        }
      }));
      outcomes.forEach((outcome) => {
        if (outcome.ok) {
          runtimeState.selectedJobIds.delete(Number(outcome.id));
          removed += 1;
          if (outcome.pending) pending += 1;
        } else failed += 1;
      });
      runtimeState.bulkDeleteBusy = false;
      runtimeState.modal = '';
      if (!runtimeState.selectedJobIds.size) runtimeState.selectionMode = false;
      await context.onRefresh?.();
      const pendingLabel = pending ? ` La limpieza física continúa en segundo plano (${pending}).` : '';
      context.onToast?.(failed ? `${removed} eliminada(s); ${failed} no se pudieron eliminar.${pendingLabel}` : `${removed} descarga(s) eliminada(s)${deleteStorage ? ' junto con su almacenamiento administrado' : ' de CacaTools'}.${pendingLabel}`, failed ? 'error' : 'success');
      rerenderNow();
    }));
    root.querySelectorAll('[data-dm-confirm-delete]').forEach((button) => button.addEventListener('click', async () => {
      const id = Number(button.dataset.jobId || runtimeState.modalJobId || 0);
      const deleteStorage = button.dataset.dmConfirmDelete === 'storage';
      if (!id || runtimeState.deleteBusy) return;
      if (deleteStorage && !root.querySelector('[data-dm-delete-storage-ack]')?.checked) return;
      runtimeState.deleteBusy = true;
      rerenderNow();
      try {
        const receipt = await context.invoke?.('delete_download_job', { id, deleteStorage });
        runtimeState.modal = '';
        runtimeState.modalJobId = null;
        runtimeState.deletePreview = null;
        await context.onRefresh?.();
        const pendingLabel = receipt?.cleanupPending ? ' La limpieza física continúa en segundo plano.' : '';
        context.onToast?.(deleteStorage ? `Tarea y almacenamiento eliminados (${receipt?.removedPaths?.length || 0} ruta(s)).${pendingLabel}` : `Tarea eliminada de CacaTools; el almacenamiento se conservó.${pendingLabel}`, 'success');
      } catch (error) { context.onToast?.(String(error), 'error'); }
      finally { runtimeState.deleteBusy = false; rerenderNow(); }
    }));
    root.querySelectorAll('[data-dm-schedule-job],[data-dm-new-schedule]').forEach((button) => button.addEventListener('click', () => { runtimeState.modal = 'schedule'; runtimeState.modalJobId = Number(button.dataset.dmScheduleJob || runtimeState.preferences.selectedJobId || 0) || null; rerenderNow(); }));
    root.querySelector('[data-dm-save-schedule]')?.addEventListener('click', async (event) => {
      const jobId = Number(event.currentTarget.dataset.jobId || 0) || null;
      const action = root.querySelector('#dm-schedule-action')?.value || 'resume';
      const runAt = root.querySelector('#dm-schedule-at')?.value || '';
      const repeatDaily = Boolean(root.querySelector('#dm-schedule-repeat')?.checked);
      if (!jobId) { context.onToast?.('Selecciona una descarga antes de programarla.', 'error'); return; }
      if (!runAt) { context.onToast?.('Selecciona una fecha y hora.', 'error'); return; }
      try { await context.invoke?.('create_download_schedule', { jobId, action, runAt, repeatDaily }); runtimeState.modal = ''; runtimeState.modalJobId = null; await context.onRefresh?.(); rerenderNow(); }
      catch (error) { context.onToast?.(String(error), 'error'); }
    });
    root.querySelector('[data-dm-choose-torrent]')?.addEventListener('click', async () => {
      try {
        const source = await context.invoke?.('choose_torrent_file');
        if (source) runtimeState.torrentSource = source;
        rerenderNow();
      } catch (error) { context.onToast?.(String(error), 'error'); }
    });
    root.querySelector('[data-dm-paste-torrent]')?.addEventListener('click', async () => {
      const source = await copyClipboard();
      if (!source) { context.onToast?.('El portapapeles no contiene un enlace magnet.', 'error'); return; }
      runtimeState.torrentSource = source;
      rerenderNow();
    });
    root.querySelector('#dm-torrent-source')?.addEventListener('input', (event) => { runtimeState.torrentSource = event.target.value; });
    root.querySelector('#dm-torrent-source')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !runtimeState.torrentBusy) { event.preventDefault(); root.querySelector('[data-dm-queue-torrent]')?.click(); }
    });
    root.querySelector('[data-dm-queue-torrent]')?.addEventListener('click', async () => {
      const source = root.querySelector('#dm-torrent-source')?.value.trim() || runtimeState.torrentSource.trim();
      if (!source) { context.onToast?.('Pega un magnet o selecciona un archivo .torrent.', 'error'); return; }
      runtimeState.torrentSource = source;
      runtimeState.torrentBusy = true;
      rerenderNow();
      try {
        const receipt = await context.invoke?.('queue_torrent_download', { source });
        runtimeState.modal = '';
        runtimeState.torrentSource = '';
        context.onToast?.(`Torrent añadido: ${receipt?.filename || 'descarga'}`, 'success');
        await context.onRefresh?.();
      } catch (error) {
        context.onToast?.(String(error), 'error');
      } finally {
        runtimeState.torrentBusy = false;
        rerenderNow();
      }
    });
    root.querySelectorAll('[data-dm-recover-job]').forEach((button) => button.addEventListener('click', () => { runtimeState.modal = 'recovery'; runtimeState.modalJobId = Number(button.dataset.dmRecoverJob); runtimeState.recoveryResult = null; rerenderNow(); }));
    root.querySelector('[data-dm-run-recovery]')?.addEventListener('click', async () => {
      const job = jobs.find((entry) => entry.id === runtimeState.modalJobId);
      if (!job) return;
      runtimeState.recoveryBusy = true; rerenderNow();
      try { runtimeState.recoveryResult = await context.invoke?.('recover_media_source', { request: { jobId: job.id, title: job.title, sourceUrl: job.sourceUrl || null, creator: '', durationSeconds: null, limit: 8 } }); }
      catch (error) {
        runtimeState.recoveryResult = {
          original_available: false,
          message: String(error),
          alternatives: [],
          verification_attempts: 0,
          recovery_mode: 'diagnostic_error',
          can_retry: true,
          diagnosis: {
            code: 'diagnostic_error',
            title: 'No se pudo completar el diagnóstico',
            summary: String(error),
            retryable: true,
            likely_temporary: true,
            requires_user_action: false,
            suggestions: ['Comprueba que los motores locales estén instalados', 'Vuelve a intentarlo sin eliminar el archivo parcial']
          }
        };
      }
      runtimeState.recoveryBusy = false; rerenderNow();
    });
    root.querySelector('[data-dm-open-session-settings]')?.addEventListener('click', () => {
      runtimeState.modal = '';
      runtimeState.modalJobId = null;
      runtimeState.recoveryResult = null;
      context.onSection?.('settings');
      context.onToast?.('Configura la sesión en Ajustes y vuelve a analizar la fuente original.', 'info');
      rerenderNow();
    });
    root.querySelector('[data-dm-retry-recovery]')?.addEventListener('click', async (event) => {
      const id = Number(event.currentTarget.dataset.jobId || runtimeState.modalJobId || 0);
      if (!id) return;
      try {
        await context.invoke?.('set_job_status', { id, status: 'running' });
        runtimeState.modal = '';
        runtimeState.modalJobId = null;
        runtimeState.recoveryResult = null;
        context.onToast?.('La tarea se reanudará conservando el archivo parcial.', 'success');
        await context.onRefresh?.();
        rerenderNow();
      } catch (error) { context.onToast?.(String(error), 'error'); }
    });
  
}
