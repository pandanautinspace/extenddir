import { itemKey } from './extract';

// Lists in chrome.storage.local (layout in Newtab.jsx), for the parts of the extension
// that aren't the new tab page. The new tab page picks up changes as they're stored.

export const loadAllLists = async () => {
  const { __tab_lists: ids = [], ...lists } = await chrome.storage.local.get(null);
  return ids.filter(id => lists[id]).map(id => ({ id, ...lists[id] }));
}

// lists are ordered by "__tab_lists" and sources by "__sources"; both are kept the same way
const adder = (key) => async (list) => {
  const { [key]: ids = [] } = await chrome.storage.local.get(key);
  const listId = crypto.randomUUID();
  await chrome.storage.local.set({ [listId]: { tabs: [], groups: {}, ...list }, [key]: [...ids, listId] });
  return listId;
}

export const addList = adder("__tab_lists");

export const addSource = adder("__sources");

// stores change(list) in place of the list, if it's still there
export const updateList = async (listId, change) => {
  const { [listId]: list } = await chrome.storage.local.get(listId);
  if (!list) return null;
  const updated = change(list);
  await chrome.storage.local.set({ [listId]: updated });
  return updated;
}

// Fresh items from a list's source replace the ones from before; things you added
// yourself stay, ahead of them, and fresh copies of them are left out.
export const withFreshItems = (tabs, fresh) => {
  const kept = tabs.filter(t => !t.sourced);
  const keys = new Set(kept.map(itemKey));
  return [...kept, ...fresh.filter(item => !keys.has(itemKey(item)))];
}
