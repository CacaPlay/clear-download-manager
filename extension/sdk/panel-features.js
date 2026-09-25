import {publicUrl} from './selection.js';
import { DEFAULT_PROGRESS } from './appearance.js';

export const progressDefaults = DEFAULT_PROGRESS;

export function youtubeSelection(value) {
  const safe = publicUrl(value); if (!safe) return null;
  const url = new URL(safe), host=url.hostname.replace(/^www\./,'');
  if (!(host==='youtu.be'||host==='youtube.com'||host.endsWith('.youtube.com'))) return null;
  const video = url.searchParams.get('v') || url.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]+)/)?.[1] || (host==='youtu.be'?url.pathname.slice(1):'');
  const list = url.searchParams.get('list');
  if (list) {
    if (list.startsWith('RD')) {
      const seed=video || (/^RD[\w-]{11}$/.test(list)?list.slice(2):'');
      if (!seed) throw new Error('Este Mix necesita abrirse desde un vídeo de YouTube. Abre el Mix y vuelve a enviarlo.');
      return {type:'playlist',url:`https://www.youtube.com/watch?v=${encodeURIComponent(seed)}&list=${encodeURIComponent(list)}`};
    }
    return {type:'playlist',url:`https://www.youtube.com/playlist?list=${encodeURIComponent(list)}`};
  }
  return video ? {type:'video',url:`https://www.youtube.com/watch?v=${encodeURIComponent(video)}`} : null;
}

// Context-menu sends are deliberately video-only. A YouTube watch URL may
// contain list/index/start_radio parameters, but those parameters must never
// turn a right-click on the current video into a playlist submission.
export function youtubeVideoOnly(value) {
  const safe = publicUrl(value); if (!safe) return null;
  const url = new URL(safe), host = url.hostname.replace(/^www\./, '').toLowerCase();
  if (!(host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com'))) return null;
  const video = url.searchParams.get('v') || url.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]+)/)?.[1] || (host === 'youtu.be' ? url.pathname.split('/').filter(Boolean)[0] : '');
  return video ? {type:'video', url:`https://www.youtube.com/watch?v=${encodeURIComponent(video)}`} : null;
}

export function contextSelection(info,tab={}) {
  const page=publicUrl(info.frameUrl||info.pageUrl||tab.url);
  if (info.mediaType==='image') {
    const url=publicUrl(info.srcUrl);
    if(!url)throw new Error('La imagen no tiene un enlace HTTP/HTTPS descargable.');
    return {item:{type:'direct_file',url,pageUrl:page},windowMode:'background'};
  }
  const linkedVideo = youtubeVideoOnly(info.linkUrl);
  const pageVideo = youtubeVideoOnly(page);
  const source=publicUrl(info.linkUrl) || (pageVideo?page:publicUrl(info.srcUrl)||page);
  if(!source)throw new Error('Este contenido no tiene un enlace compatible.');
  const youtube=linkedVideo || pageVideo || youtubeVideoOnly(source);
  if (page && /(^|\.)youtube\.com$/i.test(new URL(page).hostname.replace(/^www\./, '')) && !youtube) {
    throw new Error('Abre un vídeo individual de YouTube para enviarlo a Clear Download Manager.');
  }
  return {item:{...(youtube||{type:'generic_url',url:source}),pageUrl:page},windowMode:'foreground'};
}

export function appendDetectedLink(collection,item,id) {
  const url=publicUrl(item.mediaUrl||item.canonicalUrl||item.url);
  if(!url||!['video','audio'].includes(item.type))throw new Error('Añade vídeos o audio individuales a tu playlist.');
  if(collection.links.some(link=>link.url===url))return false;
  collection.links.push({id,url,type:item.type,title:item.title||url,thumbnail:item.thumbnail||'',author:item.author||'',selected:true,addedAt:Date.now(),metadataResolved:true});
  return true;
}
