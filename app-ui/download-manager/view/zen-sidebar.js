import { ZEN_NAV_ITEMS } from '../core/constants.js';
import { escapeHtml, jobsForSection, sectionForLayout, selectedJob, statusCounts } from '../core/model.js';
import { dmIcon } from './icons.js';
import { categoryOptions, selectedInspector, settingsPopover } from './shared.js?v=0.95.0-verify-20260911-r4';
import { sectionHeading, specialSectionPanel } from './sections.js';
import { compactStatsMarkup, downloadAreaMarkup, helperChipsMarkup, unifiedSearchMarkup } from './unified.js?v=0.95.0-verify-20260911-r4';

function zenSidebar(jobs, preferences, activeSection, context = {}) {
  const counts = statusCounts(jobs);
  const experience = context.experienceSettings || {};
  const newsUnread = context.newsHasAttention !== undefined
    ? Boolean(context.newsHasAttention)
    : Boolean(context.availableUpdate?.version) || experience.extensionPromptDecision !== 'declined';
  const brandIconVariant = context.brandIconVariant || 'celeste';
  const t = (key, fallback) => context.translate?.(key) || fallback;
  return `<aside class="dm-zen-nav ${preferences.sidebarCollapsed ? 'is-collapsed' : ''}">
    <header><img class="dm-brand-logo dm-brand-mark" data-cdm-brand-logo data-brand-icon-base="./app-ui/assets/brand" src="./app-ui/assets/brand/clear-download-manager-${brandIconVariant}.png" alt="Clear Download Manager"><div><strong>Clear Download</strong><small>Manager</small></div><button data-dm-toggle="sidebar" aria-label="Alternar barra lateral">${dmIcon('collapse')}</button></header>
    <nav aria-label="Navegación principal">${ZEN_NAV_ITEMS.map(([id, label, icon]) => `<button title="${escapeHtml(label)}" class="${id === activeSection ? 'is-active' : ''}" data-dm-section="${id}">${dmIcon(icon)}<span>${label}</span>${id === 'running' && counts.running ? `<b>${counts.running}</b>` : id === 'queue' && counts.queued ? `<b>${counts.queued}</b>` : id === 'completed' && counts.completed ? `<b>${counts.completed}</b>` : ''}</button>`).join('')}</nav>
    <footer><button data-dm-section="news" title="${t('news', 'Novedades')}" class="dm-news-entry ${activeSection === 'news' ? 'is-active' : ''}">${dmIcon('bell')}${newsUnread ? `<i class="dm-news-dot" aria-label="${t('unreadNews', 'Hay novedades sin leer')}"></i>` : ''}</button><button data-dm-open-settings title="${t('settings', 'Ajustes')}" class="dm-settings-entry">${dmIcon('settings')}</button><button data-dm-theme-toggle title="${t('themeToggle', 'Cambiar tema')}">${dmIcon('moon')}</button></footer>
  </aside>`;
}

function selectionControlsMarkup(context) {
  const selectedCount = Number(context.selectedJobIds?.size || 0);
  const visible = Array.isArray(context.visible) ? context.visible : [];
  const allVisibleSelected = Boolean(visible.length) && visible.every((job) => context.selectedJobIds?.has(Number(job.id)));
  const selectionTools = context.selectionMode
    ? `<div class="dm-selection-tools"><button type="button" data-dm-select-all-visible title="${allVisibleSelected ? 'Quitar selección visible' : 'Seleccionar todas las descargas visibles'}">${dmIcon(allVisibleSelected ? 'x' : 'check', 18)}<span>${allVisibleSelected ? 'Ninguna' : 'Todas'}</span></button><select data-dm-bulk-priority aria-label="Cambiar prioridad de la selección" ${selectedCount ? '' : 'disabled'}><option value="">Prioridad…</option><option value="high">Alta</option><option value="normal">Normal</option><option value="low">Baja</option></select><button type="button" class="is-danger" data-dm-bulk-delete ${selectedCount ? '' : 'disabled'}>${dmIcon('trash', 18)}<span>Eliminar ${selectedCount || ''}</span></button><button type="button" data-dm-selection-toggle title="Salir de selección">${dmIcon('x', 18)}</button></div>`
    : `<button type="button" class="dm-selection-toggle" data-dm-selection-toggle title="Seleccionar descargas">${dmIcon('check', 18)}<span>Seleccionar</span></button>`;
  if (context.selectionMode) return selectionTools;
  return `${selectionTools}${categoryOptions(context.jobs, context.preferences.category, Boolean(context.categoryMenuOpen))}<button type="button" class="dm-details-toggle" data-dm-toggle="inspector" title="Mostrar detalles" aria-label="Mostrar detalles">${dmIcon('panel', 18)}</button>`;
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
       ${isNews ? '' : `<header class="dm-zen-top"><button class="dm-mobile-menu" data-dm-toggle="sidebar" aria-label="Abrir navegación">${dmIcon('queue')}</button>${unifiedSearchMarkup(context, 'zen')}<div class="dm-zen-head-actions">${compactStatsMarkup(jobs)}</div><div class="dm-zen-secondary-row"><div class="dm-zen-secondary-actions">${helperChipsMarkup({ disabled: Boolean(context.selectionMode) })}</div><div class="dm-zen-toolbar-actions">${selectionControlsMarkup({ ...context, visible, categoryMenuOpen: context.categoryMenuOpen })}</div></div></header>`}
      <div class="dm-zen-content ${isNews ? 'dm-news-content' : ''}">${activeSection === 'downloads' || activeSection === 'queue' || activeSection === 'running' || activeSection === 'completed' || activeSection === 'history' || activeSection === 'news' ? '' : sectionHeading(activeSection, visible.length)}${content}</div>
    </main>
    ${preferences.inspectorCollapsed && !mobileInspectorOpen ? '' : selectedInspector(selected, preferences)}
    ${settingsPopover(preferences, settingsOpen, context)}
  </section>`;
}
