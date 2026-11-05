// Keeping lists in Chrome's sync storage, so they follow you to other computers signed in
// to Chrome (when Chrome syncs extensions). It's off until it's switched on, on each computer.
//
// Sync storage holds 100 KB, and 8 KB a key, so each list is kept compressed, in pieces:
// "list:<id>" is { pieces, hash, at } and "list:<id>:<n>" are the pieces. "order" is the
// order of the lists and sources, { lists, sources, hash }. What's kept is what you made:
// a source's items come from its page, so they're left out, and each computer refreshes
// its own, as is when it last did, how that went, and whether it's shown here.
//
// Local storage's "__sync" is { enabled, base }, where base has the hash of each list (and
// of the order) as this computer last sent or got it. Something that changed only here is
// sent, and something that changed only elsewhere is taken. A list that changed in both
// places (or that both computers had before syncing, like Read Later) gets what's in
// either, so nothing's lost, though something removed in one place can come back.

import { itemKey } from '../../sources/extract';

const pieceSize = 7000;

// JSON with keys in order, so the same list always hashes the same
const canonical = (value) => JSON.stringify(value, (key, x) => x && typeof x == "object" && !Array.isArray(x)
  ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : x);

const hashOf = (text) => {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 33) ^ text.charCodeAt(i)) >>> 0;
  return `${h.toString(36)}-${text.length.toString(36)}`;
}

// the part of a list that's synced
const shared = ({ tabs = [], source, closed, ...list }) => {
  if (!source) return { ...list, tabs };
  const { error, lastRefreshed, ...rest } = source;
  return { ...list, tabs: tabs.filter(t => !t.sourced), source: rest };
}

// a list from elsewhere, with this computer's items from its source and how its last refresh went
const withOwn = (theirs, mine) => {
  if (!theirs.source) return theirs;
  const { error, lastRefreshed } = mine?.source ?? {};
  return {
    ...theirs,
    tabs: [...theirs.tabs, ...(mine?.tabs ?? []).filter(t => t.sourced)],
    source: { ...theirs.source, ...(error && { error }), ...(lastRefreshed && { lastRefreshed }) },
    ...(mine?.closed && { closed: true }),
  };
}

const pack = async (text) => {
  const zipped = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(zipped).arrayBuffer());
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

const unpack = async (packed) => {
  const bytes = Uint8Array.from(atob(packed), c => c.charCodeAt(0));
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
}

// the list stored elsewhere, or null when its pieces haven't all arrived yet
const remoteList = async (remote, id) => {
  const meta = remote[`list:${id}`];
  try {
    const text = await unpack(Array.from({ length: meta.pieces }, (_, n) => remote[`list:${id}:${n}`]).join(""));
    return hashOf(text) == meta.hash ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

const status = (changes) => chrome.storage.session.set({ syncStatus: { at: Date.now(), ...changes } });

const reconcile = async () => {
  const local = await chrome.storage.local.get(null);
  const state = local.__sync;
  if (!state?.enabled) return;
  const base = { ...state.base };
  const remote = await chrome.storage.sync.get(null);
  const { __tab_lists: listIds = [], __sources: sourceIds = [] } = local;
  const here = Object.fromEntries([...listIds, ...sourceIds].filter(id => local[id]).map(id => [id, local[id]]));
  const there = Object.keys(remote).flatMap(key => key.match(/^list:([^:]+)$/)?.[1] ?? []);

  const send = {};
  const unsend = [];
  const take = {};
  const drop = [];
  for (const id of new Set([...Object.keys(here), ...there])) {
    let text = here[id] && canonical(shared(here[id]));
    let ours = text && hashOf(text);
    const theirs = remote[`list:${id}`]?.hash;
    if (ours == theirs) {
      if (ours) base[id] = ours;
      continue;
    }
    if (theirs != base[id] && ours == base[id]) {
      if (!theirs) {
        drop.push(id);
        delete base[id];
        continue;
      }
      const list = await remoteList(remote, id);
      if (!list) continue;
      take[id] = withOwn(list, here[id]);
      base[id] = theirs;
      continue;
    }
    if (ours && theirs && theirs != base[id]) {
      const list = await remoteList(remote, id);
      if (!list) continue;
      const mine = shared(here[id]);
      const keys = new Set(mine.tabs.map(itemKey));
      const both = { ...mine, groups: { ...list.groups, ...mine.groups }, tabs: [...mine.tabs, ...list.tabs.filter(t => !keys.has(itemKey(t)))] };
      take[id] = withOwn(both, here[id]);
      text = canonical(both);
      ours = hashOf(text);
    }
    const old = remote[`list:${id}`]?.pieces ?? 0;
    if (!ours) {
      unsend.push(`list:${id}`, ...Array.from({ length: old }, (_, n) => `list:${id}:${n}`));
      delete base[id];
      continue;
    }
    const packed = await pack(text);
    const pieces = Math.max(1, Math.ceil(packed.length / pieceSize));
    for (let n = 0; n < pieces; n++) send[`list:${id}:${n}`] = packed.slice(n * pieceSize, (n + 1) * pieceSize);
    for (let n = pieces; n < old; n++) unsend.push(`list:${id}:${n}`);
    send[`list:${id}`] = { pieces, hash: ours, at: Date.now() };
    base[id] = ours;
  }

  // The order: the one that changed, kept to the lists there are now, with any it
  // doesn't have yet at the end.
  const exists = (id) => !drop.includes(id) && (here[id] || take[id]);
  const ourOrder = { lists: listIds.filter(exists), sources: sourceIds.filter(exists) };
  const theirOrder = remote.order;
  const takeOrder = theirOrder && theirOrder.hash != base.order && hashOf(canonical(ourOrder)) == base.order;
  const order = takeOrder ? { lists: theirOrder.lists.filter(exists), sources: theirOrder.sources.filter(exists) } : ourOrder;
  for (const id of Object.keys(take).filter(id => !order.lists.includes(id) && !order.sources.includes(id))) {
    (theirOrder?.sources.includes(id) ? order.sources : order.lists).push(id);
  }
  base.order = hashOf(canonical(order));
  if (base.order != theirOrder?.hash) send.order = { ...order, hash: base.order };

  // chrome.storage.sync takes a write or two a second at most, so they go together
  try {
    if (unsend.length) await chrome.storage.sync.remove(unsend);
    if (Object.keys(send).length) await chrome.storage.sync.set(send);
  } catch (error) {
    const used = await chrome.storage.sync.getBytesInUse(null).catch(() => 0);
    await status({ error: /quota/i.test(error.message)
      ? `Your lists are too big to sync: Chrome keeps 100 KB for them, and ${Math.round(used / 1024)} KB is in use`
      : error.message });
    return;
  }
  if (drop.length) await chrome.storage.local.remove(drop);
  await chrome.storage.local.set({
    ...take,
    __tab_lists: order.lists, __sources: order.sources,
    __sync: { ...state, base },
  });
  await status({ bytes: await chrome.storage.sync.getBytesInUse(null), sent: Object.keys(send).length > 0 });
}

// one at a time, and a moment after the last change, since changes come in bursts
let running = Promise.resolve();
let timer = null;
const soon = (ms) => {
  clearTimeout(timer);
  timer = setTimeout(() => running = running.then(reconcile).catch(error => status({ error: error.message })), ms);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area == "sync") soon(1000);
  // what this file writes changes "__sync" along with the lists, so it's what it last did
  if (area == "local" && !changes.__sync) soon(3000);
  if (area == "local" && changes.__sync?.newValue?.enabled && !changes.__sync.oldValue?.enabled) soon(0);
});

chrome.runtime.onStartup.addListener(() => soon(0));

// switching sync on clears what older versions kept in sync storage (lists by id, before
// they moved to local storage), which would take up the room
export const enableSync = async (enabled) => {
  if (enabled) {
    const old = Object.keys(await chrome.storage.sync.get(null)).filter(key => key != "order" && !key.startsWith("list:"));
    if (old.length) await chrome.storage.sync.remove(old);
  }
  const { __sync } = await chrome.storage.local.get("__sync");
  await chrome.storage.local.set({ __sync: { base: {}, ...__sync, enabled } });
  if (!enabled) await chrome.storage.session.remove("syncStatus");
}
