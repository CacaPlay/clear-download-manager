import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { detectSystemLocale, setSystemLocale } from '../../app-ui/modules/i18n/index.js';
import { localizeNotificationText, translateRuntimeText } from '../../app-ui/modules/i18n/runtime.js';

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const storage = new Map();
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { languages: ['es-MX', 'en-US'], language: 'es-MX' }
});
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key)
  }
});

test('System language uses Windows preferred UI language ahead of WebView2 language', () => {
  setSystemLocale(['en-US', 'es-MX']);
  assert.equal(detectSystemLocale(), 'en');
});

test('System language falls back to the browser when the native language query fails', () => {
  setSystemLocale([]);
  assert.equal(detectSystemLocale(), 'es');
});

test('new notifications are translated in the selected interface language', () => {
  assert.equal(localizeNotificationText('Ajustes guardados', 'en'), 'Settings saved');
  assert.equal(localizeNotificationText('Settings saved', 'es'), 'Ajustes guardados');
  assert.equal(
    localizeNotificationText('component download failed: Network', 'es'),
    'No se pudo verificar o instalar el componente. Comprueba la conexión e inténtalo más tarde.'
  );
});

test('static notifications remain translated in both supported interface languages', () => {
  const notifications = [
    ['Introduce una velocidad entera válida', 'Enter a valid whole-number speed'],
    ['Preferencia de descarga guardada', 'Download preference saved'],
    ['Catálogo de componentes verificado', 'Component catalog verified'],
    ['La descarga ya no se puede cancelar en esta fase.', 'The download can no longer be canceled at this stage.'],
    ['Idioma guardado', 'Language saved'],
    ['Preferencia guardada', 'Preference saved'],
    ['Colores predeterminados restaurados', 'Default colors restored'],
    ['Preferencias multimedia guardadas', 'Media preferences saved'],
    ['El motor local no respondió. La interfaz seguirá disponible.', 'The local engine did not respond. The interface will remain available.'],
    ['La preparación multimedia se abre como ventana nativa en la aplicación de escritorio.', 'Media preparation opens in a native window in the desktop app.'],
    ['Pega un enlace HTTP o HTTPS válido.', 'Paste a valid HTTP or HTTPS link.'],
    ['Descarga capturada desde el navegador.', 'Download captured from the browser.'],
    ['Elige la carpeta y confirma la descarga en la ventana HTTP.', 'Choose a folder and confirm the download in the HTTP window.'],
    ['Solicitud recibida desde la extensión del navegador.', 'Request received from the browser extension.']
  ];
  for (const [spanish, english] of notifications) {
    assert.equal(localizeNotificationText(spanish, 'en'), english, `English notification: ${spanish}`);
    assert.equal(localizeNotificationText(english, 'es'), spanish, `Spanish notification: ${english}`);
  }
});

test('the toast insertion path localizes dynamic messages before showing them', () => {
  const main = fs.readFileSync(path.join(process.cwd(), 'app-ui/main.js'), 'utf8');
  assert.match(main, /item\.textContent\s*=\s*localizeNotificationText\(/);
});

test('every literal toast in the application has an English translation', () => {
  const files = [
    'app-ui/main.js',
    'app-ui/modules/runtime/index.js',
    'app-ui/modules/playlists/index.js',
    'app-ui/modules/downloads/index.js',
    'app-ui/modules/extension/index.js'
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
    const literalToast = /showToast\(\s*(['"])(.*?)\1/g;
    for (const match of source.matchAll(literalToast)) {
      assert.notEqual(translateRuntimeText(match[2], 'en'), match[2], `${file} has an untranslated toast: ${match[2]}`);
    }
  }
});

test.after(() => {
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else delete globalThis.navigator;
  if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
  else delete globalThis.localStorage;
});
