// Tabs opened from a list go back into it when they're closed. The new tab page tells the
// background which list each tab came from, and the background keeps the page the tab is
// on, since a closed tab can't be asked. Kept in session storage, since tab ids only last
// until the browser closes:
//   "opened": { [tabId]: { listId, index, group?, groupInfo?, item: { title, url } } }
// index is where the item was in its list; group and groupInfo ({ title, color }) are its
// saved group, kept since a list forgets a group once all its tabs are gone.

import { updateList } from '../../sources/lists';

let opened = null;

// changes happen one at a time, since closing a window closes its tabs all at once
let last = Promise.resolve();
const serially = (job) => last = last.then(async () => {
  opened ??= (await chrome.storage.session.get("opened")).opened ?? {};
  return job();
}).catch(error => console.error(error));

const save = () => chrome.storage.session.set({ opened });

// a tab that was opened from a list and then opens another saved tab in its place (from
// the new tab page, gone back to) is done with the first, so it goes back
export const remember = (tabs) => serially(async () => {
  for (const { tabId, ...entry } of tabs) {
    const before = opened[tabId];
    opened[tabId] = entry;
    if (before) await updateList(before.listId, list => putBack(list, before));
  }
  return save();
});

export const forget = (tabIds) => serially(() => {
  tabIds.forEach(tabId => delete opened[tabId]);
  return save();
});

// only pages worth going back to, and not the new tab page the tab may have gone back to
const isPage = (url) => /^(https?|file|ftp):/.test(url ?? "");

// Put the item back where it was, or with the rest of its group, keeping groups together.
// It isn't put back when it's already there.
const putBack = (list, { index, group, groupInfo, item }) => {
  if (list.tabs.some(t => t.url == item.url)) return list;
  const tabs = [...list.tabs];
  const groups = { ...list.groups };
  if (group != null) groups[group] ??= groupInfo;
  let at = Math.min(index ?? tabs.length, tabs.length);
  if (group != null && tabs.some(t => t.group == group)) {
    at = tabs.findLastIndex(t => t.group == group) + 1;
  } else {
    while (at > 0 && at < tabs.length && tabs[at - 1].group != null && tabs[at - 1].group == tabs[at].group) at++;
  }
  tabs.splice(at, 0, group != null ? { ...item, group } : item);
  return { ...list, tabs, groups };
}

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!change.url && !change.title) return;
  serially(() => {
    const entry = opened[tabId];
    if (!entry || !isPage(tab.url)) return;
    entry.item = { title: tab.title || entry.item.title, url: tab.url };
    return save();
  });
});

chrome.tabs.onReplaced.addListener((added, removed) => serially(() => {
  if (!opened[removed]) return;
  opened[added] = opened[removed];
  delete opened[removed];
  return save();
}));

chrome.tabs.onRemoved.addListener((tabId) => serially(async () => {
  const entry = opened[tabId];
  if (!entry) return;
  delete opened[tabId];
  await save();
  await updateList(entry.listId, list => putBack(list, entry));
}));
