import { cdmNative } from './cdm-native-client.js';

const MENU_ID = 'cdm-download';

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
  await cdmNative.analyze(url, {
    pageTitle: tab?.title || '',
    source: 'context-menu'
  });
});

chrome.action.onClicked.addListener(async (tab) => {
  await cdmNative.open();
  if (tab?.url?.startsWith('http')) {
    await cdmNative.analyze(tab.url, { pageTitle: tab.title || '', source: 'action' });
  }
});
