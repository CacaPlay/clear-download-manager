import { ZEN_NAV_ITEMS } from '../core/constants.js';
import { escapeHtml, jobsForSection, sectionForLayout, selectedJob, statusCounts } from '../core/model.js';
import { dmIcon } from './icons.js';
import { categoryOptions, selectedInspector, settingsPopover } from './shared.js?v=0.95.0-verify-20260911-r4';
import { sectionHeading, specialSectionPanel } from './sections.js';
import { compactStatsMarkup, downloadAreaMarkup, helperChipsMarkup, unifiedSearchMarkup } from './unified.js?v=0.95.5-ui-redesign-20260929-r1';

function zenSidebar(jobs, preferences, activeSection, context = {}) {
  const counts = statusCounts(jobs);
  const experience = context.experienceSettings || {};
  const newsUnread = context.newsHasAttention !== undefined
    ? Boolean(context.newsHasAttention)
    : Boolean(context.availableUpdate?.version) || experience.extensionPromptDecision !== 'declined';
  const brandIconVariant = context.brandIconVariant || 'celeste';
  const t = (key, fallback) => context.translate?.(key) || fallback;
  return `<aside class="dm-zen-nav ${preferences.sidebarCollapsed ? 'is-collapsed' : ''}">
    <header><img class="dm-brand-logo dm-brand-mark" data-cdm-brand-logo data-brand-icon-base="./app-ui/assets/brand" src="./app-ui/assets/brand/clear-download-manager-${brandIconVariant}.webp" alt="Clear Download Manager"><div><strong>Clear Download</strong><small>Manager</small></div><button data-dm-toggle="sidebar" aria-label="Alternar barra lateral">${dmIcon('collapse')}</button></header>
    <nav aria-label="Navegación principal">${ZEN_NAV_ITEMS.map(([id, label, icon]) => `<button title="${escapeHtml(label)}" class="${id === activeSection ? 'is-active' : ''}" data-dm-section="${id}">${dmIcon(icon)}<span>${label}</span>${id === 'running' && counts.running ? `<b>${counts.running}</b>` : id === 'queue' && counts.queued ? `<b>${counts.queued}</b>` : id === 'completed' && counts.completed ? `<b>${counts.completed}</b>` : ''}</button>`).join('')}<button type="button" title="Complementos" aria-label="Complementos" data-dm-open-complements>${dmIcon('package')}<span>Complementos</span></button></nav>
    <footer><button data-dm-section="news" title="${t('news', 'Novedades')}" class="dm-news-entry ${activeSection === 'news' ? 'is-active' : ''} ${context.newsUpdateAvailable ? 'has-app-update' : ''}">${dmIcon('bell')}${newsUnread ? `<i class="dm-news-dot" aria-label="${t('unreadNews', 'Hay novedades sin leer')}"></i>` : ''}</button><button data-dm-open-settings title="${t('settings', 'Ajustes')}" class="dm-settings-entry">${dmIcon('settings')}</button><button data-dm-theme-toggle title="${t('themeToggle', 'Cambiar tema')}">${dmIcon('moon')}</button></footer>
  </aside>`;
}

function selectionControlsMarkup(context) {
  const t = (key, fallback) => context.translate?.(key) || fallback;
  const escape = (value) => escapeHtml(value);
  const selectedCount = Number(context.selectedJobIds?.size || 0);
  const visible = Array.isArray(context.visible) ? context.visible : [];
  const allVisibleSelected = Boolean(visible.length) && visible.every((job) => context.selectedJobIds?.has(Number(job.id)));
  return context.selectionMode
    ? `<div class="dm-selection-tools"><button type="button" class="dm-select-all-compact" data-dm-select-all-visible title="${escape(t(allVisibleSelected ? 'Quitar selección visible' : 'Seleccionar todas las descargas visibles', allVisibleSelected ? 'Quitar selección visible' : 'Seleccionar todas las descargas visibles'))}" aria-label="${escape(t(allVisibleSelected ? 'Quitar selección visible' : 'Seleccionar todas las descargas visibles', allVisibleSelected ? 'Quitar selección visible' : 'Seleccionar todas las descargas visibles'))}">${dmIcon(allVisibleSelected ? 'x' : 'check', 18)}<span>${escape(t(allVisibleSelected ? 'Ninguna' : 'Visibles', allVisibleSelected ? 'Ninguna' : 'Visibles'))}</span></button><select data-dm-bulk-priority aria-label="${escape(t('Cambiar prioridad de la selección', 'Cambiar prioridad de la selección'))}" ${selectedCount ? '' : 'disabled'}><option value="">${escape(t('Prioridad…', 'Prioridad…'))}</option><option value="high">${escape(t('Alta', 'Alta'))}</option><option value="normal">${escape(t('Normal', 'Normal'))}</option><option value="low">${escape(t('Baja', 'Baja'))}</option></select><button type="button" class="is-danger" data-dm-bulk-delete ${selectedCount ? '' : 'disabled'}>${dmIcon('trash', 18)}<span>${escape(t('Eliminar', 'Eliminar'))} ${selectedCount || ''}</span></button><button type="button" data-dm-selection-toggle title="${escape(t('Salir de selección', 'Salir de selección'))}" aria-label="${escape(t('Salir de selección', 'Salir de selección'))}">${dmIcon('x', 18)}</button></div>`
    : `<button type="button" class="dm-selection-toggle" data-dm-selection-toggle title="${escape(t('Seleccionar descargas', 'Seleccionar descargas'))}">${dmIcon('check', 18)}<span>${escape(t('Seleccionar', 'Seleccionar'))}</span></button>`;
}

function newDownloadMenuMarkup(context) {
  const t = (key, fallback) => context.translate?.(key) || fallback;
  const disabled = Boolean(context.selectionMode);
  const open = Boolean(context.addMenuOpen) && !disabled;
  return `<div class="dm-add-split">
    <button type="button" class="dm-primary-button dm-add-menu-toggle" data-dm-add-menu-toggle aria-expanded="${open ? 'true' : 'false'}" ${disabled ? 'disabled aria-disabled="true"' : ''}>${dmIcon('plus', 17)}<span>${t('Nueva descarga', 'Nueva descarga')}</span>${dmIcon('chevron', 15)}</button>
    <div class="dm-add-dropdown" data-dm-add-menu role="group" aria-label="${t('Accesos de entrada', 'Accesos de entrada')}" ${open ? '' : 'hidden'}>${helperChipsMarkup({ disabled, translate: context.translate })}</div>
  </div>`;
}

function sortControlMarkup(context) {
  const t = (key, fallback) => context.translate?.(key) || fallback;
  const options = [
    ['newest', 'Recientes'],
    ['oldest', 'Más antiguos'],
    ['name', 'Nombre (A-Z)'],
    ['size', 'Tamaño ↓']
  ];
  const selected = options.some(([value]) => value === context.preferences?.sortOrder)
    ? context.preferences.sortOrder : 'newest';
  return `<label class="dm-sort-control"><span class="dm-visually-hidden">${t('Ordenar', 'Ordenar')}</span><select data-dm-sort-select aria-label="${t('Ordenar descargas', 'Ordenar descargas')}">${options.map(([value, label]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${t(label, label)}</option>`).join('')}</select>${dmIcon('chevron', 15)}</label>`;
}

export function downloadToolbarMarkup(context) {
  const visible = Array.isArray(context.visible) ? context.visible : [];
  return `<div class="dm-zen-secondary-row">
    <div class="dm-zen-secondary-actions">${newDownloadMenuMarkup(context)}${categoryOptions(context.jobs || [], context.preferences?.category || 'all', Boolean(context.categoryMenuOpen), context.translate)}</div>
    <span class="dm-toolbar-divider" aria-hidden="true"></span>
    <div class="dm-zen-toolbar-actions">${selectionControlsMarkup({ ...context, visible })}${sortControlMarkup(context)}<button type="button" class="dm-details-toggle" data-dm-toggle="inspector" title="Mostrar detalles" aria-label="Mostrar detalles">${dmIcon('panel', 18)}</button></div>
  </div>`;
}

function zenDownloads(context, visible, visualSelectedId) {
  return `<section class="dm-zen-workspace">
    ${downloadAreaMarkup(context, visible, visualSelectedId)}
  </section>`;
}

export function renderZenSidebar(context) {
  const { jobs, preferences, mobileSidebarOpen, mobileInspectorOpen, settingsOpen = false, schedules = [] } = context;
  const activeSection = sectionForLayout(preferences);
  const visible = jobsForSection(jobs, preferences, activeSection);
  const selected = context.inspectorJob || selectedJob(visible.length ? visible : jobs, preferences);
  const special = specialSectionPanel(activeSection, { ...context, schedules });
  const content = special || zenDownloads(context, visible, context.visualSelectedId ?? null);
  const isNews = activeSection === 'news';
  return `<section class="dm-root dm-zen-sidebar ${isNews ? 'is-news-surface' : ''} ${preferences.sidebarCollapsed ? 'has-collapsed-sidebar' : ''} ${preferences.inspectorCollapsed ? 'has-collapsed-inspector' : ''} ${preferences.compactRows ? 'is-compact' : ''} ${mobileSidebarOpen ? 'dm-mobile-sidebar-open' : ''} ${mobileInspectorOpen ? 'dm-mobile-inspector-open' : ''}">
    ${zenSidebar(jobs, preferences, activeSection, context)}
    <main class="dm-zen-main">
       ${isNews ? '' : `<header class="dm-zen-top"><button class="dm-mobile-menu" data-dm-toggle="sidebar" aria-label="Abrir navegación">${dmIcon('queue')}</button>${unifiedSearchMarkup(context, 'zen')}<div class="dm-zen-head-actions">${compactStatsMarkup(jobs)}</div>${downloadToolbarMarkup({ ...context, visible })}</header>`}
      <div class="dm-zen-content ${isNews ? 'dm-news-content' : ''}">${activeSection === 'downloads' || activeSection === 'queue' || activeSection === 'running' || activeSection === 'completed' || activeSection === 'history' || activeSection === 'news' ? '' : sectionHeading(activeSection, visible.length)}${content}</div>
    </main>
    ${preferences.inspectorCollapsed && !mobileInspectorOpen ? '' : selectedInspector(selected, preferences)}
    ${settingsPopover(preferences, settingsOpen, context)}
  </section>`;
}
