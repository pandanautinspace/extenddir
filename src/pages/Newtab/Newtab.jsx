import React, { useCallback, useEffect, useRef, useState } from 'react';
import './Newtab.css';
import './Newtab.scss';
import { DragDropContext, Draggable, Droppable } from '@hello-pangea/dnd';
import { Badge, Box, Button, ButtonGroup, Card, CardBody, CardHeader, ChakraProvider, CloseButton, Editable, EditableInput, EditablePreview, Flex, Heading, Input, Menu, MenuButton, MenuDivider, MenuItem, MenuItemOption, MenuList, MenuOptionGroup, Spacer, Text, createStandaloneToast } from '@chakra-ui/react';
import { domainOf, isLink, itemText, ItemContent, ItemEditor, newItem } from './Items';
import { itemKey, sitePattern } from '../../sources/extract';
import { updateList } from '../../sources/lists';
import { bestLists, cluster, embed, namesFor, textOf } from '../../sources/similar';

// Storage layout: "__tab_lists" holds the ordered list ids, and each list id holds
// { name, tabs: [{ title, url, group? }], groups: { [groupId]: { title, color } }, view? }.
// Saved "tabs" can also be notes, images or pages (see Items.jsx), which carry a type.
// Like Chrome's tab groups, a group's tabs always sit next to each other.
// view is how the list shows: { size: "narrow" | "normal" | "wide", collapsed }.
// "__sources" holds the ordered ids of sources, kept the same way, which show beside the
// open tabs instead of among the lists, and are hidden while closed is set. Every source
// has a source (see sources/extract.js); a list with one is a source shown as a list, and
// can go back to being a source. Other keys starting with "__" are settings, like "__sync"
// (see Background/sync.js).
const loadLists = async () => {
  // the picker can add the first source before there are any lists
  const anything = (stored) => stored.__tab_lists || stored.__sources;
  let stored = await chrome.storage.local.get(null);
  if (!anything(stored)) {
    // lists saved by older versions live in sync storage
    stored = await chrome.storage.sync.get(null);
  }
  if (!anything(stored)) {
    return null;
  }
  const { __tab_lists: ids = [], __sources: sourceIds = [], ...rest } = stored;
  const lists = Object.fromEntries(Object.entries(rest).filter(([key]) => !key.startsWith("__")));
  return { ids, sourceIds, lists };
}

const saveLists = (lists, ids, sourceIds) => {
  return chrome.storage.local.set({ ...lists, "__tab_lists": ids, "__sources": sourceIds });
}

const toSaved = (tab) => ({ title: tab.title, url: tab.url || tab.pendingUrl });

const savedGroupOf = (tab) => tab.group ?? -1;

const unsourced = ({ sourced, ...item }) => item;

// Tabs opened from a list go back into it when they're closed (see Background/opened.js).
// Each is { tabId, listId, index, group?, groupInfo?, item }.
const rememberOpened = (tabs) => chrome.runtime.sendMessage({ type: "opened", tabs });

const forgetOpened = (tabIds) => chrome.runtime.sendMessage({ type: "forget-opened", tabIds });

// where a saved tab came from, to go back to, from its list and place in it
const openedFrom = (list, listId, index, tabId) => {
  const { group, ...item } = list.tabs[index];
  return { tabId, listId, index, ...(group != null && { group, groupInfo: list.groups?.[group] }), item };
}

const ago = (time) => {
  const minutes = Math.round((Date.now() - time) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} h ago`;
  return new Date(time).toLocaleDateString();
}

// how a source was last read (see Background/refresh.js)
const methodNames = {
  feed: "its feed", fetch: "downloading it", data: "reading the data in it",
  frame: "loading it out of sight", tab: "loading it in a tab",
};

const sourceStatus = (source) => [
  `From ${domainOf(source.url)}`,
  source.lastRefreshed && `refreshed ${ago(source.lastRefreshed)}`,
].filter(Boolean).join(" · ");

// the saved tab as part of group (-1 for none)
const withGroup = (tab, group) => {
  const { group: old, ...rest } = tab;
  return group == -1 ? rest : { ...rest, group };
}

// Split tabs into runs that share a group (-1 for ungrouped), so each run can be its own
// drop zone. There's always an ungrouped run at the end to drop into.
const segmentsOf = (tabs, groupOf) => {
  const segments = [];
  tabs.forEach((tab, index) => {
    const last = segments.at(-1);
    if (last && last.groupId == groupOf(tab)) last.tabs.push(tab);
    else segments.push({ groupId: groupOf(tab), start: index, tabs: [tab] });
  });
  if (segments.at(-1)?.groupId != -1) {
    segments.push({ groupId: -1, start: tabs.length, tabs: [] });
  }
  return segments;
}

// The page makes its own ChakraProvider, so its toasts come from outside it (and show in
// the provider's). A toast says what was done, with a button to undo it.
const { toast } = createStandaloneToast();

const tell = (title, undo) => toast({
  position: "bottom",
  duration: undo ? 10000 : 5000,
  render: ({ onClose }) => (
    <Flex align="center" gap={3} px={4} py={2} bgColor="gray.700" color="white" borderRadius="md" boxShadow="lg">
      <Text fontSize="sm">{title}</Text>
      {undo && (
        <Button size="xs" variant="outline" color="white" _hover={{ bgColor: "whiteAlpha.300" }} onClick={() => { undo(); onClose(); }}>
          Undo
        </Button>
      )}
    </Flex>
  ),
});

const sectionLabel = { fontSize: "xs", fontWeight: "bold", color: "gray.600", textTransform: "uppercase" };

// Layouts are remembered per browser: "layout" for the sources, "side" or "top", and
// "listsLayout" for the lists, "columns", "grid" or "stack".
const loadSetting = (key, fallback) => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

const saveSetting = (key, value) => {
  try {
    localStorage.setItem(key, value);
  } catch { }
}

// A list or source being dragged is only its header, as wide as a source, so it's easy to
// see where it'll land, and doesn't cover the drop zones around the one it's over.
const liftedList = { flex: "0 0 280px", w: "280px", alignSelf: "start" };

// a list's width in columns, by its size, and the narrowest a column of the grid gets
const listWidths = { narrow: 220, normal: 300, wide: 480 };
const gridCell = 300;

// Stack lists in cols columns for the grid, each its own drop zone. A list stays in the
// column it was dropped in (its view's column), when there are that many, and otherwise
// goes in the shortest, going by how many items the lists show.
const stackColumns = (ids, lists, cols) => {
  const columns = Array.from({ length: cols }, () => ({ ids: [], height: 0 }));
  for (const id of ids) {
    const { view, tabs } = lists[id];
    const shortest = columns.reduce((best, c, i) => c.height < columns[best].height ? i : best, 0);
    const column = columns[view?.column < cols ? view.column : shortest];
    column.ids.push(id);
    column.height += 2 + (view?.collapsed ? 0 : Math.min(tabs.length, 12));
  }
  return columns.map(c => c.ids);
}

// the width of the element given the returned ref, for laying things out in as many columns as fit
const useWidth = () => {
  const [width, updateWidth] = useState(0);
  const observer = useRef(null);
  observer.current ??= new ResizeObserver(([entry]) => updateWidth(entry.contentRect.width));
  const ref = useCallback((node) => {
    observer.current.disconnect();
    if (node) observer.current.observe(node);
  }, []);
  return [width, ref];
}

// macOS hides scrollbars by default, which makes the lists row look stuck
const visibleScrollbar = {
  "&::-webkit-scrollbar": { height: "10px" },
  "&::-webkit-scrollbar-thumb": { background: "var(--chakra-colors-gray-300)", borderRadius: "5px" },
};

// let a plain mouse wheel scroll the lists sideways, unless it's over a list that scrolls itself
const scrollSideways = (e) => {
  const body = e.target.closest(".chakra-card__body");
  if (body && body.scrollHeight > body.clientHeight) return;
  e.currentTarget.scrollLeft += e.deltaY;
}

// Chrome's tab group colors, in the order Chrome offers them
const groupColors = {
  grey: "gray.400", blue: "blue.500", red: "red.500", yellow: "yellow.400", green: "green.500",
  pink: "pink.400", purple: "purple.500", cyan: "cyan.500", orange: "orange.400",
};

const nextGroupColor = (color) => {
  const names = Object.keys(groupColors);
  return names[(names.indexOf(color) + 1) % names.length];
}

// Put moved tabs in front of the anchor tab (or at the end of the window when there's none),
// as part of groupId (-1 for none), so the page shows the drop right away instead of waiting for Chrome.
const placeTabs = (tabs, moved, anchorId, windowId, groupId) => {
  const rest = tabs.filter(t => !moved.includes(t));
  let at = rest.findIndex(t => t.id == anchorId);
  if (at == -1) at = rest.findLastIndex(t => t.windowId == windowId) + 1 || rest.length;
  rest.splice(at, 0, ...moved.map(t => ({ ...t, windowId, groupId })));
  return rest;
}

// Move a tab in front of the anchor tab, or to the end of the window when there's none.
// Chrome adds a tab to a group when it's moved into the group's middle and takes it out
// when it's moved outside, so group first, move, then undo any grouping the move caused.
const moveBefore = async (tabId, anchorId, windowId, groupId) => {
  if (groupId != -1) await chrome.tabs.group({ groupId, tabIds: tabId });
  let index = -1;
  if (anchorId != null) {
    const [tab, anchor] = await Promise.all([chrome.tabs.get(tabId), chrome.tabs.get(anchorId)]);
    index = tab.windowId == anchor.windowId && tab.index < anchor.index ? anchor.index - 1 : anchor.index;
  }
  await chrome.tabs.move(tabId, { windowId, index });
  if (groupId == -1 && (await chrome.tabs.get(tabId)).groupId != -1) await chrome.tabs.ungroup(tabId);
}

// selected highlights the card, faded dims cards riding along with another card's
// drag, kept dims a source's items that are in a list already, count badges the
// dragged card with how many tabs are moving, and returnsTo names the list an open tab
// goes back to when it's closed. children (the close button) only show on hover.
const TabCard = ({ tab, draggableProvider, selected, faded, kept, count, returnsTo, children, ...props }) => (
  <Card
    ref={draggableProvider.innerRef}
    {...draggableProvider.draggableProps}
    {...draggableProvider.dragHandleProps}
    data-group
    title={isLink(tab) ? tab.url || tab.pendingUrl : undefined}
    direction="row"
    px={2}
    py={isLink(tab) ? 1 : 2}
    gap={2}
    align={isLink(tab) ? "center" : "start"}
    position="relative"
    userSelect="none"
    bgColor={selected ? "blue.50" : undefined}
    boxShadow={selected ? "inset 0 0 0 2px var(--chakra-colors-blue-400)" : undefined}
    opacity={faded ? 0.4 : kept ? 0.55 : 1}
    {...props}
  >
    {count > 1 && (
      <Badge position="absolute" top="-8px" right="-8px" colorScheme="blue" variant="solid" borderRadius="full">{count}</Badge>
    )}
    <Box flex={1} minW={0}>
      <ItemContent item={tab} />
    </Box>
    {returnsTo && <Text fontSize="xs" color="gray.400" flexShrink={0} title={`Goes back to ${returnsTo} when it's closed`}>↩</Text>}
    <Box opacity={0} _groupHover={{ opacity: 1 }}>{children}</Box>
  </Card>
);

// A bar at the top of a list or source that shows after the pointer rests on it a moment,
// to drag it by. It goes in the header, which drags the list too, and stays while it's dragged.
const Grip = ({ dragging }) => (
  <Flex
    position="absolute"
    top={0}
    left="50%"
    transform="translateX(-50%)"
    w="64px"
    h="14px"
    align="center"
    justify="center"
    zIndex={1}
    title="Drag to move"
    opacity={dragging ? 1 : 0}
    transition="opacity 0.15s"
    _groupHover={{ opacity: 1, transitionDelay: "0.4s" }}
  >
    <Box w="36px" h="5px" borderRadius="full" bgColor="gray.400" _hover={{ bgColor: "gray.500" }} />
  </Flex>
);

// a small drop target that's outlined while something is being dragged
const DropPill = ({ droppableId, active, children, ...props }) => (
  <Droppable droppableId={droppableId}>
    {(droppableProvider, snapshot) => (
      <Flex
        ref={droppableProvider.innerRef}
        {...droppableProvider.droppableProps}
        align="center"
        flexShrink={0}
        h={7}
        px={3}
        fontSize="xs"
        fontWeight="semibold"
        color="gray.500"
        border="1px dashed"
        borderColor={snapshot.isDraggingOver ? "green.400" : active ? "gray.400" : "transparent"}
        borderRadius="full"
        bgColor={snapshot.isDraggingOver ? "green.50" : undefined}
        userSelect="none"
        {...props}
      >
        {children}
        {/* don't make room for the dropped card in here */}
        <Box w={0} h={0} overflow="hidden">{droppableProvider.placeholder}</Box>
      </Flex>
    )}
  </Droppable>
);

// A drop zone's placeholder makes room for what's dragged into it, which moves everything
// after it, and the drag library expects other drop zones to stay put. Where a zone sits
// beside others, only its own items make room, by sliding over, unless the drag started
// in it (and the placeholder holds the dragged item's place).
const placeholderIn = (droppableProvider, snapshot) => snapshot.draggingFromThisWith
  ? droppableProvider.placeholder
  : <Box w={0} h={0} overflow="hidden">{droppableProvider.placeholder}</Box>;

// embedded is the lists page under the home view (Home.jsx), stacked by default and with its
// own layout setting; headerExtra goes in its top bar.
const Newtab = ({ embedded = false, headerExtra = null }) => {
  let [tabs, updateTabs] = useState([]);
  let [tabLists, updateTabLists] = useState({
    "readlater": { "name": "Read Later", "tabs": [], "groups": {} }
  });
  let [tabListIds, updateTabListIds] = useState(["readlater"]);
  let [groups, updateGroups] = useState({});
  let [selected, updateSelected] = useState([]);
  let [lastClicked, updateLastClicked] = useState(null);
  let [dragging, updateDragging] = useState(null);
  let [query, updateQuery] = useState("");
  let [collapsedWindows, updateCollapsedWindows] = useState([]);
  let [sourceIds, updateSourceIds] = useState([]);
  let [layout, updateLayout] = useState(() => loadSetting("layout", "side"));
  const listsLayoutKey = embedded ? "homeListsLayout" : "listsLayout";
  let [listsLayout, updateListsLayout] = useState(() => loadSetting(listsLayoutKey, embedded ? "stack" : "columns"));
  // the list or source being dragged by its header, and whether the pointer is over the sources
  let [draggingList, updateDraggingList] = useState(null);
  let [overSources, updateOverSources] = useState(false);
  // the note, image or page open in the editor: { listId, index, item }, with no index for a new one
  let [editing, updateEditing] = useState(null);
  // lists being refreshed from their sources
  let [refreshing, updateRefreshing] = useState([]);
  // the list each open tab goes back to when it's closed, by tab id (see rememberOpened)
  let [opened, updateOpened] = useState({});
  // what's being sorted by topic: window ids, and source ids
  let [sorting, updateSorting] = useState([]);
  // whether the lists sync through Chrome, and how the last sync went (see Background/sync.js)
  let [syncing, updateSyncing] = useState(false);
  let [syncStatus, updateSyncStatus] = useState(null);

  // the top layout lays tabs out in as many columns as fit, and so do lists in the grid and stack
  const [topWidth, topPanel] = useWidth();
  const [listsWidth, listsPanel] = useWidth();
  const cols = layout == "top" ? Math.max(1, Math.floor((topWidth + 8) / 248)) : undefined;
  // While a list is dragged, the lists keep the columns they had, since the drag library
  // can't have drop zones change under it, and the grid's rows are drop zones.
  const listsCols = useRef(null);
  if (!draggingList) {
    listsCols.current = {
      grid: Math.max(1, Math.floor((listsWidth + 12) / (gridCell + 12))),
      stack: Math.max(1, Math.floor((listsWidth - 24 + 8) / 248)),
    };
  }
  const gridCols = listsCols.current.grid;

  const changeLayout = (layout) => {
    updateLayout(layout);
    saveSetting("layout", layout);
  }

  const changeListsLayout = (layout) => {
    updateListsLayout(layout);
    saveSetting(listsLayoutKey, layout);
  }

  const refresh = () => {
    chrome.tabs.query({}).then(updateTabs);
    chrome.tabGroups.query({}).then(gs => updateGroups(Object.fromEntries(gs.map(g => [g.id, g]))));
  }

  let [currentWindow, updateCurrentWindow] = useState(chrome.windows.WINDOW_ID_CURRENT);

  useEffect(() => {
    refresh();
    chrome.windows.getCurrent().then(x => updateCurrentWindow(x.id));

    loadLists().then((result) => {
      if (result === null) {
        console.log("No lists in storage, creating defaults...")
        saveLists(tabLists, tabListIds, []);
      }
      else {
        updateTabLists(result.lists);
        updateTabListIds(result.ids);
        updateSourceIds(result.sourceIds);
        saveLists(result.lists, result.ids, result.sourceIds);
      }
    })
    // the picker and refreshes change lists and sources from elsewhere
    chrome.storage.onChanged.addListener((changes, area) => area == "local" && loadLists().then(result => {
      if (!result) return;
      updateTabLists(result.lists);
      updateTabListIds(result.ids);
      updateSourceIds(result.sourceIds);
    }));
    chrome.storage.session.get(["opened", "syncStatus"]).then(({ opened = {}, syncStatus = null }) => {
      updateOpened(opened);
      updateSyncStatus(syncStatus);
    });
    chrome.storage.local.get("__sync").then(({ __sync }) => updateSyncing(!!__sync?.enabled));
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area == "session" && changes.opened) updateOpened(changes.opened.newValue ?? {});
      if (area == "session" && changes.syncStatus) updateSyncStatus(changes.syncStatus.newValue ?? null);
      if (area == "local" && changes.__sync) updateSyncing(!!changes.__sync.newValue?.enabled);
    });
    chrome.tabs.onUpdated.addListener(refresh);
    chrome.tabs.onMoved.addListener(refresh);
    chrome.tabs.onAttached.addListener(refresh);
    chrome.tabs.onCreated.addListener(refresh);
    chrome.tabs.onActivated.addListener(refresh);
    chrome.tabs.onDetached.addListener(refresh);
    chrome.tabs.onHighlighted.addListener(refresh);
    chrome.tabs.onRemoved.addListener(refresh);
    chrome.tabs.onReplaced.addListener(refresh);
    chrome.tabGroups.onCreated.addListener(refresh);
    chrome.tabGroups.onUpdated.addListener(refresh);
    chrome.tabGroups.onMoved.addListener(refresh);
    chrome.tabGroups.onRemoved.addListener(refresh);
    document.addEventListener("keydown", (e) => e.key == "Escape" && updateSelected([]));
  }, []);

  const setLists = (lists, ids, sources = sourceIds) => {
    // forget saved groups whose tabs are all gone
    lists = Object.fromEntries(Object.entries(lists).map(([listId, list]) => [listId, {
      ...list,
      groups: Object.fromEntries(Object.entries(list.groups ?? {})
        .filter(([groupId]) => list.tabs.some(t => t.group == groupId))),
    }]));
    updateTabLists(lists);
    updateTabListIds(ids);
    updateSourceIds(sources);
    return saveLists(lists, ids, sources);
  }

  const windowTabs = (windowId) => tabs.filter(tab => tab.windowId == windowId);

  // current window first, then the rest in the order Chrome returns them
  const windowIds = [...new Set(tabs.map(tab => tab.windowId))]
    .sort((a, b) => (b == currentWindow) - (a == currentWindow));

  const matches = (tab) => !query || itemText(tab).toLowerCase().includes(query.toLowerCase());

  const allSources = sourceIds.filter(id => tabLists[id]);
  const openSources = allSources.filter(id => !tabLists[id].closed);
  const isSource = (listId) => allSources.includes(listId);

  const sizeOf = (listId) => tabLists[listId].view?.size ?? "normal";
  // a search shows what it finds in collapsed lists too
  const isCollapsed = (listId) => !query && !!tabLists[listId].view?.collapsed;

  // what's in the lists already, to dim in the sources
  const keptKeys = new Set(tabListIds.flatMap(listId => tabLists[listId].tabs.map(itemKey)));

  // whether a window's or list's tab gets a card: it matches the search, and when
  // there's no search, its window and group aren't collapsed
  const isShown = (kind, where, tab) => matches(tab) && (query != "" || (kind == "OpenTabs"
    ? !collapsedWindows.includes(where) && !groups[tab.groupId]?.collapsed
    : !tabLists[where].groups?.[tab.group]?.collapsed));

  // Every shown tab card's draggable id in display order: open tabs are "<tabId>",
  // saved tabs and a source's items are "<listId>::<index>".
  const allIds = [
    ...windowIds.flatMap(windowId => windowTabs(windowId)
      .filter(tab => isShown("OpenTabs", windowId, tab)).map(tab => `${tab.id}`)),
    ...openSources.flatMap(sourceId => tabLists[sourceId].tabs
      .flatMap((tab, index) => matches(tab) ? [`${sourceId}::${index}`] : [])),
    ...tabListIds.filter(listId => !isCollapsed(listId)).flatMap(listId => tabLists[listId].tabs
      .flatMap((tab, index) => isShown("TabList", listId, tab) ? [`${listId}::${index}`] : [])),
  ];

  // each tab zone's shown draggable ids, and where a drop after all of them goes, and each
  // zone of lists' shown list ids and the list ids that come after them; filled in as the
  // page renders
  const zones = {};

  const itemFor = (id) => {
    if (!id.includes("::")) return { tab: tabs.find(t => `${t.id}` == id) };
    const [listId, index] = id.split("::");
    return { listId, index: Number(index), tab: tabLists[listId].tabs[Number(index)] };
  }

  // Group headers drag as "Group::<kind>::<where>::<groupId>", where kind and where are
  // "OpenTabs" and a window id, or "TabList" and a list id.
  const groupInfo = (kind, where, groupId) =>
    (kind == "OpenTabs" ? groups[groupId] : tabLists[where].groups?.[groupId]) ?? {};

  const groupTabIds = (groupDragId) => {
    const [, kind, where, groupId] = groupDragId.split("::");
    return kind == "OpenTabs"
      ? windowTabs(where).filter(t => t.groupId == groupId).map(t => `${t.id}`)
      : tabLists[where].tabs.flatMap((t, index) => savedGroupOf(t) == groupId ? [`${where}::${index}`] : []);
  }

  // the tab cards a drag of draggableId moves: a group's tabs, the selection, or just the one
  const movingWith = (draggableId) => {
    if (draggableId.startsWith("Group::")) return groupTabIds(draggableId);
    if (selected.includes(draggableId)) return allIds.filter(id => selected.includes(id));
    return [draggableId];
  }
  const draggingIds = dragging ? movingWith(dragging) : [];

  // cmd/ctrl-click toggles a tab in the selection and shift-click selects a range, like
  // Chrome's tab strip. Returns true when the click was a selection click.
  const selectClick = (e, id) => {
    if (e.metaKey || e.ctrlKey) {
      updateSelected(selected.includes(id) ? selected.filter(s => s != id) : [...selected, id]);
      updateLastClicked(id);
      return true;
    }
    if (e.shiftKey && allIds.includes(lastClicked)) {
      const [a, b] = [allIds.indexOf(lastClicked), allIds.indexOf(id)].sort((x, y) => x - y);
      updateSelected(allIds.slice(a, b + 1));
      return true;
    }
    updateSelected([]);
    updateLastClicked(id);
    return false;
  }

  const cardState = (id, snapshot) => ({
    selected: selected.includes(id),
    faded: dragging != id && draggingIds.includes(id),
    count: snapshot.isDragging ? draggingIds.length : 0,
  });

  // A list's drag shows where it can go before the drag library measures the page, so
  // the page doesn't move under it.
  const onBeforeCapture = ({ draggableId }) => {
    if (!draggableId.startsWith("List::")) return;
    const listId = draggableId.slice("List::".length);
    updateDraggingList(listId);
    updateOverSources(isSource(listId));
  }

  // While a list is dragged, the pointer says whether it's going among the sources or the
  // lists. The drag library goes by the list's middle, and when the list overlaps both, it
  // picks the one further from where the drag started, which is often the wrong one.
  const sourcesArea = useRef(null);
  useEffect(() => {
    if (!draggingList) return;
    const track = (e) => {
      const area = sourcesArea.current.getBoundingClientRect();
      updateOverSources(layout == "top" ? e.clientY < area.bottom : e.clientX < area.right);
    };
    window.addEventListener("mousemove", track);
    return () => window.removeEventListener("mousemove", track);
  }, [draggingList, layout]);

  const onDragStart = ({ draggableId, type }) => {
    if (type == "LIST") return;
    updateDragging(draggableId);
    if (!selected.includes(draggableId)) updateSelected([]);
  }

  const onDragEnd = ({ draggableId, destination, type }) => {
    updateDragging(null);
    updateDraggingList(null);
    if (!destination) return;
    if (type == "LIST") {
      placeList(draggableId.slice("List::".length), destination);
      return;
    }
    updateSelected([]);

    // tab zones are "<kind>::<where>::<start>::<groupId>::<row>"
    const [toKind, to, , toGroup = "-1"] = destination.droppableId.split("::");

    // notes, images and pages can't be tabs, so they stay in their lists when dropped on a window
    const toWindow = toKind == "OpenTabs" || toKind == "NewGroup";
    const movingIds = movingWith(draggableId).filter(id => !toWindow || isLink(itemFor(id).tab));
    if (!movingIds.length) return;
    const moving = movingIds.map(itemFor);
    const openTabs = moving.filter(m => !m.listId).map(m => m.tab);

    // a dragged group stays a group, unless it's dropped into another group
    let keepGroup = null;
    if (draggableId.startsWith("Group::") && toGroup == -1) {
      const [, kind, where, groupId] = draggableId.split("::");
      const { title = "", color = "grey" } = groupInfo(kind, where, groupId);
      keepGroup = { title, color };
    }

    // everything goes in front of the first tab at the drop point that isn't moving
    const following = toKind == "OpenTabs" ? windowTabs(to).map(t => `${t.id}`)
      : toKind == "TabList" ? tabLists[to].tabs.map((_, index) => `${to}::${index}`) : [];
    const zone = zones[destination.droppableId];
    const target = zone?.shown.filter(id => id != draggableId)[destination.index];
    const anchor = following.slice(target ? following.indexOf(target) : zone?.end)
      .find(id => !movingIds.includes(id));

    // saved tabs leave their lists wherever they go, but sources keep theirs
    const lists = Object.fromEntries(Object.entries(tabLists).map(([listId, list]) =>
      [listId, isSource(listId) ? list : { ...list, tabs: list.tabs.filter((_, index) => !movingIds.includes(`${listId}::${index}`)) }]));
    let ids = tabListIds;

    if (toWindow) {
      const windowId = Number(to);
      if (toKind == "OpenTabs") {
        updateTabs(placeTabs(tabs, openTabs, Number(anchor), windowId, Number(toGroup)));
      }
      (async () => {
        const tabIds = [];
        const fromLists = [];
        for (const m of moving) {
          if (!m.listId) {
            tabIds.push(m.tab.id);
            continue;
          }
          const { id } = await chrome.tabs.create({ active: false, url: m.tab.url, windowId });
          tabIds.push(id);
          if (!isSource(m.listId)) fromLists.push(openedFrom(tabLists[m.listId], m.listId, m.index, id));
        }
        await rememberOpened(fromLists);
        if (toKind == "OpenTabs") {
          // last to first, each in front of the one placed before it
          let before = anchor && Number(anchor);
          for (const tabId of [...tabIds].reverse()) {
            await moveBefore(tabId, before, windowId, Number(toGroup));
            before = tabId;
          }
        }
        if (toKind == "NewGroup" || keepGroup) {
          const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
          if (keepGroup) await chrome.tabGroups.update(groupId, keepGroup);
        }
      })();
    } else {
      let listId = to;
      if (toKind == "NewList") {
        listId = crypto.randomUUID();
        lists[listId] = { "name": "New List!", "tabs": [], "groups": {} };
        ids = [...ids, listId];
      }
      let group = toGroup;
      if (keepGroup) {
        group = crypto.randomUUID();
        lists[listId].groups = { ...lists[listId].groups, [group]: keepGroup };
      }
      const at = anchor ? lists[listId].tabs.indexOf(itemFor(anchor).tab) : lists[listId].tabs.length;
      // items from a list's source become yours when they move to another list
      const saved = (m) => !m.listId ? toSaved(m.tab) : m.listId == listId ? m.tab : unsourced(m.tab);
      lists[listId].tabs.splice(at, 0, ...moving.map(m => withGroup(saved(m), group)));
      if (openTabs.length) {
        // they're in a list now, so they don't go back to one they were opened from
        const closing = openTabs.map(t => t.id);
        forgetOpened(closing).then(() => chrome.tabs.remove(closing));
        updateTabs(tabs.filter(t => !openTabs.includes(t)));
      }
    }
    setLists(lists, ids);
  }

  const addList = () => {
    const listId = crypto.randomUUID();
    setLists({ ...tabLists, [listId]: { "name": "New List!", "tabs": [], "groups": {} } }, [...tabListIds, listId]);
  }

  const removeList = (listId) => {
    const { [listId]: removed, ...lists } = tabLists;
    setLists(lists, tabListIds.filter(id => id != listId), sourceIds.filter(id => id != listId));
    chrome.storage.local.remove(listId);
  }

  // Put a list or source where its header was dropped: among the sources, where only
  // lists with a source can go, or among the lists. It goes in front of the list now at
  // the drop point, or of the first list after the zone, and in the grid, in its column.
  const placeList = (listId, destination) => {
    const ids = tabListIds.filter(id => id != listId);
    const sources = sourceIds.filter(id => id != listId);
    const into = destination.droppableId == "Sources" ? sources : ids;
    const zone = zones[destination.droppableId];
    const before = zone.shown.filter(id => id != listId)[destination.index] ?? zone.following.find(id => id != listId);
    into.splice(before ? into.indexOf(before) : into.length, 0, listId);
    let { closed, ...list } = tabLists[listId];
    if (listsLayout == "grid" && destination.droppableId.startsWith("Lists::")) {
      list = { ...list, view: { ...list.view, column: Number(destination.droppableId.split("::")[1]) } };
    }
    setLists({ ...tabLists, [listId]: list }, ids, sources);
  }

  const moveList = (listId, toStart) => {
    const rest = tabListIds.filter(id => id != listId);
    setLists(tabLists, toStart ? [listId, ...rest] : [...rest, listId]);
  }

  const toSources = (listId) => setLists(tabLists, tabListIds.filter(id => id != listId), [...sourceIds, listId]);

  const toLists = (sourceId) => {
    const { closed, ...list } = tabLists[sourceId];
    setLists({ ...tabLists, [sourceId]: list }, [...tabListIds, sourceId], sourceIds.filter(id => id != sourceId));
  }

  // Show just the sources in ids. One that's switched on scrolls into view, in case it's
  // past the sources that fit.
  const showSources = async (ids) => {
    const lists = { ...tabLists };
    for (const sourceId of allSources) {
      const { closed, ...source } = tabLists[sourceId];
      lists[sourceId] = ids.includes(sourceId) ? source : { ...source, closed: true };
    }
    await setLists(lists, tabListIds);
    const opened = ids.find(id => tabLists[id].closed);
    document.querySelector(`[data-rfd-draggable-id="List::${opened}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  }

  const hideSource = (sourceId) => showSources(openSources.filter(id => id != sourceId));

  const changeView = (listId, changes) => {
    const list = tabLists[listId];
    setLists({ ...tabLists, [listId]: { ...list, view: { ...list.view, ...changes } } }, tabListIds);
  }

  const renameList = (listId, name) => {
    setLists({ ...tabLists, [listId]: { ...tabLists[listId], name } }, tabListIds);
  }

  // links open here and leave the list, until the tab's closed; anything else opens in the
  // editor. A source keeps its items, and they open in the editor only to be looked at.
  const openSaved = async (listId, index) => {
    const lists = structuredClone(tabLists);
    const item = lists[listId].tabs[index];
    if (!isLink(item)) {
      updateEditing({ listId, index, item, readOnly: isSource(listId) });
      return;
    }
    if (isSource(listId)) {
      chrome.tabs.update({ url: item.url });
      return;
    }
    const [saved] = lists[listId].tabs.splice(index, 1);
    const { id: tabId } = await chrome.tabs.getCurrent();
    await rememberOpened([openedFrom(tabLists[listId], listId, index, tabId)]);
    await setLists(lists, tabListIds);
    chrome.tabs.update({ url: saved.url });
  }

  // Open a list's links at positions (all of them by default) as tabs at the end of this
  // window, with a list's group as a tab group, out of the list until they're closed.
  const openAll = async (listId, positions) => {
    const list = tabLists[listId];
    positions = (positions ?? list.tabs.map((_, index) => index)).filter(index => isLink(list.tabs[index]));
    if (!positions.length) return;
    const { id: windowId } = await chrome.windows.getCurrent();
    await setLists({ ...tabLists, [listId]: { ...list, tabs: list.tabs.filter((_, index) => !positions.includes(index)) } }, tabListIds);
    const fromList = [];
    for (const index of positions) {
      const { id } = await chrome.tabs.create({ active: false, url: list.tabs[index].url, windowId });
      fromList.push(openedFrom(list, listId, index, id));
    }
    await rememberOpened(fromList);
    for (const group of new Set(fromList.map(o => o.group).filter(group => group != null))) {
      const { title = "", color = "grey" } = list.groups?.[group] ?? {};
      const tabIds = fromList.filter(o => o.group == group).map(o => o.tabId);
      await chrome.tabGroups.update(await chrome.tabs.group({ tabIds, createProperties: { windowId } }), { title, color });
    }
  }

  // put an edited item back where it was, or add a new one to the end of its list;
  // edited items from a list's source are yours, so a refresh leaves them be
  const saveItem = ({ listId, index }, item) => {
    item = unsourced(item);
    const list = tabLists[listId];
    const tabs = index == null ? [...list.tabs, item] : list.tabs.map((t, i) => i == index ? item : t);
    setLists({ ...tabLists, [listId]: { ...list, tabs } }, tabListIds);
  }

  const removeSaved = (listId, index) => {
    const list = tabLists[listId];
    setLists({ ...tabLists, [listId]: { ...list, tabs: list.tabs.filter((_, i) => i != index) } }, tabListIds);
  }

  // The background reads each source and stores the new items, which show up here as
  // they're stored; it reads one at a time, and each list stops spinning when it's done.
  // Reading a site needs permission, asked for all the sites at once since only the click
  // can ask. Anything that goes wrong shows on the list, like a failed refresh does, and is
  // stored on that list alone, so it can't undo another list's refresh.
  const refreshLists = async (listIds) => {
    listIds = listIds.filter(id => tabLists[id]?.source && !refreshing.includes(id));
    if (!listIds.length) return;
    updateRefreshing(ids => [...ids, ...listIds]);
    const failed = (listId, message) =>
      updateList(listId, list => ({ ...list, source: { ...list.source, error: message } }));
    let allowed = false;
    try {
      allowed = await chrome.permissions.request({ origins: [...new Set(listIds.map(id => sitePattern(tabLists[id].source.url)))] });
    } catch { }
    await Promise.all(listIds.map(async (listId) => {
      try {
        if (!allowed) throw new Error(`extenddir doesn't have permission to read ${domainOf(tabLists[listId].source.url)}`);
        await chrome.runtime.sendMessage({ type: "refresh", listId });
      } catch (error) {
        await failed(listId, error.message);
      } finally {
        updateRefreshing(ids => ids.filter(id => id != listId));
      }
    }));
  }

  const refreshList = (listId) => refreshLists([listId]);

  // runs a sort by topic for what (window or source ids), showing them busy meanwhile
  const sortingFor = async (what, sort) => {
    updateSorting(ids => [...ids, ...what]);
    try {
      await sort();
    } catch (error) {
      tell(`Couldn't sort: ${error.message}`);
    } finally {
      updateSorting(ids => ids.filter(id => !what.includes(id)));
    }
  }

  // Group a window's tabs by topic (see sources/similar.js). Tabs join the groups they're
  // like, and tabs like each other but no group make new groups, named for what they share.
  // Pinned tabs and ones without a page stay where they are. Undo puts tabs back where they were.
  const groupByTopic = (windowId) => sortingFor([windowId], async () => {
    const candidates = windowTabs(windowId).filter(t => !t.pinned && /^(https?|file):/.test(t.url || t.pendingUrl || ""));
    const texts = candidates.map(textOf);
    const vectors = await embed(texts);
    const groupIds = [...new Set(candidates.map(t => t.groupId).filter(g => g != -1))];
    const found = cluster(vectors, groupIds.map(g => candidates.flatMap((t, i) => t.groupId == g ? [i] : [])));
    const made = found.filter(g => !g.fixed);
    const names = await namesFor(made.map(g => g.members), texts, vectors);
    const before = windowTabs(windowId).map(t => ({ id: t.id, index: t.index })).sort((a, b) => a.index - b.index);
    const usedColors = new Set(groupIds.map(g => groups[g]?.color));
    const colors = [...Object.keys(groupColors).filter(c => !usedColors.has(c)), ...Object.keys(groupColors)];
    const grouped = [];
    for (const g of found) {
      const joining = g.members.filter(i => candidates[i].groupId == -1).map(i => candidates[i].id);
      if (!joining.length) continue;
      if (g.fixed) {
        await chrome.tabs.group({ groupId: candidates[g.members.find(i => candidates[i].groupId != -1)].groupId, tabIds: joining });
      } else {
        const groupId = await chrome.tabs.group({ tabIds: joining, createProperties: { windowId } });
        await chrome.tabGroups.update(groupId, { title: names[made.indexOf(g)], color: colors[made.indexOf(g) % colors.length] });
      }
      grouped.push(...joining);
    }
    if (!grouped.length) {
      tell("No tabs here are about the same thing as others");
      return;
    }
    tell(`Grouped ${grouped.length} tabs`, async () => {
      await chrome.tabs.ungroup(grouped).catch(() => { });
      for (const { id, index } of before) await chrome.tabs.move(id, { index }).catch(() => { });
    });
  });

  // Copy the sources' items into the lists they're like, by the lists' names and what's in
  // them (see sources/similar.js). Items already in a list are left out, and so are lists
  // with no items and no name of their own. Undo takes the copies out again.
  const sortIntoLists = (fromIds) => sortingFor(fromIds, async () => {
    const named = (list) => !!list.name && !/^new list/i.test(list.name);
    const targets = tabListIds.filter(id => named(tabLists[id]) || tabLists[id].tabs.length);
    const seen = new Set(keptKeys);
    // a word or two (a name, "Clip") says too little to go by
    const items = fromIds.flatMap(id => tabLists[id].tabs)
      .filter(item => textOf(item).split(" ").length >= 3 && !seen.has(itemKey(item)) && seen.add(itemKey(item)));
    if (!targets.length || !items.length) {
      tell(targets.length ? "Everything in these sources is in a list already" : "There are no lists to sort into");
      return;
    }
    // the hundred latest items in each list are plenty to say what it's about
    const listItems = targets.map(id => tabLists[id].tabs.slice(-100).map(textOf).filter(Boolean));
    const texts = [...items.map(textOf), ...targets.map(id => tabLists[id].name ?? ""), ...listItems.flat()];
    const vectors = await embed(texts);
    let at = items.length + targets.length;
    const lists = targets.map((id, i) => {
      const own = vectors.slice(at, at += listItems[i].length);
      return { name: named(tabLists[id]) ? vectors[items.length + i] : null, items: own };
    });
    const best = bestLists(vectors.slice(0, items.length), lists);
    const added = {};
    best.forEach((index, i) => index != -1 && (added[targets[index]] ??= []).push(unsourced(items[i])));
    const listIds = Object.keys(added);
    if (!listIds.length) {
      tell("Nothing in these sources is like what's in your lists");
      return;
    }
    const sorted = { ...tabLists };
    listIds.forEach(id => sorted[id] = { ...sorted[id], tabs: [...sorted[id].tabs, ...added[id]] });
    await setLists(sorted, tabListIds);
    const count = listIds.reduce((n, id) => n + added[id].length, 0);
    tell(`Copied ${count} ${count == 1 ? "item" : "items"} into ${listIds.map(id => tabLists[id].name).join(", ")}`, () =>
      listIds.forEach(id => {
        const keys = new Set(added[id].map(itemKey));
        updateList(id, list => ({ ...list, tabs: list.tabs.filter(t => !keys.has(itemKey(t))) }));
      }));
  });

  const toggleWindow = (windowId) => updateCollapsedWindows(collapsedWindows.includes(windowId)
    ? collapsedWindows.filter(id => id != windowId) : [...collapsedWindows, windowId]);

  const updateSavedGroup = (listId, groupId, changes) => {
    const list = tabLists[listId];
    const groups = { ...list.groups, [groupId]: { ...list.groups[groupId], ...changes } };
    setLists({ ...tabLists, [listId]: { ...list, groups } }, tabListIds);
  }

  // rename, recolor, collapse and ungroup for a window's tab groups or a list's saved groups
  const groupActions = (kind, where) => kind == "OpenTabs" ? {
    rename: (groupId, title) => chrome.tabGroups.update(Number(groupId), { title }),
    recolor: (groupId, color) => chrome.tabGroups.update(Number(groupId), { color }),
    collapse: (groupId, collapsed) => chrome.tabGroups.update(Number(groupId), { collapsed }),
    ungroup: (groupId) => chrome.tabs.ungroup(groupTabIds(`Group::${kind}::${where}::${groupId}`).map(Number)),
  } : {
    open: (groupId) => openAll(where, tabLists[where].tabs.flatMap((t, index) => t.group == groupId ? [index] : [])),
    rename: (groupId, title) => updateSavedGroup(where, groupId, { title }),
    recolor: (groupId, color) => updateSavedGroup(where, groupId, { color }),
    collapse: (groupId, collapsed) => updateSavedGroup(where, groupId, { collapsed }),
    ungroup: (groupId) => {
      const list = tabLists[where];
      const tabs = list.tabs.map(t => t.group == groupId ? withGroup(t, -1) : t);
      setLists({ ...tabLists, [where]: { ...list, tabs } }, tabListIds);
    },
  };

  // Drop zones for a window's or a list's tabs: one per run of tabs in the same group,
  // and each group gets a header that drags the whole group. With cols, a run wraps into
  // rows of that many cards, each row its own zone, since the drag library can't do grids.
  const tabZones = (kind, where, items, groupOf, renderCard, cols) => {
    const idAt = (position) => kind == "OpenTabs" ? `${items[position].id}` : `${where}::${position}`;
    const segments = segmentsOf(items, groupOf);
    const actions = groupActions(kind, where);
    return segments.map((segment, segmentIndex) => {
      const last = segmentIndex == segments.length - 1;
      const end = segment.start + segment.tabs.length;
      const positions = segment.tabs.map((_, index) => segment.start + index)
        .filter(position => isShown(kind, where, items[position]));
      // a search leaves out runs without matches, but keeps the last one to drop into
      if (query && !positions.length && !last) return null;
      const rows = [];
      for (let i = 0; i < positions.length; i += cols ?? Infinity) rows.push(positions.slice(i, i + (cols ?? Infinity)));
      if (!rows.length) rows.push([]);
      const zone = (
        <Flex direction="column" gap={2} flex={1}>
          {rows.map((row, rowIndex) => {
            const droppableId = `${kind}::${where}::${segment.start}::${segment.groupId}::${rowIndex}`;
            zones[droppableId] = { shown: row.map(idAt), end: rowIndex == rows.length - 1 ? end : row.at(-1) + 1 };
            return (
              <Droppable key={rowIndex} droppableId={droppableId} direction={cols ? "horizontal" : "vertical"}>
                {(droppableProvider, snapshot) => (
                  <Flex
                    ref={droppableProvider.innerRef}
                    {...droppableProvider.droppableProps}
                    direction={cols ? "row" : "column"}
                    gap={cols ? 2 : 1}
                    minH={2}
                    flex={cols ? undefined : 1}
                    borderRadius="md"
                    bgColor={snapshot.isDraggingOver ? "green.50" : undefined}
                    sx={cols && { "& > *": { flex: `0 0 calc((100% - ${(cols - 1) * 8}px) / ${cols})`, minW: 0 } }}
                  >
                    {row.map((position, index) => renderCard(items[position], index, position))}
                    {droppableProvider.placeholder}
                  </Flex>
                )}
              </Droppable>
            );
          })}
        </Flex>
      );
      if (segment.groupId == -1) {
        // the last zone stretches so the rest of a list is a drop target
        return <Flex key={segment.start} direction="column" flex={last ? 1 : undefined} mb={1}>{zone}</Flex>;
      }
      const group = groupInfo(kind, where, segment.groupId);
      const groupDragId = `Group::${kind}::${where}::${segment.groupId}`;
      return (
        <Box key={segment.start} mb={1} pl={2} borderLeft="3px solid" borderColor={groupColors[group.color] ?? "gray.400"}>
          <Droppable droppableId={`Header::${groupDragId}`} isDropDisabled>
            {(headerProvider) => (
              <Box ref={headerProvider.innerRef} {...headerProvider.droppableProps}>
                <Draggable draggableId={groupDragId} index={0}>
                  {(draggableProvider, snapshot) => (
                    <Flex
                      ref={draggableProvider.innerRef}
                      {...draggableProvider.draggableProps}
                      {...draggableProvider.dragHandleProps}
                      data-group
                      align="center"
                      gap={2}
                      mb={1}
                      px={1}
                      borderRadius="md"
                      userSelect="none"
                      cursor="grab"
                      bgColor={snapshot.isDragging ? "white" : undefined}
                      boxShadow={snapshot.isDragging ? "md" : undefined}
                    >
                      <Box
                        as="button"
                        title={group.collapsed ? "Expand" : "Collapse"}
                        w={3}
                        flexShrink={0}
                        fontSize="xs"
                        color="gray.500"
                        onClick={() => actions.collapse(segment.groupId, !group.collapsed)}
                      >
                        {group.collapsed ? "▸" : "▾"}
                      </Box>
                      <Box
                        as="button"
                        title="Change color"
                        boxSize="10px"
                        flexShrink={0}
                        borderRadius="full"
                        bgColor={groupColors[group.color] ?? "gray.400"}
                        onClick={() => actions.recolor(segment.groupId, nextGroupColor(group.color))}
                      />
                      <Editable
                        key={group.title}
                        defaultValue={group.title}
                        placeholder="Unnamed group"
                        fontSize="sm"
                        fontWeight="semibold"
                        onSubmit={(title) => actions.rename(segment.groupId, title)}
                      >
                        {/* a button, so clicking the name edits it instead of starting a drag */}
                        <EditablePreview as="button" cursor="text" />
                        <EditableInput />
                      </Editable>
                      <Spacer />
                      {snapshot.isDragging
                        ? <Badge colorScheme="blue" variant="solid" borderRadius="full">{draggingIds.length}</Badge>
                        : <>
                          {actions.open && (
                            <Button size="xs" variant="ghost" opacity={0} _groupHover={{ opacity: 1 }} title="Open this group's tabs in this window" onClick={() => actions.open(segment.groupId)}>Open</Button>
                          )}
                          <Button size="xs" variant="ghost" opacity={0} _groupHover={{ opacity: 1 }} onClick={() => actions.ungroup(segment.groupId)}>Ungroup</Button>
                          <Text fontSize="xs" color="gray.500">{segment.tabs.length}</Text>
                        </>}
                    </Flex>
                  )}
                </Draggable>
                {headerProvider.placeholder}
              </Box>
            )}
          </Droppable>
          {zone}
        </Box>
      );
    });
  }

  const openTabs = windowIds.map((windowId, windowIndex) => {
    const collapsed = !query && collapsedWindows.includes(windowId);
    return (
      <Box key={windowId} mb={3}>
        <Flex align="center" gap={1} mb={1}>
          <Flex as="button" align="center" gap={1} {...sectionLabel} onClick={() => toggleWindow(windowId)}>
            <Box w={3} color="gray.500">{collapsed ? "▸" : "▾"}</Box>
            {windowId == currentWindow ? "This Window" : `Window ${windowIndex + 1}`}
          </Flex>
          <Text fontSize="xs" color="gray.500">{windowTabs(windowId).length}</Text>
          <Spacer />
          <Button
            size="xs"
            variant="ghost"
            title="Group this window's tabs by what they're about"
            isLoading={sorting.includes(windowId)}
            onClick={() => groupByTopic(windowId)}
          >
            Group by topic
          </Button>
        </Flex>
        {!collapsed && tabZones("OpenTabs", windowId, windowTabs(windowId), tab => tab.groupId, (tab, index) => (
          <Draggable
            index={index}
            key={tab.id}
            draggableId={`${tab.id}`}
          >
            {(draggableProvider, snapshot) => (
              <TabCard
                tab={tab}
                draggableProvider={draggableProvider}
                {...cardState(`${tab.id}`, snapshot)}
                returnsTo={tabLists[opened[tab.id]?.listId]?.name}
                onClick={(e) => selectClick(e, `${tab.id}`)}
              >
                <CloseButton size="sm" onClick={(e) => {
                  e.stopPropagation();
                  chrome.tabs.remove(tab.id);
                  updateTabs(tabs.filter(t => t.id != tab.id));
                }} />
              </TabCard>
            )}
          </Draggable>
        ), cols)}
        {!collapsed && (
          <DropPill droppableId={`NewGroup::${windowId}`} active={!!dragging} borderRadius="md" color="gray.400" title="Drop tabs here to group them">
            + New group
          </DropPill>
        )}
      </Box>
    );
  });

  // a list's or source's refresh button, and the line under its name about its source
  const refreshButton = (listId) => tabLists[listId].source && (
    <Button
      size="xs"
      variant="ghost"
      title={`Refresh from ${tabLists[listId].source.url}` +
        (tabLists[listId].source.method ? `\nLast read by ${methodNames[tabLists[listId].source.method]}` : "")}
      isLoading={refreshing.includes(listId)}
      onClick={() => refreshList(listId)}
    >
      ↻
    </Button>
  );

  const sourceLine = (listId) => tabLists[listId].source && (
    <Text fontSize="xs" color="gray.500" noOfLines={2}>
      {sourceStatus(tabLists[listId].source)}
      {tabLists[listId].source.error && (
        <Text as="span" color="red.500" title={tabLists[listId].source.error}> · couldn't refresh</Text>
      )}
    </Text>
  );

  const listName = (listId) => (
    <Heading size="sm" minW={0}>
      <Editable key={tabLists[listId].name} defaultValue={tabLists[listId].name} onSubmit={(name) => renameList(listId, name)}>
        {/* a button, so clicking the name edits it instead of starting a drag */}
        <EditablePreview as="button" cursor="text" textAlign="left" />
        <EditableInput />
      </Editable>
    </Heading>
  );

  const savedCard = (listId) => (tab, index, position) => (
    <Draggable
      index={index}
      key={`${listId}::${position}`}
      draggableId={`${listId}::${position}`}
    >
      {(draggableProvider, snapshot) => (
        <TabCard
          tab={tab}
          draggableProvider={draggableProvider}
          {...cardState(`${listId}::${position}`, snapshot)}
          cursor="pointer"
          onClick={(e) => selectClick(e, `${listId}::${position}`) || openSaved(listId, position)}
        >
          <CloseButton size="sm" title="Remove from list" onClick={(e) => {
            e.stopPropagation();
            removeSaved(listId, position);
          }} />
        </TabCard>
      )}
    </Draggable>
  );

  // how a list sits among the others, by the lists' layout and its size; a list being
  // dragged shrinks to its header, like a source's (see liftedList)
  const listPlacement = (listId) => {
    const size = sizeOf(listId);
    // (stacked lists lie the other way, so a basis would be its height)
    if (draggingList == listId) return listsLayout == "columns" ? liftedList : { w: "280px", maxW: "100%", alignSelf: "start", flexShrink: 0 };
    if (listsLayout != "columns") return { w: "100%", maxH: "60vh", flexShrink: 0 };
    // in columns, lists share the room left over in proportion to their widths
    if (isCollapsed(listId)) return { flex: "0 0 auto" };
    return { flex: `${listWidths[size]} 0 ${listWidths[size]}px` };
  }

  // how many columns a list's items go in: as many as fit in the stack, and two in a wide
  // list in columns
  const itemCols = (listId) => listsLayout == "stack" ? listsCols.current.stack
    : listsLayout == "columns" && sizeOf(listId) == "wide" ? 2 : undefined;

  const listCard = (listId, index) => {
    const list = tabLists[listId];
    const collapsed = isCollapsed(listId) || draggingList == listId;
    // a collapsed list in columns stands on its side, but not while it's dragged
    const sideways = isCollapsed(listId) && draggingList != listId && listsLayout == "columns";
    const collapseButton = (
      <Box
        as="button"
        title={collapsed ? "Expand" : "Collapse"}
        w={3}
        flexShrink={0}
        fontSize="xs"
        color="gray.500"
        onClick={() => changeView(listId, { collapsed: !collapsed })}
      >
        {collapsed ? "▸" : "▾"}
      </Box>
    );
    return (
      <Draggable key={listId} draggableId={`List::${listId}`} index={index}>
        {(draggableProvider, snapshot) => (
          <Card
            ref={draggableProvider.innerRef}
            {...draggableProvider.draggableProps}
            variant="filled"
            position="relative"
            data-group
            alignSelf={collapsed ? "start" : undefined}
            boxShadow={snapshot.isDragging ? "lg" : undefined}
            {...listPlacement(listId)}
          >
            <CardHeader py={2} px={sideways ? 2 : 3} cursor="grab" {...draggableProvider.dragHandleProps}>
              <Grip dragging={snapshot.isDragging} />
              {sideways ? (
                <Flex direction="column" align="center" gap={2}>
                  {collapseButton}
                  <Text fontSize="sm" fontWeight="bold" sx={{ writingMode: "vertical-rl" }}>{list.name}</Text>
                  <Text fontSize="xs" color="gray.500">{list.tabs.length}</Text>
                </Flex>
              ) : (
                <>
                  <Flex align="center" gap={2}>
                    {collapseButton}
                    {listName(listId)}
                    <Text fontSize="xs" color="gray.500">{list.tabs.length}</Text>
                    <Spacer />
                    {refreshButton(listId)}
                    <Menu isLazy>
                      <MenuButton as={Button} size="xs" variant="ghost" title="Add to list">+</MenuButton>
                      <MenuList fontSize="sm" minW="120px">
                        {[["text", "Note"], ["image", "Image"], ["page", "Page"]].map(([type, name]) => (
                          <MenuItem key={type} onClick={() => updateEditing({ listId, item: newItem(type) })}>{name}</MenuItem>
                        ))}
                      </MenuList>
                    </Menu>
                    <Menu isLazy>
                      <MenuButton as={Button} size="xs" variant="ghost" title="Arrange">⋯</MenuButton>
                      <MenuList fontSize="sm" minW="160px">
                        <MenuOptionGroup title="Width" type="radio" value={sizeOf(listId)} onChange={(size) => changeView(listId, { size })}>
                          <MenuItemOption value="narrow">Narrow</MenuItemOption>
                          <MenuItemOption value="normal">Normal</MenuItemOption>
                          <MenuItemOption value="wide">Wide</MenuItemOption>
                        </MenuOptionGroup>
                        <MenuDivider />
                        <MenuItem onClick={() => openAll(listId)}>Open all in this window</MenuItem>
                        <MenuDivider />
                        <MenuItem onClick={() => moveList(listId, true)}>Move to start</MenuItem>
                        <MenuItem onClick={() => moveList(listId, false)}>Move to end</MenuItem>
                        {list.source && <MenuItem onClick={() => toSources(listId)}>Move to sources</MenuItem>}
                        <MenuDivider />
                        <MenuItem color="red.600" onClick={() => removeList(listId)}>Delete list</MenuItem>
                      </MenuList>
                    </Menu>
                  </Flex>
                  {sourceLine(listId)}
                </>
              )}
            </CardHeader>
            {!collapsed && (
              <CardBody pt={0} px={3} minH={0} overflowY="auto" display="flex" flexDirection="column">
                {tabZones("TabList", listId, list.tabs, savedGroupOf, savedCard(listId), itemCols(listId))}
              </CardBody>
            )}
          </Card>
        )}
      </Draggable>
    );
  }

  // A source shows its items to drag into lists, which copies them, so nothing drops into it.
  // Its items are listed as they come, without groups.
  const sourceCard = (sourceId, index) => {
    const source = tabLists[sourceId];
    const shown = source.tabs.flatMap((tab, position) => matches(tab) ? [position] : []);
    return (
      <Draggable key={sourceId} draggableId={`List::${sourceId}`} index={index}>
        {(draggableProvider, snapshot) => (
          <Card
            ref={draggableProvider.innerRef}
            {...draggableProvider.draggableProps}
            variant="outline"
            position="relative"
            w="280px"
            flexShrink={0}
            data-group
            boxShadow={snapshot.isDragging ? "lg" : undefined}
            {...draggingList == sourceId && liftedList}
          >
            <CardHeader py={2} px={3} cursor="grab" {...draggableProvider.dragHandleProps}>
              <Grip dragging={snapshot.isDragging} />
              <Flex align="center" gap={2}>
                {listName(sourceId)}
                <Text fontSize="xs" color="gray.500">{source.tabs.length}</Text>
                <Spacer />
                {refreshButton(sourceId)}
                <Menu isLazy>
                  <MenuButton as={Button} size="xs" variant="ghost" title="More">⋯</MenuButton>
                  <MenuList fontSize="sm" minW="160px">
                    <MenuItem onClick={() => sortIntoLists([sourceId])}>Sort into lists</MenuItem>
                    <MenuItem onClick={() => toLists(sourceId)}>Show as a list</MenuItem>
                    <MenuDivider />
                    <MenuItem color="red.600" onClick={() => removeList(sourceId)}>Delete source</MenuItem>
                  </MenuList>
                </Menu>
                <CloseButton size="sm" title="Hide this source" onClick={() => hideSource(sourceId)} />
              </Flex>
              {sourceLine(sourceId)}
            </CardHeader>
            <CardBody pt={0} px={3} minH={0} overflowY="auto" display={draggingList == sourceId ? "none" : undefined}>
              <Droppable droppableId={`Source::${sourceId}`} isDropDisabled>
                {(droppableProvider) => (
                  <Flex ref={droppableProvider.innerRef} {...droppableProvider.droppableProps} direction="column" gap={1}>
                    {shown.map((position, index) => (
                      <Draggable key={position} draggableId={`${sourceId}::${position}`} index={index}>
                        {(draggableProvider, snapshot) => (
                          <TabCard
                            tab={source.tabs[position]}
                            draggableProvider={draggableProvider}
                            {...cardState(`${sourceId}::${position}`, snapshot)}
                            kept={keptKeys.has(itemKey(source.tabs[position]))}
                            cursor="pointer"
                            onClick={(e) => selectClick(e, `${sourceId}::${position}`) || openSaved(sourceId, position)}
                          />
                        )}
                      </Draggable>
                    ))}
                    {droppableProvider.placeholder}
                  </Flex>
                )}
              </Droppable>
            </CardBody>
          </Card>
        )}
      </Draggable>
    );
  }

  // Lists drop in one zone in columns and the stack, and in one per column in the grid.
  const listRows = listsLayout == "grid" ? stackColumns(tabListIds, tabLists, gridCols) : [tabListIds];

  const listZones = listRows.map((row, rowIndex) => {
    const droppableId = `Lists::${rowIndex}`;
    zones[droppableId] = { shown: row, following: row.length ? tabListIds.slice(tabListIds.indexOf(row.at(-1)) + 1) : [] };
    return (
      <Droppable
        key={rowIndex}
        droppableId={droppableId}
        type="LIST"
        direction={listsLayout == "columns" ? "horizontal" : "vertical"}
        isDropDisabled={!!draggingList && overSources}
      >
        {(droppableProvider, snapshot) => listsLayout == "columns" ? (
          <Flex
            ref={droppableProvider.innerRef}
            {...droppableProvider.droppableProps}
            gap={3}
            h="100%"
            pb={2}
            overflowX="scroll"
            onWheel={scrollSideways}
            sx={visibleScrollbar}
          >
            {row.map((listId, index) => listCard(listId, index))}
            {droppableProvider.placeholder}
          </Flex>
        ) : (
          <Flex
            ref={droppableProvider.innerRef}
            {...droppableProvider.droppableProps}
            direction="column"
            align="start"
            flex={1}
            minW={0}
            gap={3}
            minH="120px"
            pb={3}
          >
            {row.map((listId, index) => listCard(listId, index))}
            {droppableProvider.placeholder}
          </Flex>
        )}
      </Droppable>
    );
  });

  const lists = listsLayout == "grid" ? <Flex gap={3} minH="100%">{listZones}</Flex> : listZones;

  // only lists with a source can be dropped among the sources
  const sourcesDropDisabled = !!draggingList && !tabLists[draggingList]?.source;
  zones["Sources"] = { shown: openSources, following: [] };
  // The sources get a set width rather than their content's, since the cards that slide
  // over to make room for a dragged list would widen them and move the lists (see
  // placeholderIn). With none open, they lie over the open tabs, to drop a list on
  // without making room for them as the drag starts.
  const showSourcesDrop = !!draggingList && !sourcesDropDisabled;
  // The drag library only lets a list drop where the sources' scroller shows them, so it's
  // the scroller that lies over the open tabs.
  const sourcesPlace = openSources.length
    ? { w: `${openSources.length * 292 - 12 + 2}px`, flexShrink: 0 }
    : { flex: 1, align: "center", justify: "center", bgColor: showSourcesDrop ? "whiteAlpha.800" : undefined };
  const scrollerPlace = openSources.length
    ? { flex: "0 1 auto", minW: 0, pb: 2, overflowX: "auto" }
    : { position: "absolute", inset: 0, zIndex: 1, pointerEvents: "none" };

  const sources = (
    // Sources scroll sideways when there are more than fit: beside the lists, the open tabs
    // and sources take up to half the page (or the tabs and one source, if that's more), and
    // above them, they leave room for a column of open tabs.
    <Flex
      ref={sourcesArea}
      position="relative"
      gap={3}
      flex={layout == "top" ? undefined : "0 1 auto"}
      maxW={layout == "top" ? undefined : "max(50%, 574px)"}
      maxH={layout == "top" ? "45%" : undefined}
      minW={0}
      minH={0}
      flexShrink={layout == "top" ? 0 : 1}
    >
      <Box
        ref={topPanel}
        flex={layout == "top" ? 1 : undefined}
        flexShrink={0}
        minW={layout == "top" ? "248px" : 0}
        w={layout == "top" ? undefined : "280px"}
        p={2}
        overflowY="auto"
        overflowX="hidden"
        bgColor="gray.100"
        borderRadius="lg"
      >
        {openTabs}
      </Box>
      <Flex overflowY="hidden" onWheel={scrollSideways} sx={visibleScrollbar} {...scrollerPlace}>
        <Droppable droppableId="Sources" type="LIST" direction="horizontal" isDropDisabled={sourcesDropDisabled || !overSources}>
          {(droppableProvider, snapshot) => (
            <Flex
              ref={droppableProvider.innerRef}
              {...droppableProvider.droppableProps}
              gap={3}
              borderRadius="lg"
              border="1px dashed"
              borderColor={snapshot.isDraggingOver ? "green.400" : showSourcesDrop ? "gray.300" : "transparent"}
              {...sourcesPlace}
              bgColor={snapshot.isDraggingOver ? "green.50" : sourcesPlace.bgColor}
            >
              {openSources.map((sourceId, index) => sourceCard(sourceId, index))}
              {placeholderIn(droppableProvider, snapshot)}
              {showSourcesDrop && !openSources.length && (
                <Text fontSize="sm" color="gray.600">Drop here to make it a source</Text>
              )}
            </Flex>
          )}
        </Droppable>
      </Flex>
    </Flex>
  );

  return (
    <ChakraProvider>
      <Flex direction="column" gap={3} w="100%" h="100vh" p={3} bgColor="white">
        <Flex align="center" gap={3}>
          <Input
            size="sm"
            w="280px"
            flexShrink={0}
            borderRadius="full"
            bgColor="gray.100"
            border="none"
            placeholder="Search tabs"
            value={query}
            onChange={(e) => { updateQuery(e.target.value); updateSelected([]); }}
            onKeyDown={(e) => e.key == "Escape" && updateQuery("")}
          />
          {allSources.length > 0 && (
            <Menu closeOnSelect={false} isLazy>
              <MenuButton as={Button} size="sm" variant="outline" borderRadius="full" flexShrink={0}>
                Sources <Text as="span" color="gray.500" fontWeight="normal">{openSources.length} of {allSources.length} ▾</Text>
              </MenuButton>
              <MenuList fontSize="sm" maxH="60vh" overflowY="auto" minW="260px">
                <Flex px={3} pb={1} gap={2}>
                  <Button size="xs" variant="ghost" onClick={() => showSources(allSources)}>Show all</Button>
                  <Button size="xs" variant="ghost" onClick={() => showSources([])}>Hide all</Button>
                </Flex>
                <MenuDivider />
                <MenuOptionGroup type="checkbox" value={openSources} onChange={showSources}>
                  {allSources.map(sourceId => (
                    <MenuItemOption key={sourceId} value={sourceId}>
                      <Flex align="center" gap={2}>
                        <Text flex={1} minW={0} noOfLines={1}>{tabLists[sourceId].name}</Text>
                        <Text fontSize="xs" color="gray.500" flexShrink={0}>{tabLists[sourceId].tabs.length}</Text>
                      </Flex>
                      <Text fontSize="xs" color="gray.500" noOfLines={1}>{domainOf(tabLists[sourceId].source?.url)}</Text>
                    </MenuItemOption>
                  ))}
                </MenuOptionGroup>
              </MenuList>
            </Menu>
          )}
          {allSources.length > 0 && (
            <ButtonGroup size="sm" variant="outline" isAttached flexShrink={0}>
              <Button
                borderLeftRadius="full"
                title="Refresh the sources that are shown"
                isDisabled={!openSources.length}
                onClick={() => refreshLists(openSources)}
              >
                ↻ Refresh visible
              </Button>
              <Button borderRightRadius="full" title="Refresh every source, shown or not" onClick={() => refreshLists(allSources)}>
                Refresh all
              </Button>
            </ButtonGroup>
          )}
          {allSources.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              borderRadius="full"
              flexShrink={0}
              title="Copy items from every source into the lists they're like"
              isLoading={allSources.some(id => sorting.includes(id))}
              loadingText="Sorting"
              onClick={() => sortIntoLists(allSources)}
            >
              Sort into lists
            </Button>
          )}
          {allSources.some(id => refreshing.includes(id)) && (
            <Text fontSize="xs" color="gray.500" flexShrink={0}>
              Refreshing {allSources.filter(id => refreshing.includes(id)).length}…
            </Text>
          )}
          <Spacer />
          {headerExtra}
          <Menu isLazy>
            <MenuButton
              as={Button}
              size="xs"
              variant="ghost"
              flexShrink={0}
              color={syncStatus?.error ? "red.500" : undefined}
              title="Keep your lists in your Chrome profile, so they're on your other computers too"
            >
              {!syncing ? "Sync off" : syncStatus?.error ? "Sync failed" : syncStatus ? `Synced ${ago(syncStatus.at)}` : "Syncing…"}
            </MenuButton>
            <MenuList fontSize="sm" maxW="320px">
              <MenuOptionGroup type="checkbox" value={syncing ? ["on"] : []}
                onChange={(value) => chrome.runtime.sendMessage({ type: "sync", enabled: value.includes("on") })}>
                <MenuItemOption value="on">Sync lists through Chrome</MenuItemOption>
              </MenuOptionGroup>
              <Text px={3} py={1} fontSize="xs" color="gray.500">
                Your lists, and your sources without what they found, go to any computer signed in to Chrome with
                extension sync on, where this is switched on too. Chrome keeps 100 KB for them
                {syncStatus?.bytes != null && `, and ${Math.round(syncStatus.bytes / 1024)} KB is in use`}.
              </Text>
              {syncing && syncStatus?.error && <Text px={3} py={1} fontSize="xs" color="red.500">{syncStatus.error}</Text>}
            </MenuList>
          </Menu>
          <ButtonGroup size="xs" variant="outline" isAttached flexShrink={0} title="Where the open tabs and sources go">
            <Button isActive={layout == "side"} onClick={() => changeLayout("side")}>Sidebar</Button>
            <Button isActive={layout == "top"} onClick={() => changeLayout("top")}>Top</Button>
          </ButtonGroup>
        </Flex>
        <DragDropContext onBeforeCapture={onBeforeCapture} onDragStart={onDragStart} onDragEnd={onDragEnd}>
          <Flex direction={layout == "top" ? "column" : "row"} flex={1} gap={3} minH={0}>
            {sources}
            <Flex direction="column" flex={1} minW={0} minH={0}>
              <Flex align="center" gap={2} mb={2} wrap="wrap">
                <Text {...sectionLabel}>Lists</Text>
                <DropPill
                  droppableId="NewList"
                  active={!!dragging}
                  as="button"
                  title="Click, or drop tabs here"
                  _hover={{ bgColor: "gray.100" }}
                  onClick={addList}
                >
                  + New list
                </DropPill>
                <Spacer />
                <ButtonGroup size="xs" variant="outline" isAttached title="How the lists are laid out">
                  <Button isActive={listsLayout == "columns"} onClick={() => changeListsLayout("columns")}>Columns</Button>
                  <Button isActive={listsLayout == "grid"} onClick={() => changeListsLayout("grid")}>Grid</Button>
                  <Button isActive={listsLayout == "stack"} onClick={() => changeListsLayout("stack")}>Stack</Button>
                </ButtonGroup>
              </Flex>
              <Box ref={listsPanel} flex={1} minH={0} overflowY={listsLayout == "columns" ? undefined : "auto"} overflowX={listsLayout == "columns" ? undefined : "hidden"}>
                {lists}
              </Box>
            </Flex>
          </Flex>
        </DragDropContext>
      </Flex>
      {editing && (
        <ItemEditor
          item={editing.item}
          isNew={editing.index == null}
          readOnly={editing.readOnly}
          onSave={(item) => saveItem(editing, item)}
          onClose={() => updateEditing(null)}
        />
      )}
    </ChakraProvider>
  );
};

export default Newtab;
