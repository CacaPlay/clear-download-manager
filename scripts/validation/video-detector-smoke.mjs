import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync('extension/content/detector.js', 'utf8');

function runFixture(fixture) {
  const sent = [];
  const selectors = new Map(Object.entries(fixture.selectors || {}));
  const context = {
    URL,
    Number,
    String,
    Array,
    JSON,
    Math,
    Promise,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    location: fixture.location,
    document: {
      title: fixture.title || '',
      documentElement: {},
      querySelector: (selector) => selectors.get(selector)?.[0] || null,
      querySelectorAll: (selector) => selectors.get(selector) || []
    },
    chrome: {
      runtime: {
        onMessage: { addListener: () => {} },
        sendMessage: (message) => { sent.push(message); return Promise.resolve(); }
      }
    },
    MutationObserver: class { observe() {} },
    addEventListener: () => {},
    console
  };
  context.globalThis = context;
  context.window = context;
  vm.runInNewContext(source, context, { filename: 'extension/content/detector.js' });
  return { ...context.__cacatoolsCollectDetections(), sent };
}

const emptyMeta = {
  'meta[property="og:title"]': [],
  'meta[name="twitter:title"]': [],
  'meta[itemprop="name"]': [],
  'meta[property="og:site_name"]': [],
  'meta[name="author"]': [],
  'meta[itemprop="author"]': [],
  'meta[property="og:image"]': [],
  'meta[name="twitter:image"]': [],
  'meta[itemprop="thumbnailUrl"]': []
};

const youtubeBlob = runFixture({
  title: 'YouTube placeholder',
  location: { href: 'https://www.youtube.com/watch?v=abc123', hostname: 'www.youtube.com', pathname: '/watch', search: '?v=abc123' },
  selectors: {
    ...emptyMeta,
    'video, audio': [{ tagName: 'VIDEO', currentSrc: 'blob:https://www.youtube.com/stream', src: '', duration: 91, querySelector: () => null }],
    audio: [],
    'script[type="application/ld+json"]': [],
    'a[href]': []
  }
});
if (youtubeBlob.detections[0]?.mediaUrl !== 'https://www.youtube.com/watch?v=abc123') throw new Error('El blob no se convirtió en la URL pública');
if (youtubeBlob.detections[0]?.type !== 'video') throw new Error('El blob no conservó el tipo video');

const directVideo = runFixture({
  title: 'Archivo MP4',
  location: { href: 'https://media.example.test/player', hostname: 'media.example.test', pathname: '/player', search: '' },
  selectors: {
    ...emptyMeta,
    'video, audio': [{ tagName: 'VIDEO', currentSrc: 'https://cdn.example.test/movie.mp4', src: '', duration: 12, querySelector: () => null }],
    audio: [],
    'script[type="application/ld+json"]': [],
    'a[href]': []
  }
});
if (directVideo.detections[0]?.mediaUrl !== 'https://cdn.example.test/movie.mp4') throw new Error('El video directo perdió su URL multimedia');

const youtubePlaylist = runFixture({
  title: 'Lista pública',
  location: { href: 'https://www.youtube.com/playlist?list=PL123456', hostname: 'www.youtube.com', pathname: '/playlist', search: '?list=PL123456' },
  selectors: { ...emptyMeta, 'video, audio': [], audio: [], 'script[type="application/ld+json"]': [], 'a[href]': [] }
});
// Automatic content detection is intentionally item-oriented. Playlists are
// created only by the explicit manual playlist flow, so the detector must not
// emit a playlist candidate (this replaces the obsolete pre-manual-flow test).
if (youtubePlaylist.detections.length !== 0 || youtubePlaylist.status !== 'no_media') throw new Error('La playlist automática debe quedar fuera del detector');

const youtubeVideoWithList = runFixture({
  title: 'Vídeo dentro de lista',
  location: { href: 'https://www.youtube.com/watch?v=abc123&list=PL123456', hostname: 'www.youtube.com', pathname: '/watch', search: '?v=abc123&list=PL123456' },
  selectors: { ...emptyMeta, 'video, audio': [], audio: [], 'script[type="application/ld+json"]': [], 'a[href]': [] }
});
if (youtubeVideoWithList.detections.filter((item) => item.type === 'video').length !== 1 || youtubeVideoWithList.detections.some((item) => item.type === 'playlist')) throw new Error('El vídeo con playlist asociada debe conservar solo el candidato de vídeo automático');

const pageWithVideoWithoutSource = runFixture({
  title: 'Página de contenido',
  location: { href: 'https://example.test/article/video-guide', hostname: 'example.test', pathname: '/article/video-guide', search: '' },
  selectors: { ...emptyMeta, 'video, audio': [{ tagName: 'VIDEO', currentSrc: '', src: '', duration: NaN, querySelector: () => null }], audio: [], 'script[type="application/ld+json"]': [], 'a[href]': [] }
});
if (pageWithVideoWithoutSource.detections.length !== 0) throw new Error('Un video sin fuente no debe convertirse en vídeo usando la URL de la página');

const directArchive = runFixture({
  title: 'Descarga directa',
  location: { href: 'https://example.test/files', hostname: 'example.test', pathname: '/files', search: '' },
  selectors: { ...emptyMeta, 'video, audio': [], audio: [], 'script[type="application/ld+json"]': [], 'a[href]': [{ href: 'https://cdn.example.test/archive.zip', textContent: 'Paquete' }] }
});
if (directArchive.detections[0]?.type !== 'direct_file' || directArchive.detections[0]?.mediaKind !== 'file') throw new Error('El archivo directo no conservó tipo direct_file');

console.log('OK: detector de vídeo reconoce blob de YouTube y archivos multimedia directos.');
