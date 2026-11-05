// Reading a source from its page downloaded, not shown: the "fetch" and "data" ways of
// refreshing (see Background/refresh.js). The offscreen document refreshes this way, and
// checks what a refresh will get for the picker before saving (as does the picker itself
// when the extension can't read the site).

import { better, compare } from './compare';
import { extractData, learnData } from './data';
import { extractItems } from './extract';
import { learnHtml } from './remap';

// sites can hold a download open without answering, so it gives up after 20 seconds
export const fetchText = async (url) => {
  const response = await fetch(url, { credentials: "include", signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return { text: await response.text(), url: response.url };
}

export const parse = (text) => new DOMParser().parseFromString(text, "text/html");

// the pieces a page loads into itself after it's shown: Reddit's faceplate-partial,
// GitHub's include-fragment and Hotwire's turbo-frame
const pieces = "faceplate-partial[src], include-fragment[src], turbo-frame[src]";

// a page wants at least this many items, or as many as were picked if that's more
const wanted = (source) => Math.max(source.expected ?? 0, 20);

// a piece whose address says it's the next page of items, like Reddit's community-more-posts
const looksLikeMore = (piece) => /more|after=|cursor|[?&]page=/i.test(piece.getAttribute("src"));

// Loads pieces into doc until it has the items wanted, up to five of them. Pieces inside
// items (like Reddit's hover cards) are left alone. Pieces that look like the next page
// come first, then ones after the last item, since that's where pages put "more", ahead
// of sidebars.
const loadPieces = async (doc, source, url) => {
  for (let loads = 0; loads < 5; loads++) {
    const items = [...doc.querySelectorAll(source.itemSelector)];
    if (items.length >= wanted(source)) return;
    const all = [...doc.querySelectorAll(pieces)].filter(p => !items.some(item => item.contains(p)));
    const last = items.at(-1);
    const after = all.filter(p => last && last.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING);
    const piece = after.find(looksLikeMore) ?? all.find(looksLikeMore) ?? after[0] ?? all[0];
    if (!piece) return;
    try {
      const { text } = await fetchText(new URL(piece.getAttribute("src"), url).href);
      piece.replaceWith(...parse(text).body.childNodes);
    } catch {
      piece.remove();
    }
  }
}

// The items the page's HTML has, from the downloaded page's text and address, by the
// download's own selectors when it comes in another layout than it's shown in (see remap.js)
export const itemsInHtml = async ({ text, url }, source) => {
  const doc = parse(text);
  const asDownloaded = source.html ? { ...source, ...source.html } : source;
  await loadPieces(doc, asDownloaded, url);
  return extractItems(doc, asDownloaded, url);
}

// the items in the JSON the downloaded page embeds
export const itemsInData = ({ text, url }, source) => extractData(parse(text), source.data, source.itemType, url);

// What refreshing by downloading the page gets, compared with the items picked (here, with
// their field values), and where the items are in the download's HTML and JSON. The
// download's own selectors are kept only when they do better than the ones picked.
export const checkDownload = async (page, source, here, values) => {
  const data = learnData(parse(page.text), values, page.url) ?? undefined;
  const html = learnHtml(parse(page.text), values, page.url) ?? undefined;
  const asPicked = compare(here, await itemsInHtml(page, source));
  const remapped = html && compare(here, await itemsInHtml(page, { ...source, html }));
  const useHtml = remapped && better(remapped, asPicked);
  const results = [{
    method: "fetch", ...(useHtml ? remapped : asPicked), reads: (useHtml ? html : source).fields,
    note: useHtml && `The download comes in another layout than the page shows, so it's read by its own selectors: each item is ${html.itemSelector}.`,
  }];
  if (data) results.push({ method: "data", ...compare(here, itemsInData(page, { ...source, data })), reads: data.fields });
  return { data, html: useHtml ? html : undefined, results };
}
