import { cacaToolsNative } from './cacatools-native-client.js';

const MENU_ID = 'cacatools-download';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: 'Descargar con Clear Download Manager',
      contexts: ['link', 'video', 'audio', 'page']
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  const url = info.linkUrl || info.srcUrl || info.pageUrl || tab?.url || '';
  if (!url) return;
  await cacaToolsNative.analyze(url, {
    pageTitle: tab?.title || '',
    source: 'context-menu'
  });
});

chrome.action.onClicked.addListener(async (tab) => {
  await cacaToolsNative.open();
  if (tab?.url?.startsWith('http')) {
    await cacaToolsNative.analyze(tab.url, { pageTitle: tab.title || '', source: 'action' });
  }
});
