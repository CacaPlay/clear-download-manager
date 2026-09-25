export function publicUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

// App 0.45.3 flattens mediaUrl/canonicalUrl/pageUrl/url/sourceUrl as separate downloads.
// Keep one download identity per item on the wire; provenance uses a separate field.
export function prepareSelection(items) {
  const selected = (Array.isArray(items) ? items : []).filter(i => i && i.selected !== false);
  if (selected.length > 100) throw new Error('Selecciona como máximo 100 elementos por envío.');
  const seen = new Set();
  return selected.flatMap(item => {
    const source = [item.mediaUrl,item.canonicalUrl,item.url,item.sourceUrl,item.pageUrl].map(publicUrl).find(Boolean);
    if (!source) return [];
    const type = ['video','playlist','audio','direct_file','generic_url'].includes(item.type) ? item.type : 'generic_url';
    const identity = `${type}|${source}`;
    if (seen.has(identity)) return [];
    seen.add(identity);
    return [{
      ...item, type,
      originPageUrl: publicUrl(item.pageUrl),
      sourceUrl: source, url: source, mediaUrl: source, canonicalUrl: source, pageUrl: source
    }];
  });
}
