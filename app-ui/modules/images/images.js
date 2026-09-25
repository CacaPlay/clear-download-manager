(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const uid = () => crypto.randomUUID?.() || `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const safeFileName = (value) => (value || "imagen-editada").trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").slice(0, 120) || "imagen-editada";
  const formatBytes = (bytes) => {
    if (!Number.isFinite(bytes) || bytes <= 0) return "—";
    const units = ["B", "KB", "MB", "GB"];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
  };
  const createCanvas = (width, height) => {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    return canvas;
  };
  const cloneCanvas = (source) => {
    const canvas = createCanvas(source.width, source.height);
    canvas.getContext("2d", { willReadFrequently: true }).drawImage(source, 0, 0);
    return canvas;
  };
  const canvasBlob = (canvas, type = "image/png", quality = .92) => new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("No se pudo generar el archivo.")), type, quality);
  });

  const refs = {
    fileInput: $("#file-input"), layerFileInput: $("#layer-file-input"), openButton: $("#open-button"), emptyOpen: $("#empty-open-button"), panelOpen: $("#panel-open-button"), libraryAdd: $("#library-add"),
    exportButton: $("#export-button"), saveProject: $("#save-project"), compareHold: $("#compare-hold"), undo: $("#undo-button"), redo: $("#redo-button"), historyLabel: $("#history-label"), documentStatus: $("#document-status"),
    viewport: $("#canvas-viewport"), stage: $("#canvas-stage"), canvas: $("#editor-canvas"), overlay: $("#overlay-canvas"), empty: $("#empty-canvas"), dropCurtain: $("#drop-curtain"),
    zoomOut: $("#zoom-out"), zoomIn: $("#zoom-in"), zoomValue: $("#zoom-value"), fit: $("#fit-button"), actual: $("#actual-button"), imageStats: $("#image-stats"),
    cropOverlay: $("#crop-overlay"), cropSize: $("#crop-size"), cropX: $("#crop-x"), cropY: $("#crop-y"), cropW: $("#crop-width"), cropH: $("#crop-height"), cropReset: $("#crop-reset"), cropApply: $("#crop-apply"),
    resizeW: $("#resize-width"), resizeH: $("#resize-height"), ratioLock: $("#ratio-lock"), resizeQuality: $("#resize-quality"), resizeResult: $("#resize-result"), resizeApply: $("#resize-apply"),
    brightness: $("#brightness"), contrast: $("#contrast"), saturation: $("#saturation"), blur: $("#blur"), adjustReset: $("#adjust-reset"), adjustApply: $("#adjust-apply"),
    filterIntensity: $("#filter-intensity"), filterIntensityOutput: $("#filter-intensity-output"), filterReset: $("#filter-reset"), filterApply: $("#filter-apply"),
    textContent: $("#text-content"), textFont: $("#text-font"), textSize: $("#text-size"), textColor: $("#text-color"), textStrokeColor: $("#text-stroke-color"), textX: $("#text-x"), textY: $("#text-y"), textStrokeWidth: $("#text-stroke-width"), textOpacity: $("#text-opacity"), textCenter: $("#text-center"), textApply: $("#text-apply"),
    shapeFill: $("#shape-fill"), shapeStroke: $("#shape-stroke"), shapeStrokeWidth: $("#shape-stroke-width"), shapeOpacity: $("#shape-opacity"), shapeFillEnabled: $("#shape-fill-enabled"), shapeX: $("#shape-x"), shapeY: $("#shape-y"), shapeW: $("#shape-width"), shapeH: $("#shape-height"), shapeApply: $("#shape-apply"),
    drawColor: $("#draw-color"), drawSize: $("#draw-size"), drawSizeOutput: $("#draw-size-output"), drawOpacity: $("#draw-opacity"), drawOpacityOutput: $("#draw-opacity-output"),
    backgroundColor: $("#background-color"), backgroundPadding: $("#background-padding"), backgroundPreview: $("#background-preview"), backgroundApply: $("#background-apply"),
    removeModes: $("#removebg-modes"), removeSample: $("#removebg-sample"), removeSampleLabel: $("#removebg-sample-label"), removeTolerance: $("#removebg-tolerance"), removeToleranceOutput: $("#removebg-tolerance-output"), removeFeather: $("#removebg-feather"), removeFeatherOutput: $("#removebg-feather-output"), removeContiguous: $("#removebg-contiguous"), removePreview: $("#removebg-preview"), removeApply: $("#removebg-apply"), removeManualWrap: $("#removebg-manual"), removeBrushSize: $("#removebg-brush-size"), removeBrushSizeOutput: $("#removebg-brush-size-output"), removeManualMode: $("#removebg-manual-mode"),
    retouchModes: $("#retouch-modes"), retouchSize: $("#retouch-size"), retouchSizeOutput: $("#retouch-size-output"), retouchOpacity: $("#retouch-opacity"), retouchOpacityOutput: $("#retouch-opacity-output"), cloneSource: $("#clone-source"),
    pixelX: $("#pixel-x"), pixelY: $("#pixel-y"), pixelW: $("#pixel-width"), pixelH: $("#pixel-height"), pixelSize: $("#pixel-size"), pixelSizeOutput: $("#pixel-size-output"), pixelRound: $("#pixel-round"), pixelFull: $("#pixel-full"), pixelApply: $("#pixel-apply"),
    comparePosition: $("#compare-position"), comparePositionOutput: $("#compare-position-output"), compareEnabled: $("#compare-enabled"), compareSwap: $("#compare-swap"),
    layersCount: $("#layers-count"), layersList: $("#layers-list"), addLayer: $("#add-layer"), flattenLayers: $("#flatten-layers"), layerProperties: $("#layer-properties"), layerOpacity: $("#layer-opacity"), layerOpacityOutput: $("#layer-opacity-output"), layerBlend: $("#layer-blend"), layerUp: $("#layer-up"), layerDown: $("#layer-down"), layerDuplicate: $("#layer-duplicate"), layerDelete: $("#layer-delete"),
    libraryStrip: $("#library-strip"), libraryEmpty: $("#library-empty"), libraryTabs: $("#library-tabs"), clearLibrary: $("#clear-library"),
    exportDialog: $("#export-dialog"), exportClose: $("#export-close"), exportCancel: $("#export-cancel"), exportForm: $("#export-form"), exportPreview: $("#export-preview"), exportSize: $("#export-size"), exportName: $("#export-name"), exportFormat: $("#export-format"), exportQuality: $("#export-quality"), qualityOutput: $("#quality-output"), qualityField: $("#quality-field"), exportDimensions: $("#export-dimensions"),
    themeToggle: $("#theme-toggle"),
    watermarkText: $("#watermark-text"), watermarkFont: $("#watermark-font"), watermarkSize: $("#watermark-size"), watermarkColor: $("#watermark-color"), watermarkStroke: $("#watermark-stroke"), watermarkOpacity: $("#watermark-opacity"), watermarkOpacityOutput: $("#watermark-opacity-output"), watermarkRotation: $("#watermark-rotation"), watermarkRotationOutput: $("#watermark-rotation-output"), watermarkPosition: $("#watermark-position"), watermarkTile: $("#watermark-tile"), watermarkFingerprint: $("#watermark-fingerprint"), watermarkPreviewButton: $("#watermark-preview-button"), watermarkApply: $("#watermark-apply"),
    compressOriginalSize: $("#compress-original-size"), compressOutputSize: $("#compress-output-size"), compressSaving: $("#compress-saving"), compressFormat: $("#compress-format"), compressQuality: $("#compress-quality"), compressQualityOutput: $("#compress-quality-output"), compressQualityField: $("#compress-quality-field"), compressMaxSide: $("#compress-max-side"), compressPreview: $("#compress-preview"), compressStatus: $("#compress-status"), compressDownload: $("#compress-download"),
    metadataList: $("#metadata-list"), privacyAuthor: $("#privacy-author"), privacyCopyright: $("#privacy-copyright"), privacyProjectOnly: $("#privacy-project-only"), privacyFingerprint: $("#privacy-fingerprint"), privacyRefresh: $("#privacy-refresh"), privacyReport: $("#privacy-report"),
    collageFileInput: $("#collage-file-input"), collageAdd: $("#collage-add"), collageItems: $("#collage-items"), collageCurrentPreview: $("#collage-current-preview"), collageLayouts: $("#collage-layouts"), collageWidth: $("#collage-width"), collageRatio: $("#collage-ratio"), collageGap: $("#collage-gap"), collageBackground: $("#collage-background"), collageRadius: $("#collage-radius"), collageRadiusOutput: $("#collage-radius-output"), collageCreate: $("#collage-create"),
    toastRegion: $("#toast-region")
  };

  const displayContext = refs.canvas.getContext("2d", { willReadFrequently: true });
  const overlayContext = refs.overlay.getContext("2d", { willReadFrequently: true });
  const state = {
    loaded: false,
    fileName: "imagen",
    fileSize: 0,
    mime: "image/png",
    width: 1,
    height: 1,
    zoom: 1,
    minZoom: .05,
    maxZoom: 8,
    tool: "open",
    layers: [],
    activeLayerId: null,
    history: [],
    historyIndex: -1,
    historyLimit: 18,
    historyMaxBytes: 224 * 1024 * 1024,
    ratioLocked: true,
    sourceRatio: 1,
    crop: { x: 0, y: 0, width: 1, height: 1, aspect: null },
    adjustmentValues: { brightness: 0, contrast: 0, saturation: 0, blur: 0 },
    filter: { name: "none", intensity: 100 },
    text: { style: "normal", align: "left" },
    shape: { type: "rectangle", dragging: null },
    draw: { mode: "pen", active: false, last: null, changed: false },
    removebg: { mode: "auto", sample: [255, 255, 255], preview: null, manual: { active: false, changed: false, last: null, source: null, restore: false, hover: null } },
    direct: { openPan: null, resizePreviewScale: 1 },
    retouch: { mode: "clone", active: false, last: null, source: null, sourceOffset: null, snapshot: null, changed: false },
    pixel: { dragging: null },
    compare: { enabled: true, position: 50, flipped: false, holding: false },
    originalCanvas: null,
    activeLibraryId: null,
    activeProjectId: null,
    libraryTab: "recent",
    panning: false,
    spacePressed: false,
    dragDepth: 0,
    exportToken: 0,
    autosaveTimer: null,
    restoring: false,
    originalBlob: null,
    originalMetadata: { status: "Sin analizar", fields: {}, hasExif: false, hasGps: false },
    privacy: { author: "", copyright: "", projectOnly: true },
    watermark: { position: "mc", preview: false },
    compression: { token: 0, blob: null, width: 0, height: 0, timer: null },
    collage: { layout: "grid", items: [] }
  };

  const toast = (message, type = "info") => {
    const item = document.createElement("div");
    item.className = `toast ${type}`;
    item.textContent = message;
    refs.toastRegion.append(item);
    window.setTimeout(() => item.remove(), 3200);
  };

  const safeStorage = {
    get(key) { try { return localStorage.getItem(key); } catch (_) { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch (_) { /* almacenamiento bloqueado */ } }
  };

  const setTheme = (theme, persist = false) => {
    if (theme !== "light" && theme !== "dark") return;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    if (persist) safeStorage.set("cacatools-theme", theme);
  };

  const detectIntegration = () => {
    const params = new URLSearchParams(location.search);
    if (params.get("embed") === "1") document.body.classList.add("embedded");
    let integrated = false;
    try {
      if (window.parent !== window) {
        const parentRoot = window.parent.document.documentElement;
        const sync = () => setTheme(parentRoot.dataset.theme || "dark");
        sync();
        new MutationObserver(sync).observe(parentRoot, { attributes: true, attributeFilter: ["data-theme"] });
        integrated = true;
      }
    } catch (_) { /* origen distinto */ }
    if (!integrated) {
      const stored = safeStorage.get("cacatools-theme");
      const preferred = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
      setTheme(stored || preferred);
    }
  };

  const notifyParent = () => {
    if (window.parent !== window) {
      window.parent.postMessage({ type: "cacatools:images:state", loaded: state.loaded, width: state.width, height: state.height, dirty: state.historyIndex > 0, layers: state.layers.length }, "*");
    }
  };

  const makeLayer = (name, width = state.width, height = state.height) => ({
    id: uid(),
    name: name || `Capa ${state.layers.length + 1}`,
    canvas: createCanvas(width, height),
    visible: true,
    opacity: 1,
    blendMode: "source-over"
  });

  const activeLayer = () => state.layers.find((layer) => layer.id === state.activeLayerId) || state.layers[state.layers.length - 1] || null;
  const activeContext = () => activeLayer()?.canvas.getContext("2d", { willReadFrequently: true }) || null;

  const setDocumentSize = (width, height) => {
    state.width = Math.max(1, Math.round(width));
    state.height = Math.max(1, Math.round(height));
    refs.canvas.width = state.width;
    refs.canvas.height = state.height;
    refs.overlay.width = state.width;
    refs.overlay.height = state.height;
    updateStageSize();
  };

  const renderComposite = (target = displayContext, options = {}) => {
    target.save();
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.globalAlpha = 1;
    target.globalCompositeOperation = "source-over";
    target.filter = "none";
    target.clearRect(0, 0, state.width, state.height);
    for (const layer of state.layers) {
      if (!layer.visible) continue;
      target.globalAlpha = clamp(layer.opacity, 0, 1);
      target.globalCompositeOperation = layer.blendMode || "source-over";
      const sourceCanvas = options.overrideLayerId === layer.id && options.overrideCanvas ? options.overrideCanvas : layer.canvas;
      target.drawImage(sourceCanvas, 0, 0);
    }
    target.restore();
    if (target === displayContext && !options.skipOverlay) renderToolOverlay();
  };

  const flattenToCanvas = () => {
    const canvas = createCanvas(state.width, state.height);
    renderComposite(canvas.getContext("2d", { willReadFrequently: true }), { skipOverlay: true });
    return canvas;
  };

  const updateStageSize = () => {
    if (!state.loaded) return;
    refs.stage.style.width = `${Math.max(1, Math.round(state.width * state.zoom))}px`;
    refs.stage.style.height = `${Math.max(1, Math.round(state.height * state.zoom))}px`;
    refs.zoomValue.textContent = `${Math.round(state.zoom * 100)}%`;
    updateStagePreviewTransform();
    renderCropOverlay();
    renderToolOverlay();
  };

  const updateStagePreviewTransform = () => {
    if (!refs.stage) return;
    const scale = state.tool === "resize" ? state.direct.resizePreviewScale : 1;
    refs.stage.style.transform = scale !== 1 ? `scale(${scale})` : "";
  };

  const syncRemovebgUI = () => {
    if (!refs.removeManualWrap) return;
    const manual = state.removebg.mode === "manual";
    refs.removeManualWrap.hidden = !manual;
    if (refs.removePreview) refs.removePreview.hidden = manual;
    if (refs.removeApply) refs.removeApply.hidden = manual;
    document.querySelectorAll('.removebg-auto-only').forEach((item) => { item.hidden = manual; });
    if (manual) {
      const layer = activeLayer();
      state.removebg.manual.source = layer ? cloneCanvas(layer.canvas) : null;
    }
  };

  const updateResizePreviewFromFields = () => {
    if (!state.loaded) return;
    const width = clamp(Math.round(Number(refs.resizeW.value) || state.width), 1, 20000);
    state.direct.resizePreviewScale = clamp(width / state.width, .1, 6);
    updateStagePreviewTransform();
  };

  const setZoom = (zoom, preserveCenter = true) => {
    if (!state.loaded) return;
    const previousWidth = state.width * state.zoom;
    const previousHeight = state.height * state.zoom;
    const centerX = refs.viewport.scrollLeft + refs.viewport.clientWidth / 2;
    const centerY = refs.viewport.scrollTop + refs.viewport.clientHeight / 2;
    const ratioX = previousWidth ? centerX / previousWidth : .5;
    const ratioY = previousHeight ? centerY / previousHeight : .5;
    state.zoom = clamp(zoom, state.minZoom, state.maxZoom);
    updateStageSize();
    if (preserveCenter) requestAnimationFrame(() => {
      refs.viewport.scrollLeft = state.width * state.zoom * ratioX - refs.viewport.clientWidth / 2;
      refs.viewport.scrollTop = state.height * state.zoom * ratioY - refs.viewport.clientHeight / 2;
    });
  };

  const fitCanvas = () => {
    if (!state.loaded) return;
    const padding = 92;
    const availableW = Math.max(120, refs.viewport.clientWidth - padding);
    const availableH = Math.max(120, refs.viewport.clientHeight - padding);
    setZoom(Math.min(availableW / state.width, availableH / state.height, 1), false);
    requestAnimationFrame(() => {
      refs.viewport.scrollLeft = Math.max(0, (refs.stage.offsetWidth + 96 - refs.viewport.clientWidth) / 2);
      refs.viewport.scrollTop = Math.max(0, (refs.stage.offsetHeight + 96 - refs.viewport.clientHeight) / 2);
    });
  };

  const snapshot = (label) => {
    let bytes = 0;
    const layers = state.layers.map((layer) => {
      const imageData = layer.canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, state.width, state.height);
      bytes += imageData.data.byteLength;
      return { id: layer.id, name: layer.name, visible: layer.visible, opacity: layer.opacity, blendMode: layer.blendMode, imageData };
    });
    return { label, width: state.width, height: state.height, activeLayerId: state.activeLayerId, layers, bytes };
  };

  const pushHistory = (label) => {
    if (!state.loaded || state.restoring) return;
    if (state.historyIndex < state.history.length - 1) state.history.splice(state.historyIndex + 1);
    state.history.push(snapshot(label));
    const totalBytes = () => state.history.reduce((total, item) => total + item.bytes, 0);
    while (state.history.length > 1 && (state.history.length > state.historyLimit || totalBytes() > state.historyMaxBytes)) state.history.shift();
    state.historyIndex = state.history.length - 1;
    updateHistoryUI();
    renderComposite();
    updateCanvasMeta();
    renderLayersUI();
    scheduleAutosave();
    notifyParent();
  };

  const restoreSnapshot = (item) => {
    state.restoring = true;
    setDocumentSize(item.width, item.height);
    state.layers = item.layers.map((stored) => {
      const layer = makeLayer(stored.name, item.width, item.height);
      layer.id = stored.id;
      layer.visible = stored.visible;
      layer.opacity = stored.opacity;
      layer.blendMode = stored.blendMode;
      layer.canvas.getContext("2d", { willReadFrequently: true }).putImageData(stored.imageData, 0, 0);
      return layer;
    });
    state.activeLayerId = state.layers.some((layer) => layer.id === item.activeLayerId) ? item.activeLayerId : state.layers.at(-1)?.id;
    state.sourceRatio = state.width / state.height;
    resetAdjustments(false);
    syncDimensionFields();
    renderComposite();
    updateCanvasMeta();
    renderLayersUI();
    clearOverlay();
    if (state.tool === "crop") resetCropSelection();
    else renderToolOverlay();
    state.restoring = false;
  };

  const undo = () => {
    if (state.historyIndex <= 0) return;
    const undone = state.history[state.historyIndex].label;
    state.historyIndex -= 1;
    restoreSnapshot(state.history[state.historyIndex]);
    updateHistoryUI();
    scheduleAutosave();
    toast(`Deshecho: ${undone}`);
  };

  const redo = () => {
    if (state.historyIndex >= state.history.length - 1) return;
    state.historyIndex += 1;
    restoreSnapshot(state.history[state.historyIndex]);
    updateHistoryUI();
    scheduleAutosave();
    toast(`Rehecho: ${state.history[state.historyIndex].label}`);
  };

  const updateHistoryUI = () => {
    refs.undo.disabled = state.historyIndex <= 0;
    refs.redo.disabled = state.historyIndex < 0 || state.historyIndex >= state.history.length - 1;
    const changes = Math.max(0, state.historyIndex);
    refs.historyLabel.textContent = `${changes} ${changes === 1 ? "cambio" : "cambios"}`;
  };

  const updateCanvasMeta = () => {
    if (!state.loaded) {
      refs.imageStats.innerHTML = "<span>— × — px</span><span>—</span>";
      refs.documentStatus.textContent = "Sin imagen abierta";
      return;
    }
    refs.imageStats.innerHTML = `<span>${state.width.toLocaleString("es-ES")} × ${state.height.toLocaleString("es-ES")} px</span><span>${state.layers.length} ${state.layers.length === 1 ? "capa" : "capas"}</span>`;
    refs.documentStatus.textContent = `${state.fileName} · ${state.width} × ${state.height}px`;
    refs.exportDimensions.textContent = `${state.width.toLocaleString("es-ES")} × ${state.height.toLocaleString("es-ES")} px`;
  };

  const syncDimensionFields = () => {
    if (!state.loaded) return;
    refs.resizeW.value = state.width;
    refs.resizeH.value = state.height;
    refs.resizeResult.textContent = `${state.width.toLocaleString("es-ES")} × ${state.height.toLocaleString("es-ES")} px`;
  };

  const setLoadedUI = (loaded) => {
    state.loaded = loaded;
    refs.empty.hidden = loaded;
    refs.stage.hidden = !loaded;
    refs.exportButton.disabled = !loaded;
    refs.saveProject.disabled = !loaded;
    refs.compareHold.disabled = !loaded;
    refs.addLayer.disabled = !loaded;
    refs.flattenLayers.disabled = !loaded;
    [refs.zoomOut, refs.zoomIn, refs.zoomValue, refs.fit, refs.actual].forEach((button) => button.disabled = !loaded);
    $$('.tool-button[data-tool]').forEach((button) => { if (!["open", "collage"].includes(button.dataset.tool)) button.disabled = !loaded; });
    if (!loaded) refs.documentStatus.textContent = "Sin imagen abierta";
  };

  const decodeImage = async (blob) => {
    if ("createImageBitmap" in window) {
      try { return await createImageBitmap(blob, { imageOrientation: "from-image" }); } catch (_) { /* fallback */ }
    }
    return await new Promise((resolve, reject) => {
      const image = new Image();
      const url = URL.createObjectURL(blob);
      image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("No se pudo leer la imagen.")); };
      image.src = url;
    });
  };

  const loadBlob = async (blob, name = "imagen", options = {}) => {
    if (!blob || !blob.type.startsWith("image/")) { toast("Selecciona un archivo de imagen compatible.", "error"); return; }
    try {
      const image = await decodeImage(blob);
      const width = image.width || image.naturalWidth;
      const height = image.height || image.naturalHeight;
      if (!width || !height) throw new Error("La imagen no tiene dimensiones válidas.");
      if (width * height > 40_000_000) throw new Error("La imagen supera el límite seguro de 40 megapíxeles para edición local.");
      setDocumentSize(width, height);
      const layer = makeLayer(name.replace(/\.[^.]+$/, "") || "Imagen", width, height);
      layer.canvas.getContext("2d", { willReadFrequently: true }).drawImage(image, 0, 0, width, height);
      if (typeof image.close === "function") image.close();
      state.layers = [layer];
      state.activeLayerId = layer.id;
      state.fileName = name.replace(/\.[^.]+$/, "") || "imagen";
      state.fileSize = blob.size || 0;
      state.mime = blob.type || "image/png";
      state.originalBlob = blob;
      state.originalMetadata = await inspectImageMetadata(blob, name);
      state.sourceRatio = width / height;
      state.direct.resizePreviewScale = 1;
      state.history = [];
      state.historyIndex = -1;
      state.activeLibraryId = options.libraryId || null;
      state.activeProjectId = null;
      state.originalCanvas = cloneCanvas(layer.canvas);
      setLoadedUI(true);
      resetAdjustments(false);
      syncDimensionFields();
      renderComposite();
      updateCanvasMeta();
      renderLayersUI();
      updatePrivacyUI();
      renderCollageItems();
      pushHistory("Imagen abierta");
      selectTool("open");
      requestAnimationFrame(fitCanvas);
      if (!options.skipLibrary) await storage.addRecent(blob, name);
      renderLibrary();
      toast("Imagen abierta correctamente.");
    } catch (error) {
      console.error(error);
      toast(error.message || "No se pudo abrir la imagen.", "error");
    }
  };

  const addImageLayer = async (blob, name = "Capa importada") => {
    if (!state.loaded) return loadBlob(blob, name);
    try {
      const image = await decodeImage(blob);
      const layer = makeLayer(name.replace(/\.[^.]+$/, "") || "Capa importada");
      const ratio = Math.min(state.width / image.width, state.height / image.height, 1);
      const width = image.width * ratio;
      const height = image.height * ratio;
      layer.canvas.getContext("2d", { willReadFrequently: true }).drawImage(image, (state.width - width) / 2, (state.height - height) / 2, width, height);
      if (typeof image.close === "function") image.close();
      state.layers.push(layer);
      state.activeLayerId = layer.id;
      state.fileSize = 0;
      pushHistory("Capa importada");
      toast("Imagen añadida como capa.");
    } catch (error) { toast(error.message || "No se pudo añadir la capa.", "error"); }
  };

  const selectTool = (tool) => {
    if (!state.loaded && !["open", "collage"].includes(tool)) return;
    if (state.tool === "adjust" && tool !== "adjust") resetAdjustments(false);
    if (state.tool !== tool) {
      state.direct.openPan = null;
      if (tool !== "resize") state.direct.resizePreviewScale = 1;
    }
    state.tool = tool;
    refs.stage.className = `canvas-stage tool-${tool}`;
    $$('.tool-button[data-tool]').forEach((button) => button.classList.toggle("active", button.dataset.tool === tool));
    $$(".tool-panel").forEach((panel) => panel.classList.toggle("active", panel.dataset.panel === tool));
    refs.cropOverlay.hidden = tool !== "crop";
    if (tool === "crop") resetCropSelection();
    if (tool === "resize") { syncDimensionFields(); updateResizePreviewFromFields(); }
    else updateStagePreviewTransform();
    if (tool === "text") resetTextPosition(false);
    if (tool === "shapes") normalizeShapeFields();
    if (tool === "pixelate") normalizePixelFields();
    if (tool === "removebg") detectBackgroundSample();
    if (tool === "removebg") syncRemovebgUI();
    else if (refs.removeManualWrap) refs.removeManualWrap.hidden = true;
    if (tool === "watermark") { state.watermark.preview = true; renderWatermarkPreview(); }
    if (tool === "compress") updateCompressionEstimate();
    if (tool === "privacy") updatePrivacyUI();
    if (tool === "collage") renderCollageItems();
    renderToolOverlay();
  };

  const resetCropSelection = () => {
    if (!state.loaded) return;
    const width = Math.max(1, Math.round(state.width * .82));
    const height = Math.max(1, Math.round(state.height * .82));
    state.crop = { x: Math.round((state.width - width) / 2), y: Math.round((state.height - height) / 2), width, height, aspect: state.crop.aspect };
    if (state.crop.aspect) applyCropAspect(state.crop.aspect);
    syncCropInputs();
    renderCropOverlay();
  };

  const applyCropAspect = (aspect) => {
    if (!state.loaded || !aspect) return;
    let width = state.crop.width;
    let height = Math.round(width / aspect);
    if (height > state.height) { height = state.height; width = Math.round(height * aspect); }
    state.crop.width = Math.min(width, state.width);
    state.crop.height = Math.min(height, state.height);
    state.crop.x = clamp(Math.round(state.crop.x), 0, state.width - state.crop.width);
    state.crop.y = clamp(Math.round(state.crop.y), 0, state.height - state.crop.height);
    syncCropInputs();
    renderCropOverlay();
  };

  const normalizeCrop = () => {
    state.crop.width = clamp(Math.round(state.crop.width), 1, state.width);
    state.crop.height = clamp(Math.round(state.crop.height), 1, state.height);
    state.crop.x = clamp(Math.round(state.crop.x), 0, state.width - state.crop.width);
    state.crop.y = clamp(Math.round(state.crop.y), 0, state.height - state.crop.height);
  };

  const syncCropInputs = () => {
    normalizeCrop();
    refs.cropX.value = state.crop.x;
    refs.cropY.value = state.crop.y;
    refs.cropW.value = state.crop.width;
    refs.cropH.value = state.crop.height;
  };

  const renderCropOverlay = () => {
    if (!state.loaded || state.tool !== "crop") return;
    normalizeCrop();
    refs.cropOverlay.style.left = `${state.crop.x * state.zoom}px`;
    refs.cropOverlay.style.top = `${state.crop.y * state.zoom}px`;
    refs.cropOverlay.style.width = `${state.crop.width * state.zoom}px`;
    refs.cropOverlay.style.height = `${state.crop.height * state.zoom}px`;
    refs.cropSize.textContent = `${state.crop.width} × ${state.crop.height}`;
  };

  const transformLayers = (width, height, painter) => {
    state.layers = state.layers.map((layer) => {
      const transformed = makeLayer(layer.name, width, height);
      transformed.id = layer.id;
      transformed.visible = layer.visible;
      transformed.opacity = layer.opacity;
      transformed.blendMode = layer.blendMode;
      painter(transformed.canvas.getContext("2d", { willReadFrequently: true }), layer.canvas);
      return transformed;
    });
    setDocumentSize(width, height);
  };

  const applyCrop = () => {
    normalizeCrop();
    const { x, y, width, height } = state.crop;
    if (width === state.width && height === state.height && x === 0 && y === 0) { toast("El recorte coincide con la imagen completa."); return; }
    transformLayers(width, height, (ctx, source) => ctx.drawImage(source, x, y, width, height, 0, 0, width, height));
    state.sourceRatio = width / height;
    state.fileSize = 0;
    pushHistory("Recorte");
    syncDimensionFields();
    resetCropSelection();
    fitCanvas();
    toast("Recorte aplicado a todas las capas.");
  };

  const applyResize = () => {
    const width = clamp(Math.round(Number(refs.resizeW.value)), 1, 20000);
    const height = clamp(Math.round(Number(refs.resizeH.value)), 1, 20000);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width * height > 40_000_000) { toast("Las dimensiones indicadas no son válidas.", "error"); return; }
    if (width === state.width && height === state.height) { toast("La imagen ya tiene esas dimensiones."); return; }
    transformLayers(width, height, (ctx, source) => {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = refs.resizeQuality.value;
      ctx.drawImage(source, 0, 0, width, height);
    });
    state.sourceRatio = width / height;
    state.fileSize = 0;
    pushHistory("Redimensionado");
    syncDimensionFields();
    fitCanvas();
    state.direct.resizePreviewScale = 1;
    updateStagePreviewTransform();
    toast(`Documento redimensionado a ${width} × ${height}px.`);
  };

  const rotateCanvas = (degrees) => {
    if (degrees === 360) { setZoom(1); toast("Vista restablecida al 100%."); return; }
    const radians = degrees * Math.PI / 180;
    const swap = Math.abs(degrees) % 180 === 90;
    const width = swap ? state.height : state.width;
    const height = swap ? state.width : state.height;
    const oldW = state.width;
    const oldH = state.height;
    transformLayers(width, height, (ctx, source) => {
      ctx.translate(width / 2, height / 2);
      ctx.rotate(radians);
      ctx.drawImage(source, -oldW / 2, -oldH / 2);
    });
    state.sourceRatio = width / height;
    state.fileSize = 0;
    pushHistory(`Rotación ${degrees}°`);
    syncDimensionFields();
    fitCanvas();
    toast(`Rotación de ${degrees}° aplicada a todas las capas.`);
  };

  const flipCanvas = (direction) => {
    const width = state.width;
    const height = state.height;
    transformLayers(width, height, (ctx, source) => {
      if (direction === "horizontal") { ctx.translate(width, 0); ctx.scale(-1, 1); }
      else { ctx.translate(0, height); ctx.scale(1, -1); }
      ctx.drawImage(source, 0, 0);
    });
    state.fileSize = 0;
    pushHistory(`Volteo ${direction}`);
    toast(`Volteo ${direction === "horizontal" ? "horizontal" : "vertical"} aplicado.`);
  };

  const adjustmentFilter = () => {
    const { brightness, contrast, saturation, blur } = state.adjustmentValues;
    return `brightness(${100 + brightness}%) contrast(${100 + contrast}%) saturate(${100 + saturation}%) blur(${blur}px)`;
  };

  const previewAdjustments = () => { refs.canvas.style.filter = adjustmentFilter(); };

  const resetAdjustments = (announce = true) => {
    state.adjustmentValues = { brightness: 0, contrast: 0, saturation: 0, blur: 0 };
    ["brightness", "contrast", "saturation", "blur"].forEach((key) => {
      refs[key].value = 0;
      $(`#${key}-output`).textContent = key === "blur" ? "0 px" : "0";
    });
    refs.canvas.style.filter = "none";
    if (announce) toast("Ajustes restablecidos.");
  };

  const applyAdjustments = () => {
    if (Object.values(state.adjustmentValues).every((value) => Number(value) === 0)) { toast("No hay ajustes pendientes."); return; }
    const layer = activeLayer();
    if (!layer) return;
    const temp = createCanvas(state.width, state.height);
    const ctx = temp.getContext("2d", { willReadFrequently: true });
    ctx.filter = adjustmentFilter();
    ctx.drawImage(layer.canvas, 0, 0);
    layer.canvas = temp;
    refs.canvas.style.filter = "none";
    state.fileSize = 0;
    resetAdjustments(false);
    pushHistory("Ajustes de color");
    toast("Ajustes aplicados a la capa activa.");
  };

  const FILTERS = {
    none: { label: "Original", filter: "none" },
    mono: { label: "Mono", filter: "grayscale(100%)" },
    sepia: { label: "Sepia", filter: "sepia(100%)" },
    vintage: { label: "Vintage", filter: "sepia(55%) contrast(112%) saturate(78%) brightness(95%)" },
    warm: { label: "Cálido", filter: "sepia(24%) saturate(135%) hue-rotate(-12deg)" },
    cool: { label: "Frío", filter: "saturate(112%) hue-rotate(18deg) contrast(104%)" },
    vivid: { label: "Vívido", filter: "saturate(180%) contrast(115%)" },
    invert: { label: "Invertir", filter: "invert(100%)" }
  };

  const clearOverlay = () => {
    overlayContext.save();
    overlayContext.setTransform(1, 0, 0, 1, 0, 0);
    overlayContext.globalAlpha = 1;
    overlayContext.globalCompositeOperation = "source-over";
    overlayContext.filter = "none";
    overlayContext.clearRect(0, 0, refs.overlay.width, refs.overlay.height);
    overlayContext.restore();
  };

  const canvasPoint = (event) => {
    const rect = refs.overlay.getBoundingClientRect();
    return {
      x: clamp((event.clientX - rect.left) * state.width / Math.max(1, rect.width), 0, state.width),
      y: clamp((event.clientY - rect.top) * state.height / Math.max(1, rect.height), 0, state.height)
    };
  };

  const renderFilterPreview = () => {
    clearOverlay();
    const layer = activeLayer();
    const preset = FILTERS[state.filter.name] || FILTERS.none;
    const intensity = clamp(Number(state.filter.intensity) / 100, 0, 1);
    if (!layer || preset.filter === "none" || intensity <= 0) return;
    overlayContext.save();
    overlayContext.filter = preset.filter;
    overlayContext.globalAlpha = intensity * layer.opacity;
    overlayContext.globalCompositeOperation = layer.blendMode;
    overlayContext.drawImage(layer.canvas, 0, 0);
    overlayContext.restore();
  };

  const applyFilter = () => {
    const layer = activeLayer();
    const preset = FILTERS[state.filter.name] || FILTERS.none;
    const intensity = clamp(Number(state.filter.intensity) / 100, 0, 1);
    if (!layer || preset.filter === "none" || intensity <= 0) { toast("Selecciona un filtro con intensidad mayor que 0."); return; }
    const base = cloneCanvas(layer.canvas);
    const filtered = createCanvas(state.width, state.height);
    const filteredContext = filtered.getContext("2d", { willReadFrequently: true });
    filteredContext.filter = preset.filter;
    filteredContext.drawImage(base, 0, 0);
    const target = layer.canvas.getContext("2d", { willReadFrequently: true });
    target.clearRect(0, 0, state.width, state.height);
    target.drawImage(base, 0, 0);
    target.save();
    target.globalAlpha = intensity;
    target.drawImage(filtered, 0, 0);
    target.restore();
    clearOverlay();
    state.fileSize = 0;
    pushHistory(`Filtro ${preset.label}`);
    toast(`Filtro ${preset.label} aplicado a la capa activa.`);
  };

  const resetFilter = (announce = true) => {
    state.filter = { name: "none", intensity: 100 };
    refs.filterIntensity.value = 100;
    refs.filterIntensityOutput.textContent = "100%";
    $$("#filter-grid button").forEach((button) => button.classList.toggle("active", button.dataset.filter === "none"));
    clearOverlay();
    if (announce) toast("Filtro restablecido.");
  };

  const textValues = () => ({
    content: refs.textContent.value,
    font: refs.textFont.value,
    size: clamp(Number(refs.textSize.value) || 64, 8, 600),
    color: refs.textColor.value,
    strokeColor: refs.textStrokeColor.value,
    strokeWidth: clamp(Number(refs.textStrokeWidth.value) || 0, 0, 30),
    opacity: clamp((Number(refs.textOpacity.value) || 100) / 100, .01, 1),
    x: clamp(Number(refs.textX.value) || 0, 0, state.width),
    y: clamp(Number(refs.textY.value) || 0, 0, state.height),
    style: state.text.style,
    align: state.text.align
  });

  const drawText = (target, values) => {
    const lines = values.content.split(/\r?\n/).slice(0, 20);
    if (!lines.join("").trim()) return;
    target.save();
    target.globalAlpha = values.opacity;
    target.font = `${values.style === "normal" ? "" : `${values.style} `}${values.size}px ${values.font}`;
    target.textAlign = values.align;
    target.textBaseline = "top";
    target.lineJoin = "round";
    target.fillStyle = values.color;
    target.strokeStyle = values.strokeColor;
    target.lineWidth = values.strokeWidth * 2;
    lines.forEach((line, index) => {
      const y = values.y + index * values.size * 1.18;
      if (values.strokeWidth > 0) target.strokeText(line || " ", values.x, y);
      target.fillText(line || " ", values.x, y);
    });
    target.restore();
  };

  const resetTextPosition = (force = true) => {
    if (!state.loaded) return;
    if (force || Number(refs.textX.value) > state.width || Number(refs.textY.value) > state.height) {
      refs.textX.value = Math.round(state.width * .12);
      refs.textY.value = Math.round(state.height * .12);
    }
    renderTextPreview();
  };

  const renderTextPreview = () => { clearOverlay(); drawText(overlayContext, textValues()); };

  const applyText = () => {
    const values = textValues();
    if (!values.content.trim()) { toast("Escribe algún texto antes de añadirlo.", "error"); return; }
    const layer = makeLayer(`Texto: ${values.content.trim().split(/\s+/).slice(0, 3).join(" ")}`);
    drawText(layer.canvas.getContext("2d", { willReadFrequently: true }), values);
    state.layers.push(layer);
    state.activeLayerId = layer.id;
    clearOverlay();
    state.fileSize = 0;
    pushHistory("Texto añadido");
    toast("Texto añadido como capa independiente.");
    renderTextPreview();
  };

  const shapeValues = () => ({
    type: state.shape.type,
    fill: refs.shapeFill.value,
    stroke: refs.shapeStroke.value,
    strokeWidth: clamp(Number(refs.shapeStrokeWidth.value) || 0, 0, 80),
    opacity: clamp((Number(refs.shapeOpacity.value) || 100) / 100, .01, 1),
    fillEnabled: refs.shapeFillEnabled.checked,
    x: clamp(Number(refs.shapeX.value) || 0, 0, state.width),
    y: clamp(Number(refs.shapeY.value) || 0, 0, state.height),
    width: clamp(Number(refs.shapeW.value) || 1, 1, state.width),
    height: clamp(Number(refs.shapeH.value) || 1, 1, state.height)
  });

  const drawArrow = (target, x1, y1, x2, y2, headSize) => {
    const angle = Math.atan2(y2 - y1, x2 - x1);
    target.beginPath();
    target.moveTo(x1, y1); target.lineTo(x2, y2); target.stroke();
    target.beginPath(); target.moveTo(x2, y2);
    target.lineTo(x2 - headSize * Math.cos(angle - Math.PI / 6), y2 - headSize * Math.sin(angle - Math.PI / 6));
    target.lineTo(x2 - headSize * Math.cos(angle + Math.PI / 6), y2 - headSize * Math.sin(angle + Math.PI / 6));
    target.closePath(); target.fill();
  };

  const drawShape = (target, values) => {
    target.save();
    target.globalAlpha = values.opacity;
    target.fillStyle = values.fill;
    target.strokeStyle = values.stroke;
    target.lineWidth = values.strokeWidth;
    target.lineJoin = "round";
    target.lineCap = "round";
    if (values.type === "rectangle") {
      if (values.fillEnabled) target.fillRect(values.x, values.y, values.width, values.height);
      if (values.strokeWidth > 0) target.strokeRect(values.x, values.y, values.width, values.height);
    } else if (values.type === "ellipse") {
      target.beginPath(); target.ellipse(values.x + values.width / 2, values.y + values.height / 2, values.width / 2, values.height / 2, 0, 0, Math.PI * 2);
      if (values.fillEnabled) target.fill();
      if (values.strokeWidth > 0) target.stroke();
    } else if (values.type === "line") {
      target.beginPath(); target.moveTo(values.x, values.y); target.lineTo(values.x + values.width, values.y + values.height); target.stroke();
    } else {
      const head = Math.max(12, values.strokeWidth * 3.2);
      target.fillStyle = values.stroke;
      drawArrow(target, values.x, values.y, values.x + values.width, values.y + values.height, head);
    }
    target.restore();
  };

  const normalizeShapeFields = () => {
    if (!state.loaded) return;
    refs.shapeX.value = Math.round(clamp(Number(refs.shapeX.value) || state.width * .12, 0, state.width - 1));
    refs.shapeY.value = Math.round(clamp(Number(refs.shapeY.value) || state.height * .12, 0, state.height - 1));
    refs.shapeW.value = Math.round(clamp(Number(refs.shapeW.value) || state.width * .4, 1, state.width - Number(refs.shapeX.value)));
    refs.shapeH.value = Math.round(clamp(Number(refs.shapeH.value) || state.height * .3, 1, state.height - Number(refs.shapeY.value)));
    renderShapePreview();
  };

  const renderShapePreview = () => { clearOverlay(); drawShape(overlayContext, shapeValues()); };

  const applyShape = () => {
    const layer = makeLayer(`Forma ${state.shape.type}`);
    drawShape(layer.canvas.getContext("2d", { willReadFrequently: true }), shapeValues());
    state.layers.push(layer);
    state.activeLayerId = layer.id;
    clearOverlay();
    state.fileSize = 0;
    pushHistory(`Forma ${state.shape.type}`);
    toast("Forma añadida como capa independiente.");
    renderShapePreview();
  };

  const drawSegment = (from, to, dot = false) => {
    const ctx = activeContext();
    if (!ctx) return;
    const mode = state.draw.mode;
    const size = Number(refs.drawSize.value);
    const opacity = Number(refs.drawOpacity.value) / 100;
    ctx.save();
    ctx.globalCompositeOperation = mode === "eraser" ? "destination-out" : "source-over";
    ctx.globalAlpha = mode === "marker" ? opacity * .35 : opacity;
    ctx.strokeStyle = refs.drawColor.value;
    ctx.fillStyle = refs.drawColor.value;
    ctx.lineWidth = mode === "marker" ? size * 2 : size;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (dot) { ctx.beginPath(); ctx.arc(to.x, to.y, ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill(); }
    else { ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke(); }
    ctx.restore();
    renderComposite(displayContext, { skipOverlay: true });
  };

  const beginDraw = (event) => {
    if (state.tool !== "draw" || event.button !== 0 || state.spacePressed) return;
    event.preventDefault();
    state.draw.active = true;
    state.draw.last = canvasPoint(event);
    state.draw.changed = true;
    refs.overlay.setPointerCapture(event.pointerId);
    drawSegment(state.draw.last, state.draw.last, true);
  };

  const moveDraw = (event) => {
    if (!state.draw.active) return;
    event.preventDefault();
    const point = canvasPoint(event);
    drawSegment(state.draw.last, point);
    state.draw.last = point;
  };

  const endDraw = (event) => {
    if (!state.draw.active) return;
    state.draw.active = false;
    try { refs.overlay.releasePointerCapture(event.pointerId); } catch (_) {}
    if (state.draw.changed) {
      state.draw.changed = false;
      state.fileSize = 0;
      const labels = { pen: "Trazo de lápiz", marker: "Trazo de marcador", eraser: "Trazo de borrador" };
      pushHistory(labels[state.draw.mode]);
    }
  };

  const applyBackground = () => {
    const padding = clamp(Math.round(Number(refs.backgroundPadding.value) || 0), 0, 2000);
    const width = state.width + padding * 2;
    const height = state.height + padding * 2;
    if (width * height > 40_000_000) { toast("El lienzo resultante supera el límite seguro de 40 megapíxeles.", "error"); return; }
    if (padding) {
      const oldLayers = state.layers;
      state.layers = oldLayers.map((layer) => {
        const expanded = makeLayer(layer.name, width, height);
        expanded.id = layer.id;
        expanded.visible = layer.visible;
        expanded.opacity = layer.opacity;
        expanded.blendMode = layer.blendMode;
        expanded.canvas.getContext("2d", { willReadFrequently: true }).drawImage(layer.canvas, padding, padding);
        return expanded;
      });
      setDocumentSize(width, height);
    }
    const background = makeLayer("Fondo", state.width, state.height);
    const ctx = background.canvas.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = refs.backgroundColor.value;
    ctx.fillRect(0, 0, state.width, state.height);
    state.layers.unshift(background);
    state.activeLayerId = background.id;
    state.sourceRatio = state.width / state.height;
    state.fileSize = 0;
    pushHistory(padding ? "Fondo y margen" : "Fondo");
    syncDimensionFields();
    if (padding) fitCanvas();
    toast(padding ? `Fondo añadido con ${padding}px de margen.` : "Fondo añadido como capa.");
  };

  const updateBackgroundPreview = () => { refs.backgroundPreview.querySelector("span").style.background = refs.backgroundColor.value; };

  const averageCornerColor = (imageData) => {
    const { data, width, height } = imageData;
    const points = [[1, 1], [width - 2, 1], [1, height - 2], [width - 2, height - 2]];
    const total = [0, 0, 0];
    points.forEach(([x, y]) => {
      const index = (Math.max(0, y) * width + Math.max(0, x)) * 4;
      total[0] += data[index]; total[1] += data[index + 1]; total[2] += data[index + 2];
    });
    return total.map((value) => Math.round(value / points.length));
  };

  const setRemoveSample = (rgb, label) => {
    state.removebg.sample = rgb;
    refs.removeSample.style.background = `rgb(${rgb.join(",")})`;
    refs.removeSampleLabel.textContent = label;
  };

  const averageEdgeColor = (imageData) => {
    const { data, width, height } = imageData;
    const total = [0, 0, 0]; let count = 0;
    for (let x = 0; x < width; x += Math.max(1, Math.round(width / 80))) {
      for (const y of [0, Math.max(0, height - 1)]) {
        const index = (y * width + x) * 4; total[0] += data[index]; total[1] += data[index + 1]; total[2] += data[index + 2]; count += 1;
      }
    }
    for (let y = 0; y < height; y += Math.max(1, Math.round(height / 80))) {
      for (const x of [0, Math.max(0, width - 1)]) {
        const index = (y * width + x) * 4; total[0] += data[index]; total[1] += data[index + 1]; total[2] += data[index + 2]; count += 1;
      }
    }
    return total.map((value) => Math.round(value / Math.max(1, count)));
  };

  const detectBackgroundSample = () => {
    const layer = activeLayer();
    if (!layer) return;
    const data = layer.canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, state.width, state.height);
    if (state.removebg.mode === "edges") setRemoveSample(averageEdgeColor(data), "Detectado desde los bordes");
    else setRemoveSample(averageCornerColor(data), "Detectado desde las esquinas");
  };

  const colorDistance = (data, index, sample) => Math.hypot(data[index] - sample[0], data[index + 1] - sample[1], data[index + 2] - sample[2]);

  const backgroundMask = (imageData, sample, tolerance, feather, contiguous) => {
    const { width, height, data } = imageData;
    const mask = new Uint8Array(width * height);
    const qualifies = (pixel) => colorDistance(data, pixel * 4, sample) <= tolerance + feather;
    if (!contiguous) {
      for (let pixel = 0; pixel < mask.length; pixel += 1) if (qualifies(pixel)) mask[pixel] = 1;
      return mask;
    }
    const queue = new Int32Array(width * height);
    let head = 0; let tail = 0;
    const enqueue = (pixel) => { if (!mask[pixel] && qualifies(pixel)) { mask[pixel] = 1; queue[tail++] = pixel; } };
    for (let x = 0; x < width; x += 1) { enqueue(x); enqueue((height - 1) * width + x); }
    for (let y = 0; y < height; y += 1) { enqueue(y * width); enqueue(y * width + width - 1); }
    while (head < tail) {
      const pixel = queue[head++];
      const x = pixel % width; const y = Math.floor(pixel / width);
      if (x > 0) enqueue(pixel - 1);
      if (x < width - 1) enqueue(pixel + 1);
      if (y > 0) enqueue(pixel - width);
      if (y < height - 1) enqueue(pixel + width);
    }
    return mask;
  };

  const processRemoveBackground = (commit = false) => {
    const layer = activeLayer();
    if (!layer) return;
    const ctx = layer.canvas.getContext("2d", { willReadFrequently: true });
    const imageData = ctx.getImageData(0, 0, state.width, state.height);
    let tolerance = Number(refs.removeTolerance.value);
    let feather = Number(refs.removeFeather.value);
    let contiguous = refs.removeContiguous.checked;
    let sample = state.removebg.sample;
    if (state.removebg.mode === "auto") { sample = averageCornerColor(imageData); contiguous = true; }
    if (state.removebg.mode === "edges") { sample = averageEdgeColor(imageData); tolerance = Math.max(8, Math.round(tolerance * .82)); feather = Math.max(0, Math.round(feather * .7)); contiguous = true; }
    const mask = backgroundMask(imageData, sample, tolerance, feather, contiguous);
    const result = new ImageData(new Uint8ClampedArray(imageData.data), state.width, state.height);
    for (let pixel = 0; pixel < mask.length; pixel += 1) {
      if (!mask[pixel]) continue;
      const index = pixel * 4;
      const distance = colorDistance(result.data, index, sample);
      const alphaFactor = feather > 0 ? clamp((distance - tolerance) / feather, 0, 1) : 0;
      result.data[index + 3] = Math.round(result.data[index + 3] * alphaFactor);
    }
    if (commit) {
      ctx.putImageData(result, 0, 0);
      state.removebg.preview = null;
      clearOverlay();
      state.fileSize = 0;
      pushHistory("Fondo eliminado");
      toast("Fondo eliminado en la capa activa.");
    } else {
      clearOverlay();
      const preview = createCanvas(state.width, state.height);
      preview.getContext("2d", { willReadFrequently: true }).putImageData(result, 0, 0);
      state.removebg.preview = preview;
      renderComposite(displayContext, { skipOverlay: true, overrideLayerId: layer.id, overrideCanvas: preview });
      toast("Previsualización generada.");
    }
  };

  const renderManualRemoveCursor = () => {
    clearOverlay();
    if (!state.loaded || state.tool !== "removebg" || state.removebg.mode !== "manual" || !state.removebg.manual.hover) return;
    const size = Number(refs.removeBrushSize?.value || 44);
    const { x, y } = state.removebg.manual.hover;
    overlayContext.save();
    overlayContext.strokeStyle = state.removebg.manual.restore ? "#34d399" : "#a78bfa";
    overlayContext.lineWidth = Math.max(2, 2 / state.zoom);
    overlayContext.setLineDash([8 / state.zoom, 6 / state.zoom]);
    overlayContext.beginPath();
    overlayContext.arc(x, y, size / 2, 0, Math.PI * 2);
    overlayContext.stroke();
    overlayContext.restore();
  };

  const manualRemoveBrush = (from, to, dot = false) => {
    const layer = activeLayer();
    if (!layer) return;
    const ctx = layer.canvas.getContext("2d", { willReadFrequently: true });
    const size = Number(refs.removeBrushSize?.value || 44);
    const restore = state.removebg.manual.restore;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = size;
    if (!restore) {
      ctx.globalCompositeOperation = "destination-out";
      if (dot) { ctx.beginPath(); ctx.arc(to.x, to.y, size / 2, 0, Math.PI * 2); ctx.fill(); }
      else { ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke(); }
    } else if (state.removebg.manual.source) {
      ctx.beginPath();
      if (dot) ctx.arc(to.x, to.y, size / 2, 0, Math.PI * 2);
      else { ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); }
      ctx.stroke();
      ctx.clip();
      ctx.drawImage(state.removebg.manual.source, 0, 0);
    }
    ctx.restore();
    renderComposite(displayContext, { skipOverlay: true });
    renderManualRemoveCursor();
  };

  const beginManualRemove = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const layer = activeLayer();
    if (!layer) return;
    state.removebg.manual.active = true;
    state.removebg.manual.changed = true;
    state.removebg.manual.last = canvasPoint(event);
    if (!state.removebg.manual.source) state.removebg.manual.source = cloneCanvas(layer.canvas);
    refs.overlay.setPointerCapture(event.pointerId);
    manualRemoveBrush(state.removebg.manual.last, state.removebg.manual.last, true);
  };

  const moveManualRemove = (event) => {
    state.removebg.manual.hover = canvasPoint(event);
    if (!state.removebg.manual.active) { renderManualRemoveCursor(); return; }
    event.preventDefault();
    const point = canvasPoint(event);
    manualRemoveBrush(state.removebg.manual.last, point);
    state.removebg.manual.last = point;
  };

  const endManualRemove = (event) => {
    state.removebg.manual.active = false;
    try { refs.overlay.releasePointerCapture(event.pointerId); } catch (_) {}
    if (state.removebg.manual.changed) {
      state.removebg.manual.changed = false;
      state.fileSize = 0;
      pushHistory(state.removebg.manual.restore ? "Restauración manual de fondo" : "Borrado manual de fondo");
    }
    state.removebg.manual.source = activeLayer() ? cloneCanvas(activeLayer().canvas) : null;
    renderManualRemoveCursor();
  };

  const normalizePixelFields = () => {
    refs.pixelX.value = Math.round(clamp(Number(refs.pixelX.value) || state.width * .18, 0, state.width - 1));
    refs.pixelY.value = Math.round(clamp(Number(refs.pixelY.value) || state.height * .18, 0, state.height - 1));
    refs.pixelW.value = Math.round(clamp(Number(refs.pixelW.value) || state.width * .35, 1, state.width - Number(refs.pixelX.value)));
    refs.pixelH.value = Math.round(clamp(Number(refs.pixelH.value) || state.height * .28, 1, state.height - Number(refs.pixelY.value)));
    renderPixelPreview();
  };

  const pixelValues = () => {
    const x = clamp(Math.round(Number(refs.pixelX.value) || 0), 0, state.width - 1);
    const y = clamp(Math.round(Number(refs.pixelY.value) || 0), 0, state.height - 1);
    const width = clamp(Math.round(Number(refs.pixelW.value) || 1), 1, state.width - x);
    const height = clamp(Math.round(Number(refs.pixelH.value) || 1), 1, state.height - y);
    return { x, y, width, height, size: clamp(Number(refs.pixelSize.value) || 18, 3, 80), round: refs.pixelRound.checked };
  };

  const renderPixelPreview = () => {
    clearOverlay();
    if (state.tool !== "pixelate") return;
    const { x, y, width, height, size, round } = pixelValues();
    overlayContext.save();
    overlayContext.strokeStyle = "#a78bfa";
    overlayContext.lineWidth = Math.max(2, 2 / state.zoom);
    overlayContext.setLineDash([10 / state.zoom, 7 / state.zoom]);
    if (round) { overlayContext.beginPath(); overlayContext.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2); overlayContext.stroke(); }
    else overlayContext.strokeRect(x, y, width, height);
    overlayContext.globalAlpha = .22;
    overlayContext.fillStyle = "#8b5cf6";
    for (let gx = x; gx < x + width; gx += size) overlayContext.fillRect(gx, y, 1 / state.zoom, height);
    for (let gy = y; gy < y + height; gy += size) overlayContext.fillRect(x, gy, width, 1 / state.zoom);
    overlayContext.restore();
  };

  const applyPixelate = () => {
    const layer = activeLayer();
    if (!layer) return;
    const { x, y, width, height, size, round } = pixelValues();
    const smallW = Math.max(1, Math.ceil(width / size));
    const smallH = Math.max(1, Math.ceil(height / size));
    const small = createCanvas(smallW, smallH);
    const smallCtx = small.getContext("2d", { willReadFrequently: true });
    smallCtx.imageSmoothingEnabled = true;
    smallCtx.drawImage(layer.canvas, x, y, width, height, 0, 0, smallW, smallH);
    const target = layer.canvas.getContext("2d", { willReadFrequently: true });
    target.save();
    if (round) { target.beginPath(); target.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2); target.clip(); }
    target.imageSmoothingEnabled = false;
    target.drawImage(small, 0, 0, smallW, smallH, x, y, width, height);
    target.restore();
    clearOverlay();
    state.fileSize = 0;
    pushHistory("Pixelado selectivo");
    toast("Pixelado aplicado a la capa activa.");
    renderPixelPreview();
  };

  const sampleRingColor = (imageData, x, y, radius) => {
    const values = [0, 0, 0, 0];
    let count = 0;
    const inner = radius * .72;
    for (let oy = -radius; oy <= radius; oy += Math.max(1, Math.round(radius / 8))) {
      for (let ox = -radius; ox <= radius; ox += Math.max(1, Math.round(radius / 8))) {
        const distance = Math.hypot(ox, oy);
        if (distance < inner || distance > radius) continue;
        const px = clamp(Math.round(x + ox), 0, imageData.width - 1);
        const py = clamp(Math.round(y + oy), 0, imageData.height - 1);
        const index = (py * imageData.width + px) * 4;
        values[0] += imageData.data[index]; values[1] += imageData.data[index + 1]; values[2] += imageData.data[index + 2]; values[3] += imageData.data[index + 3]; count += 1;
      }
    }
    return count ? values.map((value) => value / count) : [0, 0, 0, 255];
  };

  const paintRetouch = (point) => {
    const layer = activeLayer();
    if (!layer || !state.retouch.snapshot) return;
    const ctx = layer.canvas.getContext("2d", { willReadFrequently: true });
    const radius = Number(refs.retouchSize.value) / 2;
    const opacity = Number(refs.retouchOpacity.value) / 100;
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.clip();
    if (state.retouch.mode === "clean") {
      const imageData = state.retouch.snapshot.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, state.width, state.height);
      const color = sampleRingColor(imageData, point.x, point.y, radius * 1.3);
      const gradient = ctx.createRadialGradient(point.x, point.y, 0, point.x, point.y, radius);
      gradient.addColorStop(0, `rgba(${color[0]},${color[1]},${color[2]},1)`);
      gradient.addColorStop(.72, `rgba(${color[0]},${color[1]},${color[2]},.92)`);
      gradient.addColorStop(1, `rgba(${color[0]},${color[1]},${color[2]},0)`);
      ctx.fillStyle = gradient;
      ctx.fillRect(point.x - radius, point.y - radius, radius * 2, radius * 2);
    } else if (state.retouch.sourceOffset) {
      const sx = point.x + state.retouch.sourceOffset.x;
      const sy = point.y + state.retouch.sourceOffset.y;
      if (state.retouch.mode === "heal") ctx.globalAlpha = opacity * .58;
      ctx.drawImage(state.retouch.snapshot, sx - radius, sy - radius, radius * 2, radius * 2, point.x - radius, point.y - radius, radius * 2, radius * 2);
    }
    ctx.restore();
    renderComposite(displayContext, { skipOverlay: true });
  };

  const beginRetouch = (event) => {
    if (state.tool !== "retouch" || event.button !== 0 || state.spacePressed) return;
    event.preventDefault();
    const point = canvasPoint(event);
    if (event.altKey) {
      state.retouch.source = point;
      state.retouch.sourceOffset = null;
      refs.cloneSource.classList.add("ready");
      refs.cloneSource.querySelector("strong").textContent = `Fuente: ${Math.round(point.x)}, ${Math.round(point.y)}`;
      refs.cloneSource.querySelector("small").textContent = "Pinta en otra zona para copiar desde aquí.";
      toast("Fuente de clonado definida.");
      return;
    }
    if (state.retouch.mode !== "clean" && !state.retouch.source) { toast("Usa Alt + clic para definir una fuente.", "error"); return; }
    state.retouch.active = true;
    state.retouch.last = point;
    state.retouch.changed = true;
    state.retouch.snapshot = cloneCanvas(activeLayer().canvas);
    if (state.retouch.source) state.retouch.sourceOffset = { x: state.retouch.source.x - point.x, y: state.retouch.source.y - point.y };
    refs.overlay.setPointerCapture(event.pointerId);
    paintRetouch(point);
  };

  const moveRetouch = (event) => {
    if (!state.retouch.active) return;
    event.preventDefault();
    const point = canvasPoint(event);
    const distance = Math.hypot(point.x - state.retouch.last.x, point.y - state.retouch.last.y);
    const step = Math.max(2, Number(refs.retouchSize.value) * .22);
    const count = Math.max(1, Math.ceil(distance / step));
    for (let index = 1; index <= count; index += 1) {
      paintRetouch({ x: state.retouch.last.x + (point.x - state.retouch.last.x) * index / count, y: state.retouch.last.y + (point.y - state.retouch.last.y) * index / count });
    }
    state.retouch.last = point;
  };

  const endRetouch = (event) => {
    if (!state.retouch.active) return;
    state.retouch.active = false;
    try { refs.overlay.releasePointerCapture(event.pointerId); } catch (_) {}
    if (state.retouch.changed) {
      state.retouch.changed = false;
      const labels = { clone: "Clonado", heal: "Reparación", clean: "Limpieza" };
      pushHistory(labels[state.retouch.mode]);
    }
  };

  const renderCompare = () => {
    clearOverlay();
    if (!state.originalCanvas || (!state.compare.enabled && !state.compare.holding)) return;
    if (state.compare.holding) {
      displayContext.clearRect(0, 0, state.width, state.height);
      displayContext.drawImage(state.originalCanvas, 0, 0, state.width, state.height);
      return;
    }
    renderComposite(displayContext, { skipOverlay: true });
    const boundary = state.width * state.compare.position / 100;
    overlayContext.save();
    overlayContext.beginPath();
    if (!state.compare.flipped) overlayContext.rect(0, 0, boundary, state.height);
    else overlayContext.rect(boundary, 0, state.width - boundary, state.height);
    overlayContext.clip();
    overlayContext.drawImage(state.originalCanvas, 0, 0, state.width, state.height);
    overlayContext.restore();
    overlayContext.save();
    overlayContext.strokeStyle = "#ffffff";
    overlayContext.lineWidth = Math.max(2, 2 / state.zoom);
    overlayContext.shadowColor = "rgba(0,0,0,.65)";
    overlayContext.shadowBlur = 8;
    overlayContext.beginPath(); overlayContext.moveTo(boundary, 0); overlayContext.lineTo(boundary, state.height); overlayContext.stroke();
    overlayContext.fillStyle = "#ffffff";
    overlayContext.beginPath(); overlayContext.arc(boundary, state.height / 2, 10 / state.zoom, 0, Math.PI * 2); overlayContext.fill();
    overlayContext.restore();
  };

  const renderToolOverlay = () => {
    if (!state.loaded || !refs.overlay) return;
    if (state.tool === "filters") renderFilterPreview();
    else if (state.tool === "text") renderTextPreview();
    else if (state.tool === "shapes") renderShapePreview();
    else if (state.tool === "pixelate") renderPixelPreview();
    else if (state.tool === "compare") renderCompare();
    else if (state.tool === "watermark" && state.watermark.preview) renderWatermarkPreview();
    else if (state.tool === "removebg" && state.removebg.mode === "manual") renderManualRemoveCursor();
    else if (state.tool === "removebg" && state.removebg.preview) {
      clearOverlay();
      const layer = activeLayer();
      renderComposite(displayContext, { skipOverlay: true, overrideLayerId: layer?.id, overrideCanvas: state.removebg.preview });
    }
    else if (!["draw", "retouch", "open", "resize"].includes(state.tool)) clearOverlay();
  };


  const readAscii = (view, offset, length) => {
    let text = "";
    for (let index = 0; index < length && offset + index < view.byteLength; index += 1) {
      const value = view.getUint8(offset + index);
      if (!value) break;
      if (value >= 32 && value <= 126) text += String.fromCharCode(value);
    }
    return text.trim();
  };

  const inspectImageMetadata = async (blob, name = "imagen") => {
    const result = { status: "Sin EXIF detectable", fields: { Archivo: name, Tipo: blob.type || "desconocido", Peso: formatBytes(blob.size) }, hasExif: false, hasGps: false };
    if (blob.type !== "image/jpeg") return result;
    try {
      const buffer = await blob.arrayBuffer();
      const view = new DataView(buffer);
      if (view.getUint16(0) !== 0xffd8) return result;
      let offset = 2;
      while (offset + 4 < view.byteLength) {
        if (view.getUint8(offset) !== 0xff) break;
        const marker = view.getUint8(offset + 1);
        const length = view.getUint16(offset + 2);
        if (marker === 0xe1 && readAscii(view, offset + 4, 6) === "Exif") {
          const tiff = offset + 10;
          const little = view.getUint16(tiff) === 0x4949;
          const get16 = (at) => view.getUint16(at, little);
          const get32 = (at) => view.getUint32(at, little);
          const typeSize = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
          const labels = { 0x010f: "Cámara", 0x0110: "Modelo", 0x0131: "Software", 0x0132: "Fecha", 0x013b: "Autor", 0x8298: "Copyright" };
          const readIfd = (relative, depth = 0) => {
            if (!relative || depth > 2 || tiff + relative + 2 > view.byteLength) return;
            const start = tiff + relative;
            const count = Math.min(get16(start), 256);
            for (let index = 0; index < count; index += 1) {
              const entry = start + 2 + index * 12;
              if (entry + 12 > view.byteLength) break;
              const tag = get16(entry); const type = get16(entry + 2); const amount = get32(entry + 4);
              const bytes = (typeSize[type] || 1) * amount;
              const dataAt = bytes <= 4 ? entry + 8 : tiff + get32(entry + 8);
              if (tag === 0x8825) { result.hasGps = true; result.fields.GPS = "Presente"; }
              if (tag === 0x8769 || tag === 0xa005 || tag === 0x8825) readIfd(get32(entry + 8), depth + 1);
              if (labels[tag] && type === 2 && dataAt + amount <= view.byteLength) {
                const value = readAscii(view, dataAt, amount);
                if (value) result.fields[labels[tag]] = value;
              }
            }
          };
          readIfd(get32(tiff + 4));
          result.hasExif = true;
          result.status = result.hasGps ? "EXIF y GPS detectados" : "EXIF detectado";
          break;
        }
        if (length < 2) break;
        offset += 2 + length;
      }
    } catch (error) {
      result.status = "No se pudo analizar";
      console.warn("Metadata inspection failed", error);
    }
    return result;
  };

  const hashBytes = (bytes) => {
    let hashA = 0x811c9dc5; let hashB = 0x9e3779b9;
    for (let index = 0; index < bytes.length; index += 1) {
      hashA ^= bytes[index]; hashA = Math.imul(hashA, 0x01000193) >>> 0;
      hashB ^= (bytes[index] + index) & 255; hashB = Math.imul(hashB, 0x85ebca6b) >>> 0;
    }
    return `${hashA.toString(16).padStart(8, "0")}-${hashB.toString(16).padStart(8, "0")}`;
  };

  const computeCanvasFingerprint = () => {
    if (!state.loaded) return "—";
    const sample = createCanvas(64, 64);
    const context = sample.getContext("2d", { willReadFrequently: true });
    context.drawImage(flattenToCanvas(), 0, 0, 64, 64);
    return hashBytes(context.getImageData(0, 0, 64, 64).data);
  };

  const updatePrivacyUI = () => {
    if (!refs.metadataList) return;
    refs.privacyAuthor.value = state.privacy.author || "";
    refs.privacyCopyright.value = state.privacy.copyright || "";
    refs.privacyProjectOnly.checked = state.privacy.projectOnly !== false;
    const metadata = state.originalMetadata || { fields: {}, status: "Sin analizar" };
    const rows = [
      ["Archivo", `${state.fileName || "—"}`],
      ["Tipo", state.mime || "—"],
      ["Dimensiones", state.loaded ? `${state.width.toLocaleString("es-ES")} × ${state.height.toLocaleString("es-ES")} px` : "—"],
      ["Peso original", formatBytes(state.fileSize)],
      ["EXIF/GPS", metadata.status || "Sin analizar"]
    ];
    Object.entries(metadata.fields || {}).filter(([key]) => !["Archivo", "Tipo", "Peso"].includes(key)).slice(0, 5).forEach(([key, value]) => rows.push([key, String(value)]));
    refs.metadataList.innerHTML = rows.map(([label, value]) => `<div><span>${label}</span><strong>${String(value).replace(/[&<>]/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[char]))}</strong></div>`).join("");
    refs.privacyFingerprint.textContent = computeCanvasFingerprint();
  };

  const downloadBlob = (blob, name) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = safeFileName(name); document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const downloadPrivacyReport = () => {
    const report = {
      schema: "cacatools.images.authorship.v1",
      createdAt: new Date().toISOString(),
      file: { name: state.fileName, mime: state.mime, originalBytes: state.fileSize, width: state.width, height: state.height },
      detectedMetadata: state.originalMetadata,
      authorship: { ...state.privacy },
      canvasFingerprint: computeCanvasFingerprint(),
      exportPolicy: { regeneratedFromCanvas: true, originalExifCopied: false, originalGpsCopied: false },
      disclaimer: "La marca o huella ayuda a documentar autoría, pero no garantiza impedir copias o publicaciones."
    };
    downloadBlob(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }), `${state.fileName}-informe-autoria.json`);
    toast("Informe de privacidad descargado.");
  };

  const watermarkSettings = () => ({
    text: refs.watermarkText.value.trim() || "© Mi autoría",
    font: refs.watermarkFont.value,
    size: clamp(Number(refs.watermarkSize.value) || 48, 8, 600),
    color: refs.watermarkColor.value,
    stroke: refs.watermarkStroke.value,
    opacity: clamp(Number(refs.watermarkOpacity.value) / 100, .05, 1),
    rotation: Number(refs.watermarkRotation.value) * Math.PI / 180,
    position: state.watermark.position,
    tile: refs.watermarkTile.checked,
    fingerprint: refs.watermarkFingerprint.checked
  });

  const positionPoint = (position, margin, textWidth, textHeight) => {
    const columns = { l: margin + textWidth / 2, c: state.width / 2, r: state.width - margin - textWidth / 2 };
    const rows = { t: margin + textHeight / 2, m: state.height / 2, b: state.height - margin - textHeight / 2 };
    return { x: columns[position[1] || "c"], y: rows[position[0] || "m"] };
  };

  const drawFingerprintPattern = (context, seedText) => {
    const seedBytes = new TextEncoder().encode(`${seedText}|${state.width}x${state.height}`);
    let seed = parseInt(hashBytes(seedBytes).replace("-", "").slice(0, 8), 16) >>> 0;
    const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967295; };
    context.save(); context.globalAlpha = .035; context.fillStyle = "#ffffff"; context.globalCompositeOperation = "screen";
    const count = Math.max(80, Math.round(state.width * state.height / 18000));
    for (let index = 0; index < count; index += 1) {
      const x = random() * state.width; const y = random() * state.height; const radius = 0.45 + random() * 1.2;
      context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.fill();
    }
    context.restore();
  };

  const drawWatermark = (context, settings) => {
    context.save();
    context.font = `700 ${settings.size}px ${settings.font}`;
    context.textAlign = "center"; context.textBaseline = "middle";
    const width = context.measureText(settings.text).width;
    const height = settings.size * 1.25;
    const drawAt = (x, y) => {
      context.save(); context.translate(x, y); context.rotate(settings.rotation); context.globalAlpha = settings.opacity;
      context.lineWidth = Math.max(1, settings.size * .045); context.strokeStyle = settings.stroke; context.fillStyle = settings.color;
      context.strokeText(settings.text, 0, 0); context.fillText(settings.text, 0, 0); context.restore();
    };
    if (settings.tile) {
      const stepX = Math.max(width * 1.55, settings.size * 6); const stepY = Math.max(height * 3.2, settings.size * 4);
      for (let y = -stepY; y < state.height + stepY; y += stepY) for (let x = -stepX; x < state.width + stepX; x += stepX) drawAt(x + ((Math.round(y / stepY) % 2) ? stepX / 2 : 0), y);
    } else {
      const point = positionPoint(settings.position, Math.max(24, settings.size * .7), width, height); drawAt(point.x, point.y);
    }
    if (settings.fingerprint) drawFingerprintPattern(context, `${settings.text}|${state.privacy.author}`);
    context.restore();
  };

  const renderWatermarkPreview = () => {
    clearOverlay();
    if (!state.loaded || state.tool !== "watermark") return;
    drawWatermark(overlayContext, watermarkSettings());
  };

  const applyWatermark = () => {
    if (!state.loaded) return;
    const settings = watermarkSettings();
    const layer = makeLayer(settings.fingerprint ? "Marca + huella de autoría" : "Marca de agua");
    drawWatermark(layer.canvas.getContext("2d", { willReadFrequently: true }), settings);
    state.layers.push(layer); state.activeLayerId = layer.id; state.watermark.preview = false;
    pushHistory(settings.fingerprint ? "Marca y huella añadidas" : "Marca de agua añadida");
    updatePrivacyUI();
    toast("Marca añadida como capa independiente.");
  };

  const compressionCanvas = () => {
    const source = flattenToCanvas();
    const maxSide = Number(refs.compressMaxSide.value) || 0;
    const scale = maxSide && Math.max(state.width, state.height) > maxSide ? maxSide / Math.max(state.width, state.height) : 1;
    const canvas = createCanvas(state.width * scale, state.height * scale);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.imageSmoothingEnabled = true; context.imageSmoothingQuality = "high";
    if (refs.compressFormat.value === "image/jpeg") { context.fillStyle = "#ffffff"; context.fillRect(0, 0, canvas.width, canvas.height); }
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas;
  };

  const buildCompressedBlob = async () => {
    const canvas = compressionCanvas();
    const type = refs.compressFormat.value; const quality = Number(refs.compressQuality.value) / 100;
    return { blob: await canvasBlob(canvas, type, quality), width: canvas.width, height: canvas.height };
  };

  const updateCompressionEstimate = () => {
    if (!state.loaded || !refs.compressPreview) return;
    clearTimeout(state.compression.timer);
    state.compression.timer = setTimeout(async () => {
      const token = ++state.compression.token;
      refs.compressQualityField.hidden = refs.compressFormat.value === "image/png";
      refs.compressQualityOutput.textContent = `${refs.compressQuality.value}%`;
      refs.compressStatus.textContent = "Calculando…";
      try {
        const result = await buildCompressedBlob();
        if (token !== state.compression.token) return;
        state.compression.blob = result.blob; state.compression.width = result.width; state.compression.height = result.height;
        const original = state.fileSize || (await canvasBlob(flattenToCanvas(), "image/png")).size;
        refs.compressOriginalSize.textContent = formatBytes(original);
        refs.compressOutputSize.textContent = formatBytes(result.blob.size);
        const saving = original > 0 ? Math.round((1 - result.blob.size / original) * 100) : 0;
        refs.compressSaving.textContent = saving >= 0 ? `${saving}%` : `+${Math.abs(saving)}%`;
        const image = await decodeImage(result.blob); const context = refs.compressPreview.getContext("2d");
        context.clearRect(0, 0, refs.compressPreview.width, refs.compressPreview.height);
        const ratio = Math.min(refs.compressPreview.width / result.width, refs.compressPreview.height / result.height);
        context.drawImage(image, (refs.compressPreview.width - result.width * ratio) / 2, (refs.compressPreview.height - result.height * ratio) / 2, result.width * ratio, result.height * ratio);
        if (typeof image.close === "function") image.close();
        refs.compressStatus.textContent = `${result.width.toLocaleString("es-ES")} × ${result.height.toLocaleString("es-ES")} px · metadatos eliminados`;
      } catch (error) { refs.compressStatus.textContent = "No se pudo calcular"; console.error(error); }
    }, 180);
  };

  const downloadCompressed = async () => {
    const result = state.compression.blob ? { blob: state.compression.blob, width: state.compression.width, height: state.compression.height } : await buildCompressedBlob();
    const type = refs.compressFormat.value; const extension = type === "image/jpeg" ? "jpg" : type.split("/")[1];
    downloadBlob(result.blob, `${state.fileName}-optimizada.${extension}`);
    toast(`Copia optimizada descargada: ${formatBytes(result.blob.size)}.`);
  };

  const drawCanvasCover = (context, source, x, y, width, height, radius = 0) => {
    const ratio = Math.max(width / source.width, height / source.height);
    const drawW = source.width * ratio; const drawH = source.height * ratio;
    context.save(); context.beginPath();
    if (radius > 0 && context.roundRect) context.roundRect(x, y, width, height, radius); else context.rect(x, y, width, height);
    context.clip(); context.drawImage(source, x + (width - drawW) / 2, y + (height - drawH) / 2, drawW, drawH); context.restore();
  };

  const renderCollageItems = async () => {
    if (!refs.collageItems) return;
    const existing = $$(".collage-item:not(.current)", refs.collageItems); existing.forEach((item) => item.remove());
    if (state.loaded) {
      const context = refs.collageCurrentPreview.getContext("2d"); context.clearRect(0, 0, 92, 64); drawCanvasCover(context, flattenToCanvas(), 0, 0, 92, 64, 7);
    }
    for (const item of state.collage.items) {
      const card = document.createElement("div"); card.className = "collage-item";
      const image = document.createElement("img"); image.alt = ""; image.src = item.url;
      const label = document.createElement("span"); label.textContent = item.name;
      const remove = document.createElement("button"); remove.type = "button"; remove.title = "Quitar"; remove.innerHTML = '<svg><use href="#i-close"/></svg>';
      remove.addEventListener("click", () => { URL.revokeObjectURL(item.url); state.collage.items = state.collage.items.filter((entry) => entry.id !== item.id); renderCollageItems(); });
      card.append(image, label, remove); refs.collageItems.append(card);
    }
  };

  const addCollageFiles = async (files) => {
    const available = Math.max(0, 5 - state.collage.items.length);
    for (const file of [...files].filter((item) => item.type.startsWith("image/")).slice(0, available)) {
      state.collage.items.push({ id: uid(), name: file.name, blob: file, url: URL.createObjectURL(file) });
    }
    renderCollageItems();
    if ([...files].length > available) toast("El collage admite hasta seis imágenes en total.");
  };

  const createCollage = async () => {
    if (!state.loaded) return;
    const sources = [flattenToCanvas()];
    for (const item of state.collage.items) {
      const image = await decodeImage(item.blob); const canvas = createCanvas(image.width || image.naturalWidth, image.height || image.naturalHeight); canvas.getContext("2d").drawImage(image, 0, 0); if (typeof image.close === "function") image.close(); sources.push(canvas);
    }
    if (sources.length < 2) { toast("Añade al menos una imagen más para crear el collage.", "error"); return; }
    const width = clamp(Number(refs.collageWidth.value) || 1600, 320, 12000); const ratio = Number(refs.collageRatio.value) || 1.777778;
    const height = Math.round(width / ratio); const gap = clamp(Number(refs.collageGap.value) || 0, 0, 160); const radius = Number(refs.collageRadius.value) || 0;
    const output = createCanvas(width, height); const context = output.getContext("2d", { willReadFrequently: true }); context.fillStyle = refs.collageBackground.value; context.fillRect(0, 0, width, height);
    const innerW = width - gap * 2; const innerH = height - gap * 2; const layout = state.collage.layout;
    if (layout === "columns") {
      const cellW = (innerW - gap * (sources.length - 1)) / sources.length; sources.forEach((source, index) => drawCanvasCover(context, source, gap + index * (cellW + gap), gap, cellW, innerH, radius));
    } else if (layout === "rows") {
      const cellH = (innerH - gap * (sources.length - 1)) / sources.length; sources.forEach((source, index) => drawCanvasCover(context, source, gap, gap + index * (cellH + gap), innerW, cellH, radius));
    } else if (layout === "hero" && sources.length > 1) {
      const heroW = innerW * .64; drawCanvasCover(context, sources[0], gap, gap, heroW, innerH, radius);
      const rest = sources.slice(1); const cellH = (innerH - gap * (rest.length - 1)) / rest.length; rest.forEach((source, index) => drawCanvasCover(context, source, gap + heroW + gap, gap + index * (cellH + gap), innerW - heroW - gap, cellH, radius));
    } else {
      const columns = Math.ceil(Math.sqrt(sources.length)); const rows = Math.ceil(sources.length / columns); const cellW = (innerW - gap * (columns - 1)) / columns; const cellH = (innerH - gap * (rows - 1)) / rows;
      sources.forEach((source, index) => drawCanvasCover(context, source, gap + (index % columns) * (cellW + gap), gap + Math.floor(index / columns) * (cellH + gap), cellW, cellH, radius));
    }
    setDocumentSize(width, height); const layer = makeLayer("Collage", width, height); layer.canvas.getContext("2d").drawImage(output, 0, 0); state.layers = [layer]; state.activeLayerId = layer.id; state.fileName = `${state.fileName}-collage`; state.fileSize = 0; state.mime = "image/png"; state.sourceRatio = width / height; state.originalCanvas = cloneCanvas(output); state.history = []; state.historyIndex = -1; renderComposite(); renderLayersUI(); syncDimensionFields(); pushHistory("Collage creado"); requestAnimationFrame(fitCanvas); toast("Collage creado como nuevo lienzo.");
  };

  const canvasToBlob = async (type, quality) => {
    let source = flattenToCanvas();
    if (type === "image/jpeg") {
      const flattened = createCanvas(state.width, state.height);
      const ctx = flattened.getContext("2d", { willReadFrequently: true });
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, state.width, state.height);
      ctx.drawImage(source, 0, 0);
      source = flattened;
    }
    return canvasBlob(source, type, quality);
  };

  const drawExportPreview = () => {
    const ctx = refs.exportPreview.getContext("2d");
    const source = flattenToCanvas();
    const ratio = Math.min(refs.exportPreview.width / state.width, refs.exportPreview.height / state.height);
    const width = state.width * ratio;
    const height = state.height * ratio;
    ctx.clearRect(0, 0, refs.exportPreview.width, refs.exportPreview.height);
    if (refs.exportFormat.value === "image/jpeg") { ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, refs.exportPreview.width, refs.exportPreview.height); }
    ctx.drawImage(source, (refs.exportPreview.width - width) / 2, (refs.exportPreview.height - height) / 2, width, height);
  };

  const updateExportEstimate = async () => {
    if (!state.loaded) return;
    const token = ++state.exportToken;
    const type = refs.exportFormat.value;
    const quality = Number(refs.exportQuality.value) / 100;
    refs.qualityField.hidden = type === "image/png";
    refs.qualityOutput.textContent = `${refs.exportQuality.value}%`;
    drawExportPreview();
    refs.exportSize.textContent = "Calculando…";
    try {
      const blob = await canvasToBlob(type, quality);
      if (token === state.exportToken) refs.exportSize.textContent = `Aprox. ${formatBytes(blob.size)}`;
    } catch (_) { refs.exportSize.textContent = "Tamaño no disponible"; }
  };

  const openExport = () => {
    if (!state.loaded) return;
    refs.exportName.value = `${state.fileName}-editada`;
    refs.exportFormat.value = state.mime === "image/jpeg" || state.mime === "image/webp" ? state.mime : "image/png";
    refs.exportDimensions.textContent = `${state.width} × ${state.height} px`;
    refs.exportDialog.showModal();
    updateExportEstimate();
  };

  const downloadExport = async () => {
    const type = refs.exportFormat.value;
    const quality = Number(refs.exportQuality.value) / 100;
    const extension = type === "image/jpeg" ? "jpg" : type.split("/")[1];
    const blob = await canvasToBlob(type, quality);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${safeFileName(refs.exportName.value)}.${extension}`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    refs.exportDialog.close();
    toast(`Imagen exportada en ${extension.toUpperCase()}.`);
  };

  const layerThumbnail = (layer, canvas) => {
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const ratio = Math.min(canvas.width / state.width, canvas.height / state.height);
    const width = state.width * ratio;
    const height = state.height * ratio;
    ctx.drawImage(layer.canvas, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
  };

  const renderLayersUI = () => {
    refs.layersList.innerHTML = "";
    refs.layersCount.textContent = `${state.layers.length} ${state.layers.length === 1 ? "capa" : "capas"}`;
    if (!state.layers.length) {
      refs.layersList.innerHTML = '<div class="layers-empty">Abre una imagen para crear la primera capa.</div>';
      refs.layerProperties.hidden = true;
      return;
    }
    [...state.layers].reverse().forEach((layer) => {
      const row = document.createElement("div");
      row.className = "layer-row advanced";
      if (layer.id === state.activeLayerId) row.classList.add("active");
      row.dataset.layerId = layer.id;
      const visibility = document.createElement("button");
      visibility.type = "button";
      visibility.className = "layer-eye";
      visibility.title = layer.visible ? "Ocultar capa" : "Mostrar capa";
      visibility.innerHTML = `<svg><use href="#${layer.visible ? "i-eye" : "i-eye-off"}"/></svg>`;
      visibility.addEventListener("click", (event) => {
        event.stopPropagation();
        layer.visible = !layer.visible;
        renderComposite();
        renderLayersUI();
        pushHistory(layer.visible ? "Capa mostrada" : "Capa oculta");
      });
      const thumb = document.createElement("canvas");
      thumb.width = 48; thumb.height = 48; thumb.className = "layer-thumb-canvas";
      layerThumbnail(layer, thumb);
      const meta = document.createElement("div");
      meta.className = "layer-meta";
      const name = document.createElement("input");
      name.value = layer.name;
      name.maxLength = 80;
      name.addEventListener("click", (event) => event.stopPropagation());
      name.addEventListener("change", () => { layer.name = name.value.trim() || "Capa"; pushHistory("Capa renombrada"); });
      const detail = document.createElement("span");
      detail.textContent = `${Math.round(layer.opacity * 100)}% · ${layer.blendMode === "source-over" ? "Normal" : layer.blendMode}`;
      meta.append(name, detail);
      row.append(visibility, thumb, meta);
      row.addEventListener("click", () => { state.activeLayerId = layer.id; renderLayersUI(); renderToolOverlay(); });
      refs.layersList.append(row);
    });
    const layer = activeLayer();
    refs.layerProperties.hidden = !layer;
    if (layer) {
      refs.layerOpacity.value = Math.round(layer.opacity * 100);
      refs.layerOpacityOutput.textContent = `${Math.round(layer.opacity * 100)}%`;
      refs.layerBlend.value = layer.blendMode;
      const index = state.layers.indexOf(layer);
      refs.layerDown.disabled = index <= 0;
      refs.layerUp.disabled = index >= state.layers.length - 1;
      refs.layerDelete.disabled = state.layers.length <= 1;
    }
  };

  const flattenVisibleLayers = () => {
    const visible = state.layers.filter((layer) => layer.visible);
    if (visible.length <= 1) { toast("No hay varias capas visibles para combinar."); return; }
    const merged = makeLayer("Capas combinadas");
    const ctx = merged.canvas.getContext("2d", { willReadFrequently: true });
    for (const layer of visible) {
      ctx.save();
      ctx.globalAlpha = layer.opacity;
      ctx.globalCompositeOperation = layer.blendMode;
      ctx.drawImage(layer.canvas, 0, 0);
      ctx.restore();
    }
    const firstIndex = Math.min(...visible.map((layer) => state.layers.indexOf(layer)));
    state.layers = state.layers.filter((layer) => !layer.visible);
    state.layers.splice(firstIndex, 0, merged);
    state.activeLayerId = merged.id;
    pushHistory("Capas visibles combinadas");
    toast("Capas visibles combinadas.");
  };

  const duplicateActiveLayer = () => {
    const layer = activeLayer();
    if (!layer) return;
    const duplicate = makeLayer(`${layer.name} copia`);
    duplicate.canvas.getContext("2d", { willReadFrequently: true }).drawImage(layer.canvas, 0, 0);
    duplicate.opacity = layer.opacity;
    duplicate.blendMode = layer.blendMode;
    const index = state.layers.indexOf(layer);
    state.layers.splice(index + 1, 0, duplicate);
    state.activeLayerId = duplicate.id;
    pushHistory("Capa duplicada");
  };

  class StudioStorage {
    constructor() { this.db = null; this.memoryRecent = []; this.memoryProjects = []; }
    async init() {
      if (!("indexedDB" in window)) return;
      try {
        this.db = await new Promise((resolve) => {
          const request = indexedDB.open("cacatools-images-v3", 2);
          request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains("images")) {
              const images = db.createObjectStore("images", { keyPath: "id", autoIncrement: true });
              images.createIndex("createdAt", "createdAt");
            }
            if (!db.objectStoreNames.contains("projects")) {
              const projects = db.createObjectStore("projects", { keyPath: "id" });
              projects.createIndex("updatedAt", "updatedAt");
            }
          };
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(null);
        });
      } catch (_) { this.db = null; }
    }
    async addRecent(blob, name) {
      if (!blob || blob.size > 25 * 1024 * 1024) return;
      const record = { blob, name: name || "imagen", createdAt: Date.now() };
      if (!this.db) { this.memoryRecent.unshift({ ...record, id: uid() }); this.memoryRecent = this.memoryRecent.slice(0, 12); return; }
      await this.put("images", record, "add");
      const all = await this.getRecent();
      if (all.length > 12) await Promise.all(all.slice(12).map((item) => this.delete("images", item.id)));
    }
    async getRecent() {
      if (!this.db) return this.memoryRecent;
      const all = await this.getAll("images");
      return all.sort((a, b) => b.createdAt - a.createdAt);
    }
    async saveProject(project) {
      if (!this.db) {
        const index = this.memoryProjects.findIndex((item) => item.id === project.id);
        if (index >= 0) this.memoryProjects[index] = project; else this.memoryProjects.unshift(project);
        return;
      }
      await this.put("projects", project, "put");
    }
    async getProjects() {
      const all = this.db ? await this.getAll("projects") : this.memoryProjects;
      return all.filter((item) => item.id !== "__session__").sort((a, b) => b.updatedAt - a.updatedAt);
    }
    async getSession() {
      if (!this.db) return this.memoryProjects.find((item) => item.id === "__session__") || null;
      return await new Promise((resolve) => {
        const request = this.db.transaction("projects", "readonly").objectStore("projects").get("__session__");
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => resolve(null);
      });
    }
    async getAll(store) {
      return await new Promise((resolve) => {
        const request = this.db.transaction(store, "readonly").objectStore(store).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => resolve([]);
      });
    }
    async put(store, value, method = "put") {
      return await new Promise((resolve) => {
        const request = this.db.transaction(store, "readwrite").objectStore(store)[method](value);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
      });
    }
    async delete(store, id) {
      if (!this.db) {
        if (store === "images") this.memoryRecent = this.memoryRecent.filter((item) => item.id !== id);
        else this.memoryProjects = this.memoryProjects.filter((item) => item.id !== id);
        return;
      }
      await new Promise((resolve) => {
        const request = this.db.transaction(store, "readwrite").objectStore(store).delete(id);
        request.onsuccess = resolve;
        request.onerror = resolve;
      });
    }
    async clear(store) {
      if (!this.db) {
        if (store === "images") this.memoryRecent = [];
        else this.memoryProjects = this.memoryProjects.filter((item) => item.id === "__session__");
        return;
      }
      if (store === "projects") {
        const session = await this.getSession();
        await new Promise((resolve) => {
          const request = this.db.transaction(store, "readwrite").objectStore(store).clear();
          request.onsuccess = resolve; request.onerror = resolve;
        });
        if (session) await this.saveProject(session);
      } else {
        await new Promise((resolve) => {
          const request = this.db.transaction(store, "readwrite").objectStore(store).clear();
          request.onsuccess = resolve; request.onerror = resolve;
        });
      }
    }
  }

  const storage = new StudioStorage();
  const objectUrls = new Set();
  const clearObjectUrls = () => { objectUrls.forEach(URL.revokeObjectURL); objectUrls.clear(); };

  const serializeProject = async (id, name) => {
    const layers = [];
    for (const layer of state.layers) {
      layers.push({ id: layer.id, name: layer.name, visible: layer.visible, opacity: layer.opacity, blendMode: layer.blendMode, blob: await canvasBlob(layer.canvas, "image/png") });
    }
    const composite = flattenToCanvas();
    const thumb = createCanvas(240, 150);
    const ratio = Math.min(240 / state.width, 150 / state.height);
    const width = state.width * ratio; const height = state.height * ratio;
    const thumbCtx = thumb.getContext("2d");
    thumbCtx.fillStyle = "#111827";
    thumbCtx.fillRect(0, 0, 240, 150);
    thumbCtx.drawImage(composite, (240 - width) / 2, (150 - height) / 2, width, height);
    return { id, name, fileName: state.fileName, mime: state.mime, width: state.width, height: state.height, activeLayerId: state.activeLayerId, layers, privacy: { ...state.privacy }, thumbnail: await canvasBlob(thumb, "image/webp", .78), updatedAt: Date.now() };
  };

  const restoreProject = async (project, announce = true) => {
    try {
      state.restoring = true;
      setDocumentSize(project.width, project.height);
      const layers = [];
      for (const stored of project.layers) {
        const image = await decodeImage(stored.blob);
        const layer = makeLayer(stored.name, project.width, project.height);
        layer.id = stored.id;
        layer.visible = stored.visible;
        layer.opacity = stored.opacity;
        layer.blendMode = stored.blendMode;
        layer.canvas.getContext("2d", { willReadFrequently: true }).drawImage(image, 0, 0, project.width, project.height);
        if (typeof image.close === "function") image.close();
        layers.push(layer);
      }
      state.layers = layers;
      state.activeLayerId = layers.some((layer) => layer.id === project.activeLayerId) ? project.activeLayerId : layers.at(-1)?.id;
      state.fileName = project.fileName || project.name || "proyecto";
      state.mime = project.mime || "image/png";
      state.sourceRatio = state.width / state.height;
      state.activeProjectId = project.id === "__session__" ? null : project.id;
      state.history = [];
      state.historyIndex = -1;
      state.originalCanvas = flattenToCanvas();
      state.originalBlob = null;
      state.originalMetadata = { status: "Proyecto local", fields: {}, hasExif: false, hasGps: false };
      state.privacy = { author: project.privacy?.author || "", copyright: project.privacy?.copyright || "", projectOnly: project.privacy?.projectOnly !== false };
      setLoadedUI(true);
      renderComposite();
      renderLayersUI();
      syncDimensionFields();
      updateCanvasMeta();
      updatePrivacyUI();
      renderCollageItems();
      state.restoring = false;
      pushHistory(project.id === "__session__" ? "Sesión restaurada" : "Proyecto abierto");
      selectTool("open");
      requestAnimationFrame(fitCanvas);
      renderLibrary();
      if (announce) toast(project.id === "__session__" ? "Sesión anterior restaurada." : "Proyecto abierto.");
    } catch (error) {
      state.restoring = false;
      console.error(error);
      toast("No se pudo restaurar el proyecto.", "error");
    }
  };

  const saveProject = async (manual = true) => {
    if (!state.loaded) return;
    const id = manual ? (state.activeProjectId || uid()) : "__session__";
    const name = manual ? `${state.fileName} · proyecto` : "Sesión automática";
    const project = await serializeProject(id, name);
    await storage.saveProject(project);
    if (manual) {
      state.activeProjectId = id;
      state.libraryTab = "projects";
      updateLibraryTabs();
      await renderLibrary();
      toast("Proyecto guardado localmente.");
    }
  };

  const scheduleAutosave = () => {
    if (!state.loaded || state.restoring) return;
    clearTimeout(state.autosaveTimer);
    state.autosaveTimer = setTimeout(() => saveProject(false).catch(() => {}), 900);
  };

  const updateLibraryTabs = () => {
    $$('[data-library-tab]', refs.libraryTabs).forEach((button) => button.classList.toggle("active", button.dataset.libraryTab === state.libraryTab));
    refs.libraryAdd.querySelector("span").textContent = state.libraryTab === "projects" ? "Guardar proyecto" : "Añadir imagen";
  };

  const renderLibrary = async () => {
    clearObjectUrls();
    $$(".library-item, .project-item", refs.libraryStrip).forEach((item) => item.remove());
    if (state.libraryTab === "recent") {
      const images = await storage.getRecent();
      refs.libraryEmpty.hidden = images.length > 0;
      refs.libraryEmpty.textContent = "Todavía no hay imágenes recientes.";
      refs.clearLibrary.disabled = images.length === 0;
      for (const item of images) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "library-item";
        if (item.id === state.activeLibraryId) button.classList.add("active");
        button.title = `Abrir ${item.name}`;
        const image = document.createElement("img");
        const url = URL.createObjectURL(item.blob); objectUrls.add(url); image.src = url; image.alt = "";
        button.append(image);
        button.addEventListener("click", () => loadBlob(item.blob, item.name, { skipLibrary: true, libraryId: item.id }));
        refs.libraryStrip.append(button);
      }
    } else {
      const projects = await storage.getProjects();
      refs.libraryEmpty.hidden = projects.length > 0;
      refs.libraryEmpty.textContent = "Todavía no hay proyectos guardados.";
      refs.clearLibrary.disabled = projects.length === 0;
      for (const project of projects) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "project-item";
        if (project.id === state.activeProjectId) button.classList.add("active");
        const image = document.createElement("img");
        const url = URL.createObjectURL(project.thumbnail); objectUrls.add(url); image.src = url; image.alt = "";
        const meta = document.createElement("span");
        meta.innerHTML = `<strong>${project.name}</strong><small>${project.width} × ${project.height} · ${project.layers.length} capas</small>`;
        button.append(image, meta);
        button.addEventListener("click", () => restoreProject(project));
        refs.libraryStrip.append(button);
      }
    }
  };

  const bindCropDragging = () => {
    let operation = null;
    refs.cropOverlay.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const handle = event.target.closest("[data-handle]")?.dataset.handle || "move";
      operation = { handle, startX: event.clientX, startY: event.clientY, crop: { ...state.crop } };
      refs.cropOverlay.setPointerCapture(event.pointerId);
    });
    refs.cropOverlay.addEventListener("pointermove", (event) => {
      if (!operation) return;
      const dx = (event.clientX - operation.startX) / state.zoom;
      const dy = (event.clientY - operation.startY) / state.zoom;
      const start = operation.crop;
      let { x, y, width, height } = start;
      if (operation.handle === "move") { x += dx; y += dy; }
      else {
        if (operation.handle.includes("e")) width += dx;
        if (operation.handle.includes("s")) height += dy;
        if (operation.handle.includes("w")) { x += dx; width -= dx; }
        if (operation.handle.includes("n")) { y += dy; height -= dy; }
      }
      if (width < 8) { if (operation.handle.includes("w")) x -= 8 - width; width = 8; }
      if (height < 8) { if (operation.handle.includes("n")) y -= 8 - height; height = 8; }
      if (x < 0) { if (operation.handle !== "move") width += x; x = 0; }
      if (y < 0) { if (operation.handle !== "move") height += y; y = 0; }
      if (x + width > state.width) { if (operation.handle === "move") x = state.width - width; else width = state.width - x; }
      if (y + height > state.height) { if (operation.handle === "move") y = state.height - height; else height = state.height - y; }
      state.crop = { ...state.crop, x, y, width, height };
      normalizeCrop(); syncCropInputs(); renderCropOverlay();
    });
    const stop = (event) => { if (operation) { try { refs.cropOverlay.releasePointerCapture(event.pointerId); } catch (_) {} operation = null; } };
    refs.cropOverlay.addEventListener("pointerup", stop);
    refs.cropOverlay.addEventListener("pointercancel", stop);
  };

  const bindPanning = () => {
    let origin = null;
    refs.viewport.addEventListener("pointerdown", (event) => {
      if (!(state.spacePressed || event.button === 1) || !state.loaded) return;
      event.preventDefault();
      state.panning = true;
      refs.viewport.classList.add("panning");
      origin = { x: event.clientX, y: event.clientY, left: refs.viewport.scrollLeft, top: refs.viewport.scrollTop };
      refs.viewport.setPointerCapture(event.pointerId);
    });
    refs.viewport.addEventListener("pointermove", (event) => {
      if (!state.panning || !origin) return;
      refs.viewport.scrollLeft = origin.left - (event.clientX - origin.x);
      refs.viewport.scrollTop = origin.top - (event.clientY - origin.y);
    });
    const stop = (event) => {
      if (!state.panning) return;
      state.panning = false; origin = null; refs.viewport.classList.remove("panning");
      try { refs.viewport.releasePointerCapture(event.pointerId); } catch (_) {}
    };
    refs.viewport.addEventListener("pointerup", stop);
    refs.viewport.addEventListener("pointercancel", stop);
  };

  const openFilePicker = () => refs.fileInput.click();

  const bindEvents = () => {
    [refs.openButton, refs.emptyOpen, refs.panelOpen].forEach((button) => button.addEventListener("click", openFilePicker));
    refs.libraryAdd.addEventListener("click", () => state.libraryTab === "projects" ? saveProject(true) : openFilePicker());
    refs.fileInput.addEventListener("change", () => { const file = refs.fileInput.files?.[0]; if (file) loadBlob(file, file.name); refs.fileInput.value = ""; });
    refs.layerFileInput.addEventListener("change", () => { const file = refs.layerFileInput.files?.[0]; if (file) addImageLayer(file, file.name); refs.layerFileInput.value = ""; });
    $$('.tool-button[data-tool]').forEach((button) => button.addEventListener("click", () => selectTool(button.dataset.tool)));
    refs.undo.addEventListener("click", undo);
    refs.redo.addEventListener("click", redo);
    refs.saveProject.addEventListener("click", () => saveProject(true));
    refs.zoomOut.addEventListener("click", () => setZoom(state.zoom / 1.2));
    refs.zoomIn.addEventListener("click", () => setZoom(state.zoom * 1.2));
    refs.zoomValue.addEventListener("click", () => setZoom(1));
    refs.fit.addEventListener("click", fitCanvas);
    refs.actual.addEventListener("click", () => setZoom(1));
    refs.viewport.addEventListener("wheel", (event) => {
      if (!state.loaded) return;
      if (state.tool === "resize") {
        event.preventDefault();
        const factor = event.deltaY < 0 ? 1.04 : .96;
        const nextW = clamp(Math.round((Number(refs.resizeW.value) || state.width) * factor), 1, 20000);
        refs.resizeW.value = nextW;
        if (state.ratioLocked) refs.resizeH.value = Math.max(1, Math.round(nextW / state.sourceRatio));
        refs.resizeResult.textContent = `${Number(refs.resizeW.value).toLocaleString("es-ES")} × ${Number(refs.resizeH.value).toLocaleString("es-ES")} px`;
        updateResizePreviewFromFields();
        return;
      }
      if (state.tool === "crop" && !event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setZoom(state.zoom * (event.deltaY < 0 ? 1.12 : .89));
    }, { passive: false });

    $$("#aspect-options button").forEach((button) => button.addEventListener("click", () => {
      $$("#aspect-options button").forEach((item) => item.classList.toggle("active", item === button));
      state.crop.aspect = button.dataset.aspect === "free" ? null : Number(button.dataset.aspect);
      if (state.crop.aspect) applyCropAspect(state.crop.aspect);
    }));
    [refs.cropX, refs.cropY, refs.cropW, refs.cropH].forEach((input) => input.addEventListener("input", () => {
      state.crop.x = Number(refs.cropX.value); state.crop.y = Number(refs.cropY.value); state.crop.width = Number(refs.cropW.value); state.crop.height = Number(refs.cropH.value);
      normalizeCrop(); renderCropOverlay();
    }));
    refs.cropReset.addEventListener("click", resetCropSelection);
    refs.cropApply.addEventListener("click", applyCrop);

    refs.ratioLock.addEventListener("click", () => {
      state.ratioLocked = !state.ratioLocked;
      refs.ratioLock.classList.toggle("active", state.ratioLocked);
      refs.ratioLock.setAttribute("aria-pressed", String(state.ratioLocked));
    });
    refs.resizeW.addEventListener("input", () => { if (state.ratioLocked) refs.resizeH.value = Math.max(1, Math.round(Number(refs.resizeW.value) / state.sourceRatio)); refs.resizeResult.textContent = `${Number(refs.resizeW.value).toLocaleString("es-ES")} × ${Number(refs.resizeH.value).toLocaleString("es-ES")} px`; updateResizePreviewFromFields(); });
    refs.resizeH.addEventListener("input", () => { if (state.ratioLocked) refs.resizeW.value = Math.max(1, Math.round(Number(refs.resizeH.value) * state.sourceRatio)); refs.resizeResult.textContent = `${Number(refs.resizeW.value).toLocaleString("es-ES")} × ${Number(refs.resizeH.value).toLocaleString("es-ES")} px`; updateResizePreviewFromFields(); });
    $$('[data-scale]').forEach((button) => button.addEventListener("click", () => { const scale = Number(button.dataset.scale); refs.resizeW.value = Math.max(1, Math.round(state.width * scale)); refs.resizeH.value = Math.max(1, Math.round(state.height * scale)); refs.resizeResult.textContent = `${refs.resizeW.value} × ${refs.resizeH.value} px`; updateResizePreviewFromFields(); }));
    refs.resizeApply.addEventListener("click", applyResize);
    $$('[data-rotate]').forEach((button) => button.addEventListener("click", () => rotateCanvas(Number(button.dataset.rotate))));
    $$('[data-flip]').forEach((button) => button.addEventListener("click", () => flipCanvas(button.dataset.flip)));

    ["brightness", "contrast", "saturation", "blur"].forEach((key) => refs[key].addEventListener("input", () => {
      state.adjustmentValues[key] = Number(refs[key].value);
      $(`#${key}-output`).textContent = key === "blur" ? `${refs[key].value} px` : refs[key].value;
      previewAdjustments();
    }));
    refs.adjustReset.addEventListener("click", () => resetAdjustments(true));
    refs.adjustApply.addEventListener("click", applyAdjustments);

    $$("#filter-grid button").forEach((button) => button.addEventListener("click", () => {
      state.filter.name = button.dataset.filter;
      $$("#filter-grid button").forEach((item) => item.classList.toggle("active", item === button));
      renderFilterPreview();
    }));
    refs.filterIntensity.addEventListener("input", () => { state.filter.intensity = Number(refs.filterIntensity.value); refs.filterIntensityOutput.textContent = `${refs.filterIntensity.value}%`; renderFilterPreview(); });
    refs.filterReset.addEventListener("click", () => resetFilter(true));
    refs.filterApply.addEventListener("click", applyFilter);

    [refs.textContent, refs.textFont, refs.textSize, refs.textColor, refs.textStrokeColor, refs.textX, refs.textY, refs.textStrokeWidth, refs.textOpacity].forEach((input) => input.addEventListener("input", renderTextPreview));
    $$("#text-style-options button").forEach((button) => button.addEventListener("click", () => { state.text.style = button.dataset.textStyle; $$("#text-style-options button").forEach((item) => item.classList.toggle("active", item === button)); renderTextPreview(); }));
    $$("#text-align-options button").forEach((button) => button.addEventListener("click", () => { state.text.align = button.dataset.textAlign; $$("#text-align-options button").forEach((item) => item.classList.toggle("active", item === button)); renderTextPreview(); }));
    refs.textCenter.addEventListener("click", () => { refs.textX.value = Math.round(state.width / 2); refs.textY.value = Math.round(state.height / 2 - Number(refs.textSize.value) / 2); state.text.align = "center"; $$("#text-align-options button").forEach((button) => button.classList.toggle("active", button.dataset.textAlign === "center")); renderTextPreview(); });
    refs.textApply.addEventListener("click", applyText);

    $$("#shape-types button").forEach((button) => button.addEventListener("click", () => { state.shape.type = button.dataset.shape; $$("#shape-types button").forEach((item) => item.classList.toggle("active", item === button)); renderShapePreview(); }));
    [refs.shapeFill, refs.shapeStroke, refs.shapeStrokeWidth, refs.shapeOpacity, refs.shapeFillEnabled, refs.shapeX, refs.shapeY, refs.shapeW, refs.shapeH].forEach((input) => input.addEventListener("input", renderShapePreview));
    refs.shapeApply.addEventListener("click", applyShape);

    $$("#draw-modes button").forEach((button) => button.addEventListener("click", () => { state.draw.mode = button.dataset.drawMode; $$("#draw-modes button").forEach((item) => item.classList.toggle("active", item === button)); }));
    refs.drawSize.addEventListener("input", () => { refs.drawSizeOutput.textContent = `${refs.drawSize.value} px`; });
    refs.drawOpacity.addEventListener("input", () => { refs.drawOpacityOutput.textContent = `${refs.drawOpacity.value}%`; });

    refs.backgroundColor.addEventListener("input", updateBackgroundPreview);
    $$('[data-bg]').forEach((button) => button.addEventListener("click", () => { refs.backgroundColor.value = button.dataset.bg; updateBackgroundPreview(); }));
    refs.backgroundApply.addEventListener("click", applyBackground);

    $$('[data-remove-mode]').forEach((button) => button.addEventListener("click", () => {
      state.removebg.mode = button.dataset.removeMode;
      $$('[data-remove-mode]').forEach((item) => item.classList.toggle("active", item === button));
      if (state.removebg.mode === "auto" || state.removebg.mode === "edges") detectBackgroundSample();
    }));
    refs.removeTolerance.addEventListener("input", () => { refs.removeToleranceOutput.textContent = refs.removeTolerance.value; state.removebg.preview = null; renderComposite(); clearOverlay(); });
    refs.removeFeather.addEventListener("input", () => { refs.removeFeatherOutput.textContent = refs.removeFeather.value; state.removebg.preview = null; renderComposite(); clearOverlay(); });
    refs.removePreview.addEventListener("click", () => processRemoveBackground(false));
    refs.removeApply.addEventListener("click", () => processRemoveBackground(true));

    $$('[data-retouch-mode]').forEach((button) => button.addEventListener("click", () => {
      state.retouch.mode = button.dataset.retouchMode;
      $$('[data-retouch-mode]').forEach((item) => item.classList.toggle("active", item === button));
    }));
    refs.retouchSize.addEventListener("input", () => { refs.retouchSizeOutput.textContent = `${refs.retouchSize.value} px`; });
    refs.retouchOpacity.addEventListener("input", () => { refs.retouchOpacityOutput.textContent = `${refs.retouchOpacity.value}%`; });

    [refs.pixelX, refs.pixelY, refs.pixelW, refs.pixelH, refs.pixelSize, refs.pixelRound].forEach((input) => input.addEventListener("input", () => { refs.pixelSizeOutput.textContent = `${refs.pixelSize.value} px`; renderPixelPreview(); }));
    refs.pixelFull.addEventListener("click", () => { refs.pixelX.value = 0; refs.pixelY.value = 0; refs.pixelW.value = state.width; refs.pixelH.value = state.height; renderPixelPreview(); });
    refs.pixelApply.addEventListener("click", applyPixelate);

    refs.comparePosition.addEventListener("input", () => { state.compare.position = Number(refs.comparePosition.value); refs.comparePositionOutput.textContent = `${refs.comparePosition.value}%`; renderCompare(); });
    refs.compareEnabled.addEventListener("change", () => { state.compare.enabled = refs.compareEnabled.checked; renderCompare(); });
    refs.compareSwap.addEventListener("click", () => { state.compare.flipped = !state.compare.flipped; renderCompare(); });
    const beginHold = (event) => { if (!state.loaded) return; event.preventDefault(); state.compare.holding = true; renderCompare(); };
    const endHold = () => { if (!state.compare.holding) return; state.compare.holding = false; renderComposite(); };
    refs.compareHold.addEventListener("pointerdown", beginHold);
    refs.compareHold.addEventListener("pointerup", endHold);
    refs.compareHold.addEventListener("pointercancel", endHold);
    refs.compareHold.addEventListener("pointerleave", endHold);

    refs.addLayer.addEventListener("click", () => refs.layerFileInput.click());
    refs.flattenLayers.addEventListener("click", flattenVisibleLayers);
    refs.layerOpacity.addEventListener("input", () => {
      const layer = activeLayer(); if (!layer) return;
      layer.opacity = Number(refs.layerOpacity.value) / 100;
      refs.layerOpacityOutput.textContent = `${refs.layerOpacity.value}%`;
      renderComposite(); renderLayersUI();
    });
    refs.layerOpacity.addEventListener("change", () => pushHistory("Opacidad de capa"));
    refs.layerBlend.addEventListener("change", () => { const layer = activeLayer(); if (!layer) return; layer.blendMode = refs.layerBlend.value; pushHistory("Fusión de capa"); });
    refs.layerUp.addEventListener("click", () => { const layer = activeLayer(); const index = state.layers.indexOf(layer); if (index < state.layers.length - 1) { state.layers.splice(index, 1); state.layers.splice(index + 1, 0, layer); pushHistory("Capa subida"); } });
    refs.layerDown.addEventListener("click", () => { const layer = activeLayer(); const index = state.layers.indexOf(layer); if (index > 0) { state.layers.splice(index, 1); state.layers.splice(index - 1, 0, layer); pushHistory("Capa bajada"); } });
    refs.layerDuplicate.addEventListener("click", duplicateActiveLayer);
    refs.layerDelete.addEventListener("click", () => { const layer = activeLayer(); if (!layer || state.layers.length <= 1) return; state.layers = state.layers.filter((item) => item.id !== layer.id); state.activeLayerId = state.layers.at(-1).id; pushHistory("Capa eliminada"); });

    refs.overlay.addEventListener("pointerdown", (event) => {
      if (state.tool === "draw") { beginDraw(event); return; }
      if (state.tool === "retouch") { beginRetouch(event); return; }
      if (state.tool === "removebg" && state.removebg.mode === "manual") { beginManualRemove(event); return; }
      if (event.button !== 0 || state.spacePressed) return;
      const point = canvasPoint(event);
      if (state.tool === "open") {
        event.preventDefault();
        refs.stage.classList.add("dragging");
        state.direct.openPan = { x: event.clientX, y: event.clientY, left: refs.viewport.scrollLeft, top: refs.viewport.scrollTop };
        refs.overlay.setPointerCapture(event.pointerId);
      } else if (state.tool === "text") {
        refs.textX.value = Math.round(point.x); refs.textY.value = Math.round(point.y); renderTextPreview();
      } else if (state.tool === "shapes") {
        event.preventDefault();
        state.shape.dragging = point;
        refs.shapeX.value = Math.round(point.x); refs.shapeY.value = Math.round(point.y); refs.shapeW.value = 1; refs.shapeH.value = 1;
        refs.overlay.setPointerCapture(event.pointerId); renderShapePreview();
      } else if (state.tool === "pixelate") {
        event.preventDefault();
        state.pixel.dragging = point;
        refs.pixelX.value = Math.round(point.x); refs.pixelY.value = Math.round(point.y); refs.pixelW.value = 1; refs.pixelH.value = 1;
        refs.overlay.setPointerCapture(event.pointerId); renderPixelPreview();
      } else if (state.tool === "removebg" && state.removebg.mode === "sample") {
        const layer = activeLayer();
        const pixel = layer.canvas.getContext("2d", { willReadFrequently: true }).getImageData(clamp(Math.floor(point.x), 0, state.width - 1), clamp(Math.floor(point.y), 0, state.height - 1), 1, 1).data;
        setRemoveSample([pixel[0], pixel[1], pixel[2]], `Muestreado en ${Math.round(point.x)}, ${Math.round(point.y)}`);
        state.removebg.preview = null;
        renderComposite();
        clearOverlay();
      }
    });
    refs.overlay.addEventListener("pointermove", (event) => {
      if (state.tool === "draw") { moveDraw(event); return; }
      if (state.tool === "retouch") { moveRetouch(event); return; }
      if (state.tool === "removebg" && state.removebg.mode === "manual") { moveManualRemove(event); return; }
      if (state.tool === "open" && state.direct.openPan) {
        event.preventDefault();
        refs.viewport.scrollLeft = state.direct.openPan.left - (event.clientX - state.direct.openPan.x);
        refs.viewport.scrollTop = state.direct.openPan.top - (event.clientY - state.direct.openPan.y);
        return;
      }
      if (state.tool === "shapes" && state.shape.dragging) {
        event.preventDefault();
        const point = canvasPoint(event); const start = state.shape.dragging;
        refs.shapeX.value = Math.round(Math.min(start.x, point.x)); refs.shapeY.value = Math.round(Math.min(start.y, point.y));
        refs.shapeW.value = Math.max(1, Math.round(Math.abs(point.x - start.x))); refs.shapeH.value = Math.max(1, Math.round(Math.abs(point.y - start.y)));
        renderShapePreview();
      } else if (state.tool === "pixelate" && state.pixel.dragging) {
        event.preventDefault();
        const point = canvasPoint(event); const start = state.pixel.dragging;
        refs.pixelX.value = Math.round(Math.min(start.x, point.x)); refs.pixelY.value = Math.round(Math.min(start.y, point.y));
        refs.pixelW.value = Math.max(1, Math.round(Math.abs(point.x - start.x))); refs.pixelH.value = Math.max(1, Math.round(Math.abs(point.y - start.y)));
        renderPixelPreview();
      }
    });
    const finishOverlayPointer = (event) => {
      if (state.tool === "draw") { endDraw(event); return; }
      if (state.tool === "retouch") { endRetouch(event); return; }
      if (state.tool === "removebg" && state.removebg.mode === "manual") { endManualRemove(event); return; }
      if (state.direct.openPan) { state.direct.openPan = null; refs.stage.classList.remove("dragging"); try { refs.overlay.releasePointerCapture(event.pointerId); } catch (_) {} }
      if (state.shape.dragging) { state.shape.dragging = null; try { refs.overlay.releasePointerCapture(event.pointerId); } catch (_) {} }
      if (state.pixel.dragging) { state.pixel.dragging = null; try { refs.overlay.releasePointerCapture(event.pointerId); } catch (_) {} }
    };
    refs.overlay.addEventListener("pointerup", finishOverlayPointer);
    refs.overlay.addEventListener("pointercancel", finishOverlayPointer);

    refs.themeToggle.addEventListener("click", () => {
      const theme = document.documentElement.dataset.theme === "light" ? "dark" : "light";
      setTheme(theme, true);
      if (window.parent !== window) window.parent.postMessage({ type: "cacatools:theme-request", theme }, "*");
    });

    [refs.watermarkText, refs.watermarkFont, refs.watermarkSize, refs.watermarkColor, refs.watermarkStroke, refs.watermarkOpacity, refs.watermarkRotation, refs.watermarkTile, refs.watermarkFingerprint].forEach((input) => input.addEventListener("input", () => {
      refs.watermarkOpacityOutput.textContent = `${refs.watermarkOpacity.value}%`;
      refs.watermarkRotationOutput.textContent = `${Number(refs.watermarkRotation.value) < 0 ? "−" : ""}${Math.abs(Number(refs.watermarkRotation.value))}°`;
      state.watermark.preview = true; renderWatermarkPreview();
    }));
    $$('[data-position]', refs.watermarkPosition).forEach((button) => button.addEventListener("click", () => { state.watermark.position = button.dataset.position; $$('[data-position]', refs.watermarkPosition).forEach((item) => item.classList.toggle("active", item === button)); state.watermark.preview = true; renderWatermarkPreview(); }));
    refs.watermarkPreviewButton.addEventListener("click", () => { state.watermark.preview = !state.watermark.preview; renderToolOverlay(); refs.watermarkPreviewButton.textContent = state.watermark.preview ? "Ocultar vista" : "Previsualizar"; });
    refs.watermarkApply.addEventListener("click", applyWatermark);

    [refs.compressFormat, refs.compressQuality, refs.compressMaxSide].forEach((input) => input.addEventListener("input", updateCompressionEstimate));
    refs.compressDownload.addEventListener("click", () => downloadCompressed().catch((error) => toast(error.message, "error")));

    [refs.privacyAuthor, refs.privacyCopyright, refs.privacyProjectOnly].forEach((input) => input.addEventListener("input", () => { state.privacy.author = refs.privacyAuthor.value.trim(); state.privacy.copyright = refs.privacyCopyright.value.trim(); state.privacy.projectOnly = refs.privacyProjectOnly.checked; scheduleAutosave(); }));
    refs.privacyRefresh.addEventListener("click", () => { updatePrivacyUI(); toast("Información actualizada."); });
    refs.privacyReport.addEventListener("click", downloadPrivacyReport);

    refs.collageAdd.addEventListener("click", () => refs.collageFileInput.click());
    refs.collageFileInput.addEventListener("change", () => { addCollageFiles(refs.collageFileInput.files); refs.collageFileInput.value = ""; });
    $$('[data-layout]', refs.collageLayouts).forEach((button) => button.addEventListener("click", () => { state.collage.layout = button.dataset.layout; $$('[data-layout]', refs.collageLayouts).forEach((item) => item.classList.toggle("active", item === button)); }));
    refs.collageRadius.addEventListener("input", () => { refs.collageRadiusOutput.textContent = `${refs.collageRadius.value} px`; });
    refs.collageCreate.addEventListener("click", () => createCollage().catch((error) => toast(error.message, "error")));

    refs.exportButton.addEventListener("click", openExport);
    refs.exportClose.addEventListener("click", () => refs.exportDialog.close());
    refs.exportCancel.addEventListener("click", () => refs.exportDialog.close());
    refs.exportFormat.addEventListener("change", updateExportEstimate);
    refs.exportQuality.addEventListener("input", updateExportEstimate);
    refs.exportForm.addEventListener("submit", (event) => { event.preventDefault(); downloadExport().catch((error) => toast(error.message, "error")); });

    $$('[data-library-tab]', refs.libraryTabs).forEach((button) => button.addEventListener("click", () => { state.libraryTab = button.dataset.libraryTab; updateLibraryTabs(); renderLibrary(); }));
    refs.clearLibrary.addEventListener("click", async () => {
      const label = state.libraryTab === "recent" ? "imágenes recientes" : "proyectos guardados";
      if (!confirm(`¿Vaciar ${label}?`)) return;
      await storage.clear(state.libraryTab === "recent" ? "images" : "projects");
      if (state.libraryTab === "recent") state.activeLibraryId = null; else state.activeProjectId = null;
      renderLibrary();
      toast("Biblioteca local vaciada.");
    });

    window.addEventListener("dragenter", (event) => { if ([...event.dataTransfer.types].includes("Files")) { event.preventDefault(); state.dragDepth += 1; refs.dropCurtain.hidden = false; } });
    window.addEventListener("dragover", (event) => { if ([...event.dataTransfer.types].includes("Files")) event.preventDefault(); });
    window.addEventListener("dragleave", () => { state.dragDepth = Math.max(0, state.dragDepth - 1); if (!state.dragDepth) refs.dropCurtain.hidden = true; });
    window.addEventListener("drop", (event) => {
      event.preventDefault(); state.dragDepth = 0; refs.dropCurtain.hidden = true;
      const file = [...event.dataTransfer.files].find((item) => item.type.startsWith("image/"));
      if (!file) { toast("No se encontró una imagen compatible.", "error"); return; }
      if (state.loaded && event.shiftKey) addImageLayer(file, file.name); else loadBlob(file, file.name);
    });
    window.addEventListener("paste", (event) => {
      const item = [...event.clipboardData.items].find((entry) => entry.type.startsWith("image/"));
      const blob = item?.getAsFile();
      if (blob) state.loaded && event.shiftKey ? addImageLayer(blob, `capa-pegada-${Date.now()}.png`) : loadBlob(blob, `imagen-pegada-${Date.now()}.png`);
    });
    window.addEventListener("keydown", (event) => {
      const editable = /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || "");
      if (event.code === "Space" && !editable) { state.spacePressed = true; event.preventDefault(); }
      if (!event.ctrlKey && !event.metaKey) return;
      const key = event.key.toLowerCase();
      if (key === "o") { event.preventDefault(); openFilePicker(); }
      if (key === "z" && !event.shiftKey) { event.preventDefault(); undo(); }
      if (key === "y" || (key === "z" && event.shiftKey)) { event.preventDefault(); redo(); }
      if (key === "s" && state.loaded) { event.preventDefault(); event.shiftKey ? saveProject(true) : openExport(); }
    });
    window.addEventListener("keyup", (event) => { if (event.code === "Space") state.spacePressed = false; });
    window.addEventListener("resize", () => { if (state.loaded && state.zoom < 1) updateStageSize(); });
    window.addEventListener("message", (event) => {
      if (event.data?.type === "cacatools:theme") setTheme(event.data.theme);
      if (event.data?.type === "cacatools:appearance") {
        setTheme(event.data.theme || "dark");
        const uiScale = Math.max(.5, Math.min(1.3, Number(event.data.scale || 100) / 100));
        const textScale = Math.max(.8, Math.min(1.2, Number(event.data.textScale || 100) / 100));
        document.documentElement.style.setProperty("--module-ui-scale", String(uiScale));
        document.documentElement.style.setProperty("--module-text-scale", String(textScale));
        document.documentElement.style.fontSize = `${(16 * uiScale).toFixed(2)}px`;
        if (/^#[0-9a-f]{6}$/i.test(event.data.accent || "")) {
          document.documentElement.style.setProperty("--accent", event.data.accent);
          document.documentElement.style.setProperty("--accent-strong", event.data.accent);
          document.documentElement.style.setProperty("--accent-soft", `${event.data.accent}26`);
          document.documentElement.style.setProperty("--accent-border", `${event.data.accent}73`);
        }
      }
      if (event.data?.type === "cacatools:open-image" && event.data.blob instanceof Blob) loadBlob(event.data.blob, event.data.name || "imagen");
    });
    window.addEventListener("beforeunload", clearObjectUrls);
  };

  const init = async () => {
    detectIntegration();
    bindEvents();
    bindCropDragging();
    bindPanning();
    await storage.init();
    updateLibraryTabs();
    await renderLibrary();
    updateHistoryUI();
    updateCanvasMeta();
    updateBackgroundPreview();
    const session = await storage.getSession();
    if (session?.layers?.length) await restoreProject(session, true);
    const requestedTool = new URLSearchParams(location.search).get("tool");
    if (requestedTool && (state.loaded || requestedTool === "collage")) selectTool(requestedTool);
    window.CacaToolsImagesV3 = {
      version: "3.6.0-phase6",
      getState: () => ({ loaded: state.loaded, width: state.width, height: state.height, historyIndex: state.historyIndex, historyLength: state.history.length, tool: state.tool, filter: state.filter.name, drawMode: state.draw.mode, layers: state.layers.length, activeLayer: activeLayer()?.name || null, projectId: state.activeProjectId }),
      loadBlob,
      addImageLayer,
      undo,
      redo,
      applyFilter,
      applyText,
      applyShape,
      applyBackground,
      applyPixelate,
      removeBackground: () => processRemoveBackground(true),
      applyWatermark,
      createCollage,
      updatePrivacyUI,
      saveProject: () => saveProject(true),
      flattenVisibleLayers,
      compressedBlob: buildCompressedBlob,
      exportBlob: async (type = "image/png", quality = .92) => canvasToBlob(type, quality)
    };
  };

  init().catch((error) => { console.error(error); toast("No se pudo iniciar el editor.", "error"); });
})();
