import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { ChakraProvider } from '@chakra-ui/react';
import Newtab from './Newtab';
import { domainOf, isLink, itemText, itemType, ItemEditor } from './Items';
import { itemKey } from '../../sources/extract';
import { updateList } from '../../sources/lists';
import './Home.css';

// The home view: one search box in the middle of the page, the lists floating around it as
// bubbles, and the open tabs scattered below it. Typing brings what matches into the
// results under the box, and the bubbles fly in with it (they share a layoutId with their
// row). Scrolling down shows the lists page (Newtab.jsx) underneath, stacked.
//
// Everything here reads and writes the same storage as the lists page, which picks up the
// changes as they're stored, so the two never get out of step.

const TAB_TYPE = "application/x-extenddir-tab";

const spring = { type: "spring", stiffness: 420, damping: 36 };

const filters = [
  { key: "all", label: "All" },
  { key: "tabs", label: "Tabs" },
  { key: "lists", label: "Lists" },
  { key: "sources", label: "Sources" },
  { key: "web", label: "Web" },
];

const groupColors = {
  grey: "#9aa0a6", blue: "#4c8bf5", red: "#e5534b", yellow: "#e8b931", green: "#3fa15b",
  pink: "#e46aa8", purple: "#9b6ce6", cyan: "#2aa6b8", orange: "#f08c3a",
};

const faviconUrl = (url) => chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(url ?? "")}&size=32`);

// a stable number for a string, to place and color things the same way every time
const hashOf = (s) => {
  let h = 2166136261;
  for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}
const jitter = (seed, range) => ((hashOf(seed) % 1000) / 1000 - 0.5) * 2 * range;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const tokensOf = (query) => query.toLowerCase().split(/\s+/).filter(Boolean);

// How well title (and the rest of the text) matches every word of the search, 0 for not at
// all. Words at the start of the title count most.
const scoreOf = (tokens, title, rest = "") => {
  if (!tokens.length) return 1;
  const t = (title ?? "").toLowerCase();
  const all = `${t} ${rest.toLowerCase()}`;
  let score = 0;
  for (const token of tokens) {
    if (!all.includes(token)) return 0;
    score += t.startsWith(token) ? 4 : new RegExp(`\\b${escapeRe(token)}`).test(t) ? 3 : t.includes(token) ? 2 : 1;
  }
  return score;
}

const itemTitle = (item) => ({
  text: () => item.text?.split("\n").find(Boolean) || "Empty note",
  image: () => item.alt || "Image",
  page: () => item.title || "Untitled page",
})[itemType(item)]?.() ?? (item.title || item.url);

const itemSub = (item) => isLink(item) ? domainOf(item.url) : { text: "Note", image: "Image", page: "Page" }[itemType(item)];

const rankItems = (items, tokens) => {
  const found = items.map((item, index) => ({ item, index, score: scoreOf(tokens, itemTitle(item), itemText(item) ?? "") }))
    .filter(m => m.score > 0);
  return tokens.length ? found.sort((a, b) => b.score - a.score) : found;
}

// what was typed as an address to go to, or null
const asUrl = (query) => {
  const t = query.trim();
  if (!t || /\s/.test(t)) return null;
  if (/^[a-z][\w+.-]*:\/\//i.test(t) || /^(about|chrome|file):/i.test(t)) return t;
  if (/^localhost(:\d+)?(\/.*)?$/i.test(t) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(t)) return `http://${t}`;
  if (/^([\w-]+\.)+[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(t)) return `https://${t}`;
  return null;
}

const Highlight = ({ text, tokens }) => {
  if (!tokens.length || !text) return text ?? null;
  const parts = String(text).split(new RegExp(`(${tokens.map(escapeRe).join("|")})`, "ig"));
  return parts.map((part, i) => i % 2 ? <mark key={i}>{part}</mark> : part);
}

const Icon = ({ name }) => {
  const paths = {
    search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
    globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>,
    arrow: <path d="M7 17 17 7M9 7h8v8" />,
    down: <path d="M12 5v14M6 13l6 6 6-6" />,
    up: <path d="M12 19V5M6 11l6-6 6 6" />,
    note: <><path d="M6 3h9l4 4v14H6z" /><path d="M9 12h7M9 16h5" /></>,
    image: <><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="m21 16-5-5-9 8" /></>,
    page: <><path d="M6 3h9l4 4v14H6z" /><path d="M14 3v5h5" /></>,
    back: <path d="M15 6l-6 6 6 6" />,
  };
  return (
    <svg className="home-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

const ItemIcon = ({ item }) => isLink(item)
  ? <img className="home-favicon" src={faviconUrl(item.url)} alt="" />
  : <span className="home-favicon is-glyph"><Icon name={{ text: "note", image: "image", page: "page" }[itemType(item)]} /></span>;

// Chrome's tabs and tab groups, kept up to date, and this new tab page's own tab
const useBrowserTabs = () => {
  const [tabs, setTabs] = useState([]);
  const [groups, setGroups] = useState({});
  const [self, setSelf] = useState(null);
  useEffect(() => {
    let timer = null;
    // tabs change many times while they load, so changes close together are read once
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        chrome.tabs.query({}).then(setTabs);
        chrome.tabGroups.query({}).then(gs => setGroups(Object.fromEntries(gs.map(g => [g.id, g]))));
      }, 60);
    };
    refresh();
    chrome.tabs.getCurrent().then(tab => setSelf(tab ?? null));
    const events = [
      chrome.tabs.onUpdated, chrome.tabs.onMoved, chrome.tabs.onAttached, chrome.tabs.onCreated,
      chrome.tabs.onActivated, chrome.tabs.onDetached, chrome.tabs.onRemoved, chrome.tabs.onReplaced,
      chrome.tabGroups.onCreated, chrome.tabGroups.onUpdated, chrome.tabGroups.onRemoved,
    ];
    events.forEach(e => e.addListener(refresh));
    return () => {
      clearTimeout(timer);
      events.forEach(e => e.removeListener(refresh));
    };
  }, []);
  return { tabs, groups, self };
}

// the lists and sources as stored (see the storage layout in Newtab.jsx)
const readLists = async () => {
  const { __tab_lists: ids = [], __sources: sourceIds = [], ...rest } = await chrome.storage.local.get(null);
  const lists = Object.fromEntries(Object.entries(rest).filter(([key]) => !key.startsWith("__")));
  return { ids: ids.filter(id => lists[id]), sourceIds: sourceIds.filter(id => lists[id]), lists };
}

const useStoredLists = () => {
  const [stored, setStored] = useState({ ids: [], sourceIds: [], lists: {} });
  useEffect(() => {
    readLists().then(setStored);
    const changed = (changes, area) => area == "local" && readLists().then(setStored);
    chrome.storage.onChanged.addListener(changed);
    return () => chrome.storage.onChanged.removeListener(changed);
  }, []);
  return stored;
}

const useWindowSize = () => {
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const resize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  return size;
}

// where a saved tab came from, to go back to when it's closed (see Background/opened.js)
const openedFrom = (list, listId, index, tabId) => {
  const { group, ...item } = list.tabs[index];
  return { tabId, listId, index, ...(group != null && { group, groupInfo: list.groups?.[group] }), item };
}

const Home = ({ onSwitchView }) => {
  const { tabs, groups, self } = useBrowserTabs();
  const { ids, sourceIds, lists } = useStoredLists();
  const { w, h } = useWindowSize();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  // the list being looked through, chosen from its bubble or its row
  const [scope, setScope] = useState(null);
  const [active, setActive] = useState(0);
  const [editing, setEditing] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);
  const [notice, setNotice] = useState(null);
  // the list whose bubble was hovered long enough to open it as a card
  const [peek, setPeek] = useState(null);
  const peekTimer = useRef(null);
  const input = useRef(null);
  const panel = useRef(null);
  const classic = useRef(null);

  const tokens = tokensOf(query);
  const open = !!query.trim() || !!(scope && lists[scope]) || filter != "all";
  const isSource = (listId) => sourceIds.includes(listId);

  const tell = (text) => {
    setNotice({ text, at: Date.now() });
  }
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(timer);
  }, [notice]);

  // --- what the buttons and rows do ---

  // Switching to a tab closes this new tab page, as there's nothing in it to come back to.
  const switchTo = async (tab) => {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    if (self && self.id != tab.id) chrome.tabs.remove(self.id);
  }

  const closeTab = (tab) => chrome.tabs.remove(tab.id);

  const go = (url, newTab) => newTab ? chrome.tabs.create({ url, active: false }) : chrome.tabs.update({ url });

  const webSearch = (text, newTab) => {
    const disposition = newTab ? "NEW_TAB" : "CURRENT_TAB";
    if (chrome.search?.query) chrome.search.query({ text, disposition });
    else go(`https://www.google.com/search?q=${encodeURIComponent(text)}`, newTab);
  }

  // As on the lists page: a saved link opens here and leaves its list until the tab is
  // closed; a source keeps its items; notes, images and pages open in the editor.
  const openItem = async (listId, index) => {
    const list = lists[listId];
    const item = list?.tabs[index];
    if (!item) return;
    if (!isLink(item)) {
      setEditing({ listId, index, item, readOnly: isSource(listId) });
      return;
    }
    if (isSource(listId)) {
      chrome.tabs.update({ url: item.url });
      return;
    }
    const { id: tabId } = await chrome.tabs.getCurrent();
    await chrome.runtime.sendMessage({ type: "opened", tabs: [openedFrom(list, listId, index, tabId)] });
    await updateList(listId, l => ({ ...l, tabs: l.tabs.filter((t, i) => !(i == index && itemKey(t) == itemKey(item))) }));
    chrome.tabs.update(tabId, { url: item.url });
  }

  // a list's links open as tabs in this window, its groups as tab groups, until they're closed
  const openAll = async (listId) => {
    const list = lists[listId];
    const positions = list.tabs.flatMap((item, index) => isLink(item) ? [index] : []);
    if (!positions.length) return;
    const { id: windowId } = await chrome.windows.getCurrent();
    if (!isSource(listId)) {
      await updateList(listId, l => ({ ...l, tabs: l.tabs.filter((_, index) => !positions.includes(index)) }));
    }
    const fromList = [];
    for (const index of positions) {
      const { id } = await chrome.tabs.create({ active: false, url: list.tabs[index].url, windowId });
      fromList.push(openedFrom(list, listId, index, id));
    }
    if (!isSource(listId)) await chrome.runtime.sendMessage({ type: "opened", tabs: fromList });
    for (const group of new Set(fromList.map(o => o.group).filter(group => group != null))) {
      const { title = "", color = "grey" } = list.groups?.[group] ?? {};
      const tabIds = fromList.filter(o => o.group == group).map(o => o.tabId);
      await chrome.tabGroups.update(await chrome.tabs.group({ tabIds, createProperties: { windowId } }), { title, color });
    }
    setScope(null);
  }

  // a tab dropped on a list is saved there and closed
  const saveTab = async (tabId, listId) => {
    const tab = tabs.find(t => t.id == tabId);
    if (!tab || !lists[listId]) return;
    await updateList(listId, l => ({ ...l, tabs: [...l.tabs, { title: tab.title, url: tab.url || tab.pendingUrl }] }));
    await chrome.runtime.sendMessage({ type: "forget-opened", tabIds: [tabId] });
    chrome.tabs.remove(tabId);
    tell(`Saved to ${lists[listId].name}`);
  }

  const saveItem = ({ listId, index }, { sourced, ...item }) =>
    updateList(listId, l => ({ ...l, tabs: l.tabs.map((t, i) => i == index ? item : t) }));

  // Resting on a bubble opens its list as a card; leaving the card closes it a moment later.
  const hoverBubble = (listId) => {
    clearTimeout(peekTimer.current);
    peekTimer.current = setTimeout(() => setPeek(listId), 550);
  }
  const leaveBubble = () => clearTimeout(peekTimer.current);
  const leavePeek = () => {
    clearTimeout(peekTimer.current);
    peekTimer.current = setTimeout(() => setPeek(null), 220);
  }
  useEffect(() => () => clearTimeout(peekTimer.current), []);

  const enterList = (listId) => {
    clearTimeout(peekTimer.current);
    setPeek(null);
    setScope(listId);
    setQuery("");
    input.current?.focus();
  }

  const reset = () => {
    setQuery("");
    setScope(null);
    setFilter("all");
  }

  // --- the results ---

  // the open tabs besides this page, this window's first
  const otherTabs = tabs.filter(t => t.id != self?.id)
    .sort((a, b) => (b.windowId == self?.windowId) - (a.windowId == self?.windowId));
  const windowIds = [...new Set(otherTabs.map(t => t.windowId))];

  // Sections in the order they show, and rows, every row that can be chosen, in that same order.
  const sections = [];
  const rows = [];
  const row = (key, data) => {
    rows.push({ key, ...data });
    return key;
  };
  const want = (kind) => filter == "all" || filter == kind;
  if (open && scope && lists[scope]) {
    const found = rankItems(lists[scope].tabs, tokens);
    sections.push({
      type: "scope",
      listId: scope,
      total: found.length,
      items: found.slice(0, 100).map(m => ({ ...m, key: row(`item:${scope}:${m.index}`, { type: "item", listId: scope, index: m.index }) })),
    });
  } else if (open) {
    const typed = query.trim();
    const url = want("web") ? asUrl(typed) : null;
    if (url) sections.push({ type: "web", key: row("url", { type: "url", url }), url });
    if (want("tabs")) {
      const found = otherTabs.map(tab => ({ tab, score: scoreOf(tokens, tab.title, tab.url ?? "") }))
        .filter(m => m.score > 0);
      if (tokens.length) found.sort((a, b) => b.score - a.score);
      const limit = filter == "tabs" ? 200 : 5;
      if (found.length) sections.push({
        type: "tabs",
        total: found.length,
        tabs: found.slice(0, limit).map(({ tab }) => ({ tab, key: row(`tab:${tab.id}`, { type: "tab", tab }) })),
      });
    }
    for (const [kind, kindIds] of [["lists", ids], ["sources", sourceIds]]) {
      if (!want(kind)) continue;
      const many = filter == kind;
      const per = many ? 5 : 3;
      const found = kindIds.map(listId => {
        const list = lists[listId];
        const nameScore = scoreOf(tokens, list.name ?? "");
        const items = tokens.length ? rankItems(list.tabs, tokens) : [];
        if (tokens.length && !nameScore && !items.length) return null;
        // a list found by its name shows what's at its top
        const shown = items.length ? items : list.tabs.slice(0, per).map((item, index) => ({ item, index }));
        return { listId, score: nameScore * 3 + (items[0]?.score ?? 0), matched: items.length, shown: shown.slice(0, per) };
      }).filter(Boolean);
      if (tokens.length) found.sort((a, b) => b.score - a.score);
      const shown = found.slice(0, many ? 100 : 4);
      if (shown.length) sections.push({
        type: kind,
        total: found.length,
        lists: shown.map(f => ({
          ...f,
          key: row(`list:${f.listId}`, { type: "list", listId: f.listId }),
          shown: f.shown.map(m => ({ ...m, key: row(`item:${f.listId}:${m.index}`, { type: "item", listId: f.listId, index: m.index }) })),
        })),
      });
    }
    if (want("web") && typed) sections.push({ type: "web", key: row("web", { type: "web", text: typed }), text: typed });
  }
  const rowIndex = Object.fromEntries(rows.map((r, i) => [r.key, i]));

  const run = (r, e) => {
    const newTab = e?.metaKey || e?.ctrlKey;
    if (r.type == "tab") switchTo(r.tab);
    else if (r.type == "list") enterList(r.listId);
    else if (r.type == "item") openItem(r.listId, r.index);
    else if (r.type == "url") go(r.url, newTab);
    else if (r.type == "web") webSearch(r.text, newTab);
  }

  // the tabs and lists in the results leave their bubbles, so their bubbles fly in
  const inResults = new Set(sections.flatMap(s =>
    s.type == "tabs" ? s.tabs.map(t => `tab-${t.tab.id}`)
      : s.type == "scope" ? [`list-${s.listId}`]
        : s.lists ? s.lists.map(l => `list-${l.listId}`) : []));
  // a list in the results can't also be open as a card
  const peeking = peek && lists[peek] && !inResults.has(`list-${peek}`) ? peek : null;

  useEffect(() => setActive(0), [query, filter, scope]);
  useEffect(() => {
    panel.current?.querySelector(".home-row.is-active")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const cycleFilter = (step) => {
    const at = filters.findIndex(f => f.key == filter);
    setFilter(filters[(at + step + filters.length) % filters.length].key);
    setScope(null);
  }

  const onKeyDown = (e) => {
    if (e.key == "ArrowDown") {
      e.preventDefault();
      setActive(a => Math.min(rows.length - 1, a + 1));
    } else if (e.key == "ArrowUp") {
      e.preventDefault();
      setActive(a => Math.max(0, a - 1));
    } else if (e.key == "Enter") {
      e.preventDefault();
      if (rows[active]) run(rows[active], e);
    } else if (e.key == "Escape") {
      if (query) setQuery("");
      else if (scope) setScope(null);
      else if (filter != "all") setFilter("all");
      else input.current?.blur();
    } else if (e.key == "Backspace" && !query && scope) {
      setScope(null);
    } else if (e.key == "Tab") {
      e.preventDefault();
      cycleFilter(e.shiftKey ? -1 : 1);
    }
  }

  // Typing anywhere on the top of the page searches, and / searches from anywhere.
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest?.("input, textarea, select, [contenteditable=true], [role=dialog]")) return;
      if (e.metaKey || e.ctrlKey || e.altKey || editing) return;
      if (e.key == "/") {
        e.preventDefault();
        window.scrollTo({ top: 0, behavior: "smooth" });
        input.current?.focus();
      } else if (e.key.length == 1 && window.scrollY < window.innerHeight / 2) {
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing]);

  // --- laying out the bubbles ---

  const pillW = Math.min(640, w - 32);
  const centerY = Math.max(170, Math.round(h * 0.3));

  // Lists sit in columns either side of the box, filling the nearest columns first and
  // taking turns left and right. The last place says how many more there are, when they
  // don't all fit.
  const colW = 112;
  const colsPerSide = Math.max(0, Math.min(3, Math.floor((w / 2 - pillW / 2 - 24) / colW)));
  const rowYs = [-80, 30, 140];
  const places = [];
  for (let col = 0; col < colsPerSide; col++) {
    for (let r = 0; r < rowYs.length; r++) {
      for (const side of [-1, 1]) {
        places.push({ x: side * (pillW / 2 + 24 + colW / 2 + col * colW + (r == 1 ? 16 : 0)), y: rowYs[r] });
      }
    }
  }
  const bubbleIds = [...ids, ...sourceIds];
  const fits = bubbleIds.length <= places.length ? bubbleIds.length : Math.max(0, places.length - 1);
  const listBubbles = bubbleIds.slice(0, fits).map((listId, i) => {
    const count = lists[listId].tabs.length;
    const d = Math.round(70 + Math.min(26, Math.sqrt(count) * 4));
    return { listId, d, x: places[i].x + jitter(`${listId}x`, 10), y: places[i].y + jitter(`${listId}y`, 14) };
  });
  const moreLists = bubbleIds.length - fits;

  // Tabs fill the bottom of the page, as many as fit, and the last says how many more.
  const fieldTop = Math.max(centerY + 250, Math.round(h * 0.62));
  const fieldW = Math.min(1100, w - 48);
  const fieldRows = Math.max(1, Math.floor((h - 72 - fieldTop) / 50));
  const tabRoom = Math.max(1, fieldRows * Math.floor(fieldW / 196));
  const shownTabs = otherTabs.length <= tabRoom ? otherTabs : otherTabs.slice(0, tabRoom - 1);
  const moreTabs = otherTabs.length - shownTabs.length;

  const scopeList = scope && lists[scope];

  const rowProps = (key, onRun) => ({
    "data-key": key,
    className: `home-row${rows[active]?.key == key ? " is-active" : ""}`,
    onMouseMove: () => rowIndex[key] != null && rowIndex[key] != active && setActive(rowIndex[key]),
    onClick: (e) => onRun ? onRun(e) : run(rows[rowIndex[key]], e),
  });

  const tabRow = ({ tab, key }) => (
    <motion.div key={key} layoutId={`tab-${tab.id}`} transition={spring} style={{ borderRadius: 6 }} {...rowProps(key)}>
      <img className="home-favicon" src={faviconUrl(tab.url || tab.pendingUrl)} alt="" />
      <div className="home-row-text">
        <div className="home-row-title"><Highlight text={tab.title} tokens={tokens} /></div>
        <div className="home-row-sub">
          {tab.groupId != -1 && groups[tab.groupId] && (
            <span className="home-group" style={{ "--group": groupColors[groups[tab.groupId].color] }}>{groups[tab.groupId].title || "Group"}</span>
          )}
          <Highlight text={domainOf(tab.url || tab.pendingUrl)} tokens={tokens} />
          {tab.windowId != self?.windowId && ` · Window ${windowIds.indexOf(tab.windowId) + 1}`}
        </div>
      </div>
      <span className="home-row-hint">↵ Switch to tab</span>
      <button className="home-row-close" title="Close tab" onClick={(e) => { e.stopPropagation(); closeTab(tab); }}>×</button>
    </motion.div>
  );

  const itemRow = (listId, { item, index, key }) => (
    <motion.div key={key} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} {...rowProps(key)}>
      <ItemIcon item={item} />
      <div className="home-row-text">
        <div className="home-row-title"><Highlight text={itemTitle(item)} tokens={tokens} /></div>
        <div className="home-row-sub"><Highlight text={itemSub(item)} tokens={tokens} /></div>
      </div>
      <span className="home-row-hint">↵ {!isLink(item) ? "View" : isSource(listId) ? "Open" : "Open · leaves list"}</span>
    </motion.div>
  );

  // a tab dragged over a list (not a source) can be dropped in it
  const dropProps = (listId) => isSource(listId) ? {} : {
    onDragOver: (e) => {
      if (!e.dataTransfer.types.includes(TAB_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDropTarget(listId);
    },
    onDragLeave: () => setDropTarget(t => t == listId ? null : t),
    onDrop: (e) => {
      e.preventDefault();
      setDropTarget(null);
      saveTab(Number(e.dataTransfer.getData(TAB_TYPE)), listId);
    },
  };

  const listHeader = (listId, key, extra) => {
    const list = lists[listId];
    return (
      <motion.div
        key={key}
        layoutId={`list-${listId}`}
        transition={spring}
        style={{ borderRadius: 6 }}
        {...rowProps(key)}
        className={`${rowProps(key).className} home-listrow${isSource(listId) ? " is-source" : ""}${dropTarget == listId ? " is-drop" : ""}`}
        {...dropProps(listId)}
      >
        <span className="home-listdot" />
        <div className="home-row-text">
          <div className="home-row-title"><Highlight text={list.name || "Untitled list"} tokens={tokens} /></div>
          <div className="home-row-sub">
            {isSource(listId) ? `Source · ${domainOf(list.source?.url)} · ` : ""}{list.tabs.length} {list.tabs.length == 1 ? "item" : "items"}
            {extra}
          </div>
        </div>
        <span className="home-row-hint">↵ Look inside</span>
      </motion.div>
    );
  };

  const sectionTitle = (label, total, shown, kind) => (
    <div className="home-section-title">
      <span>{label}</span>
      {total > shown && filter == "all" && (
        <button onClick={() => { setFilter(kind); input.current?.focus(); }}>All {total} →</button>
      )}
    </div>
  );

  const renderSection = (s, i) => {
    if (s.type == "web" && s.url) return (
      <div key="url" className="home-section">
        <div {...rowProps(s.key)}>
          <span className="home-favicon is-glyph"><Icon name="arrow" /></span>
          <div className="home-row-text"><div className="home-row-title">Go to <b>{s.url.replace(/^https?:\/\//, "")}</b></div></div>
          <span className="home-row-hint">↵</span>
        </div>
      </div>
    );
    if (s.type == "web") return (
      <div key="web" className="home-section">
        {sections.length > 1 && sectionTitle("Web")}
        <div {...rowProps(s.key)}>
          <span className="home-favicon is-glyph"><Icon name="search" /></span>
          <div className="home-row-text">
            <div className="home-row-title">Search the web for <b>{s.text}</b></div>
            <div className="home-row-sub">with your default search engine · ⌘/Ctrl+Enter for a new tab</div>
          </div>
        </div>
      </div>
    );
    if (s.type == "tabs") return (
      <div key="tabs" className="home-section">
        {sectionTitle("Open tabs", s.total, s.tabs.length, "tabs")}
        {s.tabs.map(tabRow)}
      </div>
    );
    if (s.type == "lists" || s.type == "sources") return (
      <div key={s.type} className="home-section">
        {sectionTitle(s.type == "lists" ? "Lists" : "Sources", s.total, s.lists.length, s.type)}
        {s.lists.map(l => (
          <div key={l.listId} className="home-listblock">
            {listHeader(l.listId, l.key, tokens.length && l.matched ? ` · ${l.matched} ${l.matched == 1 ? "match" : "matches"}` : "")}
            <div className="home-listitems">
              {l.shown.map(m => itemRow(l.listId, m))}
            </div>
          </div>
        ))}
      </div>
    );
    if (s.type == "scope") {
      const list = lists[s.listId];
      return (
        <div key="scope" className="home-section">
          <motion.div
            layoutId={`list-${s.listId}`}
            transition={spring}
            style={{ borderRadius: 6 }}
            className={`home-scopehead${isSource(s.listId) ? " is-source" : ""}${dropTarget == s.listId ? " is-drop" : ""}`}
            {...dropProps(s.listId)}
          >
            <button className="home-iconbtn" title="Back (Esc)" onClick={() => { setScope(null); input.current?.focus(); }}><Icon name="back" /></button>
            <span className="home-listdot" />
            <div className="home-row-text">
              <div className="home-scopename">{list.name || "Untitled list"}</div>
              <div className="home-row-sub">
                {tokens.length ? `${s.total} of ${list.tabs.length} match` : `${list.tabs.length} ${list.tabs.length == 1 ? "item" : "items"}`}
                {isSource(s.listId) && ` · from ${domainOf(list.source?.url)}`}
              </div>
            </div>
            {list.tabs.some(isLink) && <button className="home-chip" onClick={() => openAll(s.listId)}>Open all</button>}
          </motion.div>
          <div className="home-listitems is-scope">
            {s.items.map(m => itemRow(s.listId, m))}
            {!s.items.length && <div className="home-empty">{list.tabs.length ? `Nothing in ${list.name} matches “${query}”` : "This list is empty. Drag a tab onto it to save it here."}</div>}
          </div>
        </div>
      );
    }
    return null;
  };

  const counts = {
    tabs: otherTabs.length,
    lists: ids.length,
    sources: sourceIds.length,
  };

  return (
    <ChakraProvider>
      <div className="home">
        <section
          className="home-stage"
          style={{ minHeight: Math.max(h, 560) }}
          onMouseDown={(e) => e.target == e.currentTarget && open && reset()}
        >
          <div className="home-top">
            <button className="home-link" onClick={onSwitchView} title="Use the lists page as the new tab page instead">Classic view</button>
          </div>

          {listBubbles.filter(b => !inResults.has(`list-${b.listId}`) && b.listId != peeking).map(({ listId, d, x, y }) => {
            const list = lists[listId];
            return (
              <motion.div
                key={listId}
                layoutId={`list-${listId}`}
                transition={spring}
                className={`home-listbubble${isSource(listId) ? " is-source" : ""}${dropTarget == listId ? " is-drop" : ""}${open ? " is-quiet" : ""}`}
                style={{
                  left: w / 2 + x - d / 2, top: centerY + y - d / 2, width: d, height: d, borderRadius: 999,
                  "--float-delay": `${-(hashOf(listId) % 7000)}ms`,
                }}
              >
                <button
                  className="home-listbubble-inner"
                  title={`${list.name}: ${list.tabs.length} items${isSource(listId) ? " (source)" : "\nDrop a tab here to save it"}`}
                  onClick={() => enterList(listId)}
                  onMouseEnter={() => hoverBubble(listId)}
                  onMouseLeave={leaveBubble}
                  {...dropProps(listId)}
                >
                  <span className="home-listbubble-name">{list.name || "Untitled"}</span>
                  <span className="home-listbubble-count">{list.tabs.length}</span>
                </button>
              </motion.div>
            );
          })}
          {peeking && (() => {
            // The card opens over its bubble, so the pointer is still on it, and grows away from
            // the search box, staying on the page.
            const bubble = listBubbles.find(b => b.listId == peeking);
            if (!bubble) return null;
            const list = lists[peeking];
            const cardW = 320;
            const cardH = Math.min(420, h - 32);
            const bubbleLeft = w / 2 + bubble.x - bubble.d / 2;
            const outward = bubble.x > 0 ? bubbleLeft - 12 : bubbleLeft + bubble.d + 12 - cardW;
            const left = Math.min(Math.max(16, outward), w - cardW - 16);
            const top = Math.max(16, Math.min(centerY + bubble.y - 56, h - cardH - 16));
            return (
              <motion.div
                key="peek"
                layoutId={`list-${peeking}`}
                transition={spring}
                className={`home-peek${isSource(peeking) ? " is-source" : ""}${dropTarget == peeking ? " is-drop" : ""}`}
                style={{ left, top, width: cardW, maxHeight: cardH, borderRadius: 8 }}
                onMouseEnter={() => clearTimeout(peekTimer.current)}
                onMouseLeave={leavePeek}
                {...dropProps(peeking)}
              >
                <div className="home-peek-head">
                  <span className="home-listdot" />
                  <div className="home-row-text">
                    <div className="home-scopename">{list.name || "Untitled list"}</div>
                    <div className="home-row-sub">
                      {list.tabs.length} {list.tabs.length == 1 ? "item" : "items"}
                      {isSource(peeking) && ` · from ${domainOf(list.source?.url)}`}
                    </div>
                  </div>
                  <button className="home-chip" title="Search in this list" onClick={() => enterList(peeking)}>Search</button>
                  {list.tabs.some(isLink) && <button className="home-chip" onClick={() => { setPeek(null); openAll(peeking); }}>Open all</button>}
                </div>
                <motion.div className="home-peek-items" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { delay: 0.08 } }}>
                  {list.tabs.map((item, index) => (
                    <div key={`${index}:${itemKey(item)}`} className="home-row" onClick={() => { setPeek(null); openItem(peeking, index); }}>
                      <ItemIcon item={item} />
                      <div className="home-row-text">
                        <div className="home-row-title">{itemTitle(item)}</div>
                        <div className="home-row-sub">{itemSub(item)}</div>
                      </div>
                    </div>
                  ))}
                  {!list.tabs.length && (
                    <div className="home-empty">{isSource(peeking) ? "Nothing found yet. Refresh it from the lists below." : "Empty. Drop a tab here to save it."}</div>
                  )}
                </motion.div>
              </motion.div>
            );
          })()}
          {moreLists > 0 && places.length > 0 && (
            <button
              className="home-listbubble is-more"
              style={{ left: w / 2 + places[fits].x - 32, top: centerY + places[fits].y - 32, width: 64, height: 64 }}
              onClick={() => { setFilter("lists"); input.current?.focus(); }}
            >
              +{moreLists}
            </button>
          )}

          <div className={`home-box${open ? " is-open" : ""}`} style={{ top: centerY - 30, width: pillW }}>
            <div className="home-pill">
              <span className="home-pill-icon"><Icon name="search" /></span>
              {scopeList && (
                <button className="home-scopechip" title="Search everything (Backspace)" onClick={() => { setScope(null); input.current?.focus(); }}>
                  {scopeList.name || "Untitled"} <span>×</span>
                </button>
              )}
              <input
                ref={input}
                autoFocus
                className="home-input"
                placeholder={scopeList ? `Search ${scopeList.name}` : "Search tabs, lists, or the web"}
                value={query}
                spellCheck={false}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
              />
              {filter != "all" && !scopeList && (
                <button className="home-filterchip" title="Search everything" onClick={() => { setFilter("all"); input.current?.focus(); }}>
                  {filters.find(f => f.key == filter).label} <span>×</span>
                </button>
              )}
              {query.trim() && (
                <button className="home-iconbtn" title="Search the web" onClick={(e) => webSearch(query.trim(), e.metaKey || e.ctrlKey)}><Icon name="globe" /></button>
              )}
            </div>
            {open && (
              <div className="home-panel" ref={panel} style={{ maxHeight: Math.max(220, h - centerY - 60) }}>
                {!scopeList && (
                  <div className="home-filters">
                    {filters.map(f => (
                      <button
                        key={f.key}
                        className={`home-filter${filter == f.key ? " is-on" : ""}`}
                        onClick={() => { setFilter(f.key); input.current?.focus(); }}
                      >
                        {f.label}{counts[f.key] != null && <span>{counts[f.key]}</span>}
                      </button>
                    ))}
                  </div>
                )}
                <div className="home-results">
                  {sections.map(renderSection)}
                  {!rows.length && !scopeList && (
                    <div className="home-empty">{filter == "web" ? "Type to search the web" : `Nothing here matches “${query}”`}</div>
                  )}
                </div>
              </div>
            )}
            {!open && (
              <div className="home-tip">
                Click a list to look inside · drag a tab onto a list to save it · press / to search from anywhere
              </div>
            )}
          </div>

          <div
            className={`home-tabfield${open ? " is-quiet" : ""}`}
            style={{ top: fieldTop, width: fieldW, bottom: 64 }}
          >
            {shownTabs.filter(tab => !inResults.has(`tab-${tab.id}`)).map(tab => {
              const group = groups[tab.groupId];
              return (
                <motion.div
                  key={tab.id}
                  layoutId={`tab-${tab.id}`}
                  transition={spring}
                  className={`home-tabbubble${tab.windowId != self?.windowId ? " is-elsewhere" : ""}${group ? " is-grouped" : ""}`}
                  style={{
                    borderRadius: 999,
                    marginTop: Math.round(jitter(`${tab.id}m`, 8)) + 8,
                    "--group": group ? groupColors[group.color] : undefined,
                    "--float-delay": `${-(hashOf(tab.id) % 6000)}ms`,
                  }}
                >
                  <div
                    className="home-tabbubble-inner"
                    draggable
                    title={`${tab.title}\n${tab.url || tab.pendingUrl}${group?.title ? `\nIn group ${group.title}` : ""}\nDrag onto a list to save it`}
                    onClick={() => switchTo(tab)}
                    onDragStart={(e) => {
                      e.dataTransfer.setData(TAB_TYPE, String(tab.id));
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setDragImage(e.currentTarget.parentElement, 16, 16);
                    }}
                    onDragEnd={() => setDropTarget(null)}
                  >
                    <img className="home-favicon" src={faviconUrl(tab.url || tab.pendingUrl)} alt="" draggable={false} />
                    <span className="home-tabbubble-title">{tab.title || domainOf(tab.url)}</span>
                    <button className="home-tabbubble-close" title="Close tab" onClick={(e) => { e.stopPropagation(); closeTab(tab); }}>×</button>
                  </div>
                </motion.div>
              );
            })}
            {moreTabs > 0 && (
              <button className="home-tabbubble is-more" style={{ marginTop: 8 }} onClick={() => { setFilter("tabs"); input.current?.focus(); }}>
                +{moreTabs} more tabs
              </button>
            )}
          </div>

          <button
            className="home-down"
            title="Your lists, stacked"
            onClick={() => classic.current?.scrollIntoView({ behavior: "smooth" })}
          >
            <Icon name="down" />
          </button>

          {notice && <div key={notice.at} className="home-notice">{notice.text}</div>}
        </section>

        <section className="home-classic" ref={classic}>
          <Newtab
            embedded
            headerExtra={
              <button className="home-link is-small" onClick={() => { window.scrollTo({ top: 0, behavior: "smooth" }); input.current?.focus({ preventScroll: true }); }}>
                <Icon name="up" /> Search
              </button>
            }
          />
        </section>

        {editing && (
          <ItemEditor
            item={editing.item}
            isNew={false}
            readOnly={editing.readOnly}
            onSave={(item) => saveItem(editing, item)}
            onClose={() => setEditing(null)}
          />
        )}
      </div>
    </ChakraProvider>
  );
};

export default Home;
