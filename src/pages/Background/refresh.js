// Refreshing a list from its source. Pages are read the cheapest way that works, and the
// way that worked is kept on the source to try first next time:
//   fetch: download the page and parse it, for pages that come with their content
//   data:  download the page and read the JSON it embeds for its scripts, for pages that
//          draw their content from it (only when the picker found the items there)
//   frame: load it in a frame in the hidden offscreen document, for pages that fill in
//          with JavaScript, without showing anything
//   tab:   load it in a background tab, for pages that won't load in a frame
// Feeds are always fetched.

import { compare } from '../../sources/compare';
import { enoughItems, sitePattern } from '../../sources/extract';
import { updateList, withFreshItems } from '../../sources/lists';

const methods = ["fetch", "data", "frame", "tab"];

const timeout = (ms, what) => new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} took too long`)), ms));

let creatingOffscreen = null;

const ensureOffscreen = async () => {
  if ((await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).length) return;
  creatingOffscreen ??= chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["DOM_SCRAPING"],
    justification: "Reads pages to refresh the lists made from them",
  }).finally(() => creatingOffscreen = null);
  await creatingOffscreen;
}

const toOffscreen = async (message) => {
  await ensureOffscreen();
  const { items, error } = await chrome.runtime.sendMessage({ target: "offscreen", ...message });
  if (error) throw new Error(error);
  return items;
}

// what texts are about, as vectors, for sorting things by topic (see sources/similar.js);
// not queued, since it doesn't need the frame
export const embed = (texts) => toOffscreen({ type: "embed", texts });

// Many sites refuse to be framed, so take those headers off frames loaded outside of
// tabs, which is the offscreen document's.
const allowFraming = () => chrome.declarativeNetRequest.updateSessionRules({
  removeRuleIds: [1],
  addRules: [{
    id: 1,
    action: {
      type: "modifyHeaders",
      responseHeaders: [
        { header: "x-frame-options", operation: "remove" },
        { header: "content-security-policy", operation: "remove" },
      ],
    },
    condition: { resourceTypes: ["sub_frame"], tabIds: [chrome.tabs.TAB_ID_NONE] },
  }],
});

// the frame being read: its source, and where its items go
let frameJob = null;

// the extractor in the hidden frame asks for the source, then sends back the items
export const onFrameMessage = (message, sendResponse) => {
  if (message.type == "frame-ready") sendResponse(frameJob?.source ?? null);
  if (message.type == "frame-items") frameJob?.resolve(message.items);
}

const untilLoaded = (tabId) => new Promise(resolve => {
  const listener = (id, info) => {
    if (id != tabId || info.status != "complete") return;
    chrome.tabs.onUpdated.removeListener(listener);
    resolve();
  };
  chrome.tabs.onUpdated.addListener(listener);
});

// Chrome doesn't draw a tab in the background, and tells its page it's hidden, so pages
// that load more as they're scrolled, like Instagram's feed, never see the bottom come
// into view and stop. While a tab is screencast, Chrome draws it as if it were shown, so
// the tab being read is screencast, at the smallest size, until it's closed. Chrome says
// the extension is debugging the browser meanwhile. Returns what stops it.
const keepDrawn = async (tabId) => {
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, "1.3");
  } catch {
    return () => { };
  }
  // frames keep coming only as they're acknowledged
  const onFrame = (source, method, params) => {
    if (source.tabId == tabId && method == "Page.screencastFrame") {
      chrome.debugger.sendCommand(target, "Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => { });
    }
  };
  chrome.debugger.onEvent.addListener(onFrame);
  await chrome.debugger.sendCommand(target, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => { });
  await chrome.debugger.sendCommand(target, "Page.startScreencast", { format: "jpeg", quality: 1, maxWidth: 64, maxHeight: 64 }).catch(() => { });
  return () => {
    chrome.debugger.onEvent.removeListener(onFrame);
    return chrome.debugger.detach(target).catch(() => { });
  };
}

const readers = {
  feed: (source) => toOffscreen({ type: "feed", source }),
  fetch: (source) => toOffscreen({ type: "fetch", source }),
  data: (source) => toOffscreen({ type: "data", source }),
  frame: async (source) => {
    await allowFraming();
    await chrome.scripting.registerContentScripts([{
      id: "extenddir-frame",
      js: ["extractor.bundle.js"],
      matches: [sitePattern(source.url)],
      allFrames: true,
      runAt: "document_idle",
      persistAcrossSessions: false,
    }]);
    try {
      const items = new Promise(resolve => frameJob = { source, resolve });
      await toOffscreen({ type: "frame", source });
      // loading takes a while, and so does scrolling for more (see extractWhenReady)
      return await Promise.race([items, timeout(45000, "Loading the page out of sight")]);
    } finally {
      frameJob = null;
      await chrome.scripting.unregisterContentScripts({ ids: ["extenddir-frame"] }).catch(() => { });
      await toOffscreen({ type: "clear-frame" }).catch(() => { });
    }
  },
  tab: async (source) => {
    const { id } = await chrome.tabs.create({ url: source.url, active: false });
    const stopDrawing = await keepDrawn(id);
    try {
      await Promise.race([untilLoaded(id), timeout(25000, "Loading the page in a tab")]);
      await chrome.scripting.executeScript({ target: { tabId: id }, files: ["extractor.bundle.js"] });
      // reading waits for the page and scrolls it (see extractWhenReady), but a page that
      // hangs mustn't hold up the refreshes after it
      const [{ result }] = await Promise.race([chrome.scripting.executeScript({
        target: { tabId: id },
        func: (source) => extenddirExtract(source),
        args: [source],
      }), timeout(45000, "Reading the page in a tab")]);
      return result ?? [];
    } finally {
      await stopDrawing();
      chrome.tabs.remove(id).catch(() => { });
    }
  },
};

// Tries each way of reading the source until one finds enough items, then stores what
// the best one found. A source where nothing works keeps its old items and an error.
const refreshList = async (listId) => {
  const { [listId]: list } = await chrome.storage.local.get(listId);
  const source = list?.source;
  if (!source) return { error: "This list has no source" };
  const usable = methods.filter(m => m != "data" || source.data);
  const order = source.kind == "feed" ? ["feed"]
    : [source.method, ...usable.filter(m => m != source.method)].filter(m => usable.includes(m));
  let best = null;
  const errors = [];
  for (const method of order) {
    try {
      const items = await readers[method](source);
      if (items.length > (best?.items.length ?? 0)) best = { method, items };
      if (items.length >= enoughItems(source)) break;
      errors.push(`${method}: found ${items.length} items`);
    } catch (error) {
      errors.push(`${method}: ${error.message}`);
    }
  }
  const status = best
    ? { method: best.method, lastRefreshed: Date.now(), error: null }
    : { error: errors.join("; ") || "Found nothing" };
  await updateList(listId, l => ({
    ...l,
    source: { ...l.source, ...status },
    ...(best && { tabs: withFreshItems(l.tabs, best.items) }),
  }));
  return best ? { count: best.items.length, method: best.method } : { error: status.error };
}

// Trying ways of refreshing a source that isn't saved yet, for the picker, compared with
// the items picked (here, with their field values). "download" checks both downloading
// and reading its data, and learns where the items are in the download (see
// download.js's checkDownload); "frame" and "tab" read the page as shown.
const tryRefresh = async ({ source, here, values, methods }) => {
  if (!await chrome.permissions.contains({ origins: [sitePattern(source.url)] })) return { error: "no permission" };
  const out = { results: [] };
  const failed = (method, error) => ({ method, error: error.message, ...compare(here, []) });
  if (methods.includes("download")) {
    try {
      Object.assign(out, await toOffscreen({ type: "check", source, here, values }));
    } catch (error) {
      out.results.push(failed("fetch", error));
    }
  }
  for (const method of methods.filter(m => m == "frame" || m == "tab")) {
    try {
      out.results.push({ method, ...compare(here, await readers[method](source)), reads: source.fields });
    } catch (error) {
      out.results.push(failed(method, error));
    }
  }
  return out;
}

// One refresh or try at a time, since there's only one offscreen document and frame.
// Each gets two minutes, so one that hangs doesn't hold up the rest.
let queue = Promise.resolve();

const queued = (work) => {
  const run = queue.then(() => Promise.race([work(), timeout(120000, "Refreshing")])).catch(error => ({ error: error.message }));
  queue = run;
  return run;
}

export const queueRefresh = (listId) => queued(() => refreshList(listId));

export const queueTry = (request) => queued(() => tryRefresh(request));
