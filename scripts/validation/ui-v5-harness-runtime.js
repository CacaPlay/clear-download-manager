(() => {
  const params = new URLSearchParams(location.search);
  const kind = params.get('kind') || 'multimedia';
  const theme = params.get('theme') === 'light' ? 'light' : 'dark';
  const accent = params.get('accent') ? `#${params.get('accent')}` : '#59d37b';
  const itemCount = Math.max(1, Math.min(150, Number(params.get('items') || 8)));
  const thumbnail = 'https://i.ytimg.com/vi/8nKJCNgiVhc/hqdefault.jpg';
  const titles = ['JESSE & JOY - ¡Corre! (Video Oficial)', 'Ricardo Arjona - Fuiste tú feat. Gaby Moreno', 'JESSE & JOY - La De La Mala Suerte', 'Camila - De Que Me Sirve la Vida', 'Camila - Mientes (Video)', 'Reik - Creo en Ti', 'Pablo Alborán - Solamente Tú', 'Romeo Santos - Rival (Official Video)'];
  const creators = ['jesseyjoyoficial', 'Ricardo Arjona', 'jesseyjoyoficial', 'Camila', 'Camila', 'Reik', 'Pablo Alborán', 'Romeo Santos'];
  const durations = ['5:55', '4:56', '4:17', '5:51', '3:43', '2:51', '4:18', '4:38'];
  const items = Array.from({length: itemCount}, (_, index) => ({
    title: titles[index % titles.length],
    source_id: `fixture-${index + 1}`, source_url: `https://youtu.be/fixture-${index + 1}`,
    selected_source_url: `https://youtu.be/fixture-${index + 1}`, creator: creators[index % creators.length],
    duration_label: durations[index % durations.length], thumbnail, selected: true, resolution_state: 'ready'
  }));
  window.__TAURI__ = { core: { invoke: async (command, args = {}) => {
    if (command === 'get_appearance_settings') return { theme, accent, intensity: 88, tone: 8, scale: 100, textScale: 100 };
    if (command === 'media_session_settings') return { useBraveCookies: false, cookiesPath: '' };
    if (command === 'desktop_settings') return { downloads_dir: 'C:\\Users\\Usuario\\Downloads\\CacaTools' };
    if (command === 'show_preparation_window' || command === 'wake_main_window' || command === 'show_main_window') return null;
    if (command === 'inspect_download_url') {
      if (kind === 'http') return { requires_media_resolver: false, kind: 'direct', suggested_filename: 'phase-v5-fixture.bin', normalized_url: args.url, content_type: 'application/octet-stream' };
      return { requires_media_resolver: true, kind: kind === 'playlist' ? 'playlist' : 'generic_url', normalized_url: args.url };
    }
    if (command === 'analyze_media_url_with_session' || command === 'analyze_media_url_with_session_for_window') {
      if (kind === 'playlist') return { kind: 'playlist', title: 'MUSICA POP VARIOS ARTISTAS', creator: 'irene lizeth cubillos ortiz', items, formats: [{ id: 'audio-mp3', label: 'MP3 320 kbps', audio_only: true, filesize: 4510000 }] };
      return { kind: 'media', title: 'Summer Anime 2026 In A Nutshell', creator: 'Gigquk', duration_label: '25:22', duration_seconds: 1522, thumbnail, formats: [{ id: 'best', label: 'Mejor disponible · hasta 1440p', height: 1440, audio_only: false, filesize: 10400000 }, { id: '360', label: '360p', height: 360, audio_only: true, filesize: 4100000 }] };
    }
    return null;
  } } };
})();
