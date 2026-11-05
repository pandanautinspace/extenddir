// Reads a source's items from the page it's injected into, for refreshes that need the
// page to actually load (see Background/refresh.js). In a background tab the background
// calls extenddirExtract; in the offscreen document's hidden frame it asks for the source.

import { extractWhenReady } from '../../sources/extract';

globalThis.extenddirExtract = extractWhenReady;

// only the frame the offscreen document made, not the site's own tabs or frames
const inHiddenFrame = window != top && location.ancestorOrigins?.[0] == new URL(chrome.runtime.getURL("")).origin;

if (inHiddenFrame) {
  (async () => {
    const source = await chrome.runtime.sendMessage({ type: "frame-ready", url: location.href });
    if (source) chrome.runtime.sendMessage({ type: "frame-items", items: await extractWhenReady(source) });
  })();
}
