// A hidden page the background uses to read pages without opening a tab: it fetches and
// parses them, reads the JSON they embed, or for pages that only fill in with
// JavaScript, loads them in a frame (where Extractor/index.js reads them). See
// Background/refresh.js. It also works out what texts are about (see embed.js).

import { parseFeed } from '../../sources/extract';
import { checkDownload, fetchText, itemsInData, itemsInHtml } from '../../sources/download';
import { embed } from './embed';

const handlers = {
  fetch: async ({ source }) => itemsInHtml(await fetchText(source.url), source),
  data: async ({ source }) => itemsInData(await fetchText(source.url), source),
  check: async ({ source, here, values }) => checkDownload(await fetchText(source.url), source, here, values),
  feed: async ({ source }) => {
    const { text, url } = await fetchText(source.url);
    return parseFeed(text, url);
  },
  // one frame at a time; loading another replaces it
  frame: async ({ source }) => {
    document.body.replaceChildren(Object.assign(document.createElement("iframe"), { src: source.url }));
    return null;
  },
  embed: async ({ texts }) => embed(texts),
  "clear-frame": async () => {
    document.body.replaceChildren();
    return null;
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target != "offscreen") return;
  handlers[message.type](message)
    .then(items => sendResponse({ items }))
    .catch(error => sendResponse({ error: error.message }));
  return true;
});
