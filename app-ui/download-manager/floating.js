const FLOATING_LAYER_ID = 'dm-floating-ui-layer';

function syncThemeVariables(layer, source) {
  if (!layer || !source) return;
  const computed = window.getComputedStyle(source);
  for (let index = layer.style.length - 1; index >= 0; index -= 1) {
    const property = layer.style.item(index);
    if (property?.startsWith('--dm-')) layer.style.removeProperty(property);
  }
  for (let index = 0; index < computed.length; index += 1) {
    const property = computed.item(index);
    if (!property?.startsWith('--dm-')) continue;
    const value = computed.getPropertyValue(property).trim();
    if (value) layer.style.setProperty(property, value);
  }
}

/** Shared top-level host for menus that must escape clipped workspace panels. */
export function ensureFloatingLayer() {
  let layer = document.getElementById(FLOATING_LAYER_ID);
  if (layer) return layer;
  layer = document.createElement('div');
  layer.id = FLOATING_LAYER_ID;
  layer.dataset.dmFloatingLayer = '1';
  layer.setAttribute('aria-live', 'off');
  Object.assign(layer.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '2147482999',
    pointerEvents: 'none',
    overflow: 'visible'
  });
  document.body.appendChild(layer);
  return layer;
}

export function clearFloatingLayer() {
  document.getElementById(FLOATING_LAYER_ID)?.replaceChildren();
}

export function mountFloatingMenus(root) {
  if (!root) return;
  const layer = ensureFloatingLayer();
  // A rerender replaces the host but leaves the shared fixed layer mounted.
  // Remove stale menu nodes before adopting the current render so a single
  // context-menu action cannot accumulate duplicate overlays.
  layer.replaceChildren();
  root.querySelectorAll('.dm-row-menu-floating').forEach((menu) => {
    // The overlay intentionally lives outside .dm-host. Capture the resolved
    // theme variables before detaching the menu so var(--dm-*) declarations
    // keep their surface, text, border, accent, and shadow in the overlay.
    syncThemeVariables(layer, menu);
    menu.style.pointerEvents = 'auto';
    layer.appendChild(menu);
  });
}
