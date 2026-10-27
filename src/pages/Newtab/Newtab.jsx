import React, { useEffect, useState } from 'react';
import './Newtab.css';
import './Newtab.scss';
import { DragDropContext, Draggable, Droppable } from '@hello-pangea/dnd';
import { Badge, Box, Button, Card, CardBody, CardHeader, ChakraProvider, CloseButton, Editable, EditableInput, EditablePreview, Flex, Heading, Image, Spacer, Text, VStack } from '@chakra-ui/react';

// Storage layout: "__tab_lists" holds the ordered list ids, and each list id
// holds { name, tabs: [{ title, url, favIconUrl }] }.
const loadLists = async () => {
  let stored = await chrome.storage.local.get(null);
  if (!stored.__tab_lists) {
    // lists saved by older versions live in sync storage
    stored = await chrome.storage.sync.get(null);
  }
  if (!stored.__tab_lists) {
    return null;
  }
  const { __tab_lists: ids, ...lists } = stored;
  return { ids, lists };
}

const saveLists = (lists, ids) => {
  return chrome.storage.local.set({ ...lists, "__tab_lists": ids });
}

const toSaved = (tab) => ({ title: tab.title, url: tab.url || tab.pendingUrl });

// Chrome's favicon cache; returns a default icon for pages without one
const faviconUrl = (url) => chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`);

const truncate = { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };

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

// selected highlights the card, faded dims selected cards riding along with another
// card's drag, and count badges the dragged card with how many tabs are moving
const TabCard = ({ tab, draggableProvider, selected, faded, count, children, ...props }) => (
  <Card
    ref={draggableProvider.innerRef}
    {...draggableProvider.draggableProps}
    {...draggableProvider.dragHandleProps}
    direction="row"
    px={2}
    py={1}
    gap={2}
    align="center"
    position="relative"
    userSelect="none"
    bgColor={selected ? "blue.50" : undefined}
    boxShadow={selected ? "inset 0 0 0 2px var(--chakra-colors-blue-400)" : undefined}
    opacity={faded ? 0.4 : 1}
    {...props}
  >
    {count > 1 && (
      <Badge position="absolute" top="-8px" right="-8px" colorScheme="blue" variant="solid" borderRadius="full">{count}</Badge>
    )}
    <Image src={faviconUrl(tab.url || tab.pendingUrl)} boxSize="16px" flexShrink={0} />
    <Box flex={1} minW={0}>
      <Text fontSize="sm" fontWeight="semibold" {...truncate}>{tab.title}</Text>
      <Text fontSize="xs" color="gray.500" {...truncate}>{tab.url || tab.pendingUrl}</Text>
    </Box>
    {children}
  </Card>
);

const Newtab = () => {
  let [tabs, updateTabs] = useState([]);
  let [tabLists, updateTabLists] = useState({
    "readlater": { "name": "Read Later", "tabs": [] }
  });
  let [tabListIds, updateTabListIds] = useState(["readlater"]);
  let [groups, updateGroups] = useState({});
  let [selected, updateSelected] = useState([]);
  let [lastClicked, updateLastClicked] = useState(null);
  let [dragging, updateDragging] = useState(null);
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
        saveLists(tabLists, tabListIds);
      }
      else {
        updateTabLists(result.lists);
        updateTabListIds(result.ids);
        saveLists(result.lists, result.ids);
      }
    })
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

  const setLists = (lists, ids) => {
    updateTabLists(lists);
    updateTabListIds(ids);
    return saveLists(lists, ids);
  }

  const windowTabs = (windowId) => tabs.filter(tab => tab.windowId == windowId);

  // A window's tabs split into runs that share a group (-1 for ungrouped), so each run
  // can be its own drop zone. There's always an ungrouped run at the end to drop into.
  const windowSegments = (windowId) => {
    const segments = [];
    windowTabs(windowId).forEach((tab, index) => {
      const last = segments.at(-1);
      if (last && last.groupId == tab.groupId) last.tabs.push(tab);
      else segments.push({ groupId: tab.groupId, start: index, tabs: [tab] });
    });
    if (segments.at(-1)?.groupId != -1) {
      segments.push({ groupId: -1, start: windowTabs(windowId).length, tabs: [] });
    }
    return segments;
  }

  // current window first, then the rest in the order Chrome returns them
  const windowIds = [...new Set(tabs.map(tab => tab.windowId))]
    .sort((a, b) => (b == currentWindow) - (a == currentWindow));

  // Every tab card's draggable id in display order: open tabs are "<tabId>",
  // saved tabs are "<listId>::<index>".
  const allIds = [
    ...windowIds.flatMap(windowId => windowTabs(windowId).map(tab => `${tab.id}`)),
    ...tabListIds.flatMap(listId => tabLists[listId].tabs.map((_, index) => `${listId}::${index}`)),
  ];

  const itemFor = (id) => {
    if (!id.includes("::")) return { tab: tabs.find(t => `${t.id}` == id) };
    const [listId, index] = id.split("::");
    return { listId, tab: tabLists[listId].tabs[Number(index)] };
  }

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
    faded: dragging != id && selected.includes(dragging) && selected.includes(id),
    count: snapshot.isDragging && selected.includes(id) ? selected.length : 0,
  });

  const onDragStart = ({ draggableId }) => {
    updateDragging(draggableId);
    if (!selected.includes(draggableId)) updateSelected([]);
  }

  const onDragEnd = ({ draggableId, source, destination }) => {
    updateDragging(null);
    if (!destination) return;
    // dragging a selected tab moves the whole selection, in display order
    const movingIds = selected.includes(draggableId) ? allIds.filter(id => selected.includes(id)) : [draggableId];
    const moving = movingIds.map(itemFor);
    const openTabs = moving.filter(m => !m.listId).map(m => m.tab);
    updateSelected([]);

    // open tab zones are "OpenTabs::<windowId>::<start>::<groupId>"
    const [toKind, to, toStart, toGroup] = destination.droppableId.split("::");

    // everything goes in front of the first tab at the drop point that isn't moving
    const following = toKind == "OpenTabs" ? windowTabs(to).slice(Number(toStart)).map(t => `${t.id}`)
      : toKind == "TabList" ? tabLists[to].tabs.map((_, index) => `${to}::${index}`) : [];
    const anchor = following.filter(id => id != draggableId).slice(destination.index)
      .find(id => !movingIds.includes(id));

    // saved tabs leave their lists wherever they go
    const lists = Object.fromEntries(Object.entries(tabLists).map(([listId, list]) =>
      [listId, { ...list, tabs: list.tabs.filter((_, index) => !movingIds.includes(`${listId}::${index}`)) }]));
    let ids = tabListIds;

    if (toKind == "OpenTabs" || toKind == "NewGroup") {
      const windowId = Number(to);
      if (toKind == "OpenTabs") {
        updateTabs(placeTabs(tabs, openTabs, Number(anchor), windowId, Number(toGroup)));
      }
      (async () => {
        const tabIds = [];
        for (const m of moving) {
          tabIds.push(m.listId ? (await chrome.tabs.create({ active: false, url: m.tab.url, windowId })).id : m.tab.id);
        }
        if (toKind == "NewGroup") {
          await chrome.tabs.group({ tabIds, createProperties: { windowId } });
          return;
        }
        // last to first, each in front of the one placed before it
        let before = anchor && Number(anchor);
        for (const tabId of tabIds.reverse()) {
          await moveBefore(tabId, before, windowId, Number(toGroup));
          before = tabId;
        }
      })();
    } else {
      let listId = to;
      if (toKind == "NewList") {
        listId = crypto.randomUUID();
        lists[listId] = { "name": "New List!", "tabs": [] };
        ids = [...ids, listId];
      }
      const at = anchor ? lists[listId].tabs.indexOf(itemFor(anchor).tab) : lists[listId].tabs.length;
      lists[listId].tabs.splice(at, 0, ...moving.map(m => m.listId ? m.tab : toSaved(m.tab)));
      if (openTabs.length) {
        chrome.tabs.remove(openTabs.map(t => t.id));
        updateTabs(tabs.filter(t => !openTabs.includes(t)));
      }
    }
    setLists(lists, ids);
  }

  const addList = () => {
    const listId = crypto.randomUUID();
    setLists({ ...tabLists, [listId]: { "name": "New List!", "tabs": [] } }, [...tabListIds, listId]);
  }

  const removeList = (listId) => {
    const { [listId]: removed, ...lists } = tabLists;
    setLists(lists, tabListIds.filter(id => id != listId));
    chrome.storage.local.remove(listId);
  }

  const renameList = (listId, name) => {
    setLists({ ...tabLists, [listId]: { ...tabLists[listId], name } }, tabListIds);
  }

  const openSaved = async (listId, index) => {
    const lists = structuredClone(tabLists);
    const [saved] = lists[listId].tabs.splice(index, 1);
    await setLists(lists, tabListIds);
    chrome.tabs.update({ url: saved.url });
  }

  return (
    <ChakraProvider>
      <Box w="100vw" h="100vh" bgColor="gray.100" p={3}>
        <DragDropContext onDragStart={onDragStart} onDragEnd={onDragEnd}>
          <Flex height="100%" gap={3}>
            <Flex direction="column" w="280px" flexShrink={0} minH={0}>
              <Heading size="md" mb={2}>Open Tabs</Heading>
              <Box overflowY="auto" flex={1}>
                {windowIds.map((windowId, windowIndex) => (
                  <Box key={windowId} mb={3}>
                    <Heading size="xs" color="gray.600" textTransform="uppercase" mb={1}>{windowId == currentWindow ? "This Window" : `Window ${windowIndex + 1}`}</Heading>
                    {windowSegments(windowId).map((segment) => {
                      const group = groups[segment.groupId];
                      const zone = (
                        <Droppable droppableId={`OpenTabs::${windowId}::${segment.start}::${segment.groupId}`}>
                          {(droppableProvider) => (
                            <VStack
                              ref={droppableProvider.innerRef}
                              {...droppableProvider.droppableProps}
                              align='stretch'
                              spacing={1}
                              minH={2}
                            >
                              {segment.tabs.map((tab, index) => (
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
                                      onClick={(e) => selectClick(e, `${tab.id}`)}
                                    >
                                      <CloseButton size="sm" onClick={() => {
                                        chrome.tabs.remove(tab.id)
                                        chrome.tabs.query({}).then(updateTabs);
                                      }} />
                                    </TabCard>
                                  )}
                                </Draggable>
                              ))}
                              {droppableProvider.placeholder}
                            </VStack>
                          )}
                        </Droppable>
                      );
                      if (segment.groupId == -1) {
                        return <Box key={segment.start} mb={1}>{zone}</Box>;
                      }
                      return (
                        <Box key={segment.start} mb={1} pl={2} borderLeft="3px solid" borderColor={groupColors[group?.color] ?? "gray.400"}>
                          <Flex align="center" gap={2} mb={1}>
                            <Box
                              as="button"
                              title="Change color"
                              boxSize="10px"
                              flexShrink={0}
                              borderRadius="full"
                              bgColor={groupColors[group?.color] ?? "gray.400"}
                              onClick={() => chrome.tabGroups.update(segment.groupId, { color: nextGroupColor(group?.color) })}
                            />
                            <Editable
                              key={group?.title}
                              defaultValue={group?.title}
                              placeholder="Unnamed group"
                              fontSize="sm"
                              fontWeight="semibold"
                              onSubmit={(title) => chrome.tabGroups.update(segment.groupId, { title })}
                            >
                              <EditablePreview />
                              <EditableInput />
                            </Editable>
                            <Spacer />
                            <Button size="xs" variant="ghost" onClick={() => chrome.tabs.ungroup(segment.tabs.map(t => t.id))}>Ungroup</Button>
                          </Flex>
                          {zone}
                        </Box>
                      );
                    })}
                    <Droppable droppableId={`NewGroup::${windowId}`}>
                      {(droppableProvider, snapshot) => (
                        <Box
                          ref={droppableProvider.innerRef}
                          {...droppableProvider.droppableProps}
                          py={1}
                          textAlign="center"
                          fontSize="xs"
                          color="gray.500"
                          border="1px dashed"
                          borderColor={snapshot.isDraggingOver ? "green.400" : "gray.300"}
                          borderRadius="md"
                          bgColor={snapshot.isDraggingOver ? "green.50" : ""}
                        >
                          + New group (drop a tab here)
                          {droppableProvider.placeholder}
                        </Box>
                      )}
                    </Droppable>
                  </Box>
                ))}
              </Box>
            </Flex>
            <Flex direction="column" flex={1} minW={0} minH={0}>
              <Heading size="md" mb={2}>My Lists</Heading>
              <Flex gap={3} flex={1} minH={0} pb={2} overflowX="scroll" onWheel={scrollSideways} sx={visibleScrollbar}>
                {tabListIds.map((listId) => {
                  return (
                    <Card flex="1 0 300px" key={listId}>
                      <CardHeader py={2} px={3}>
                        <Flex align="center">
                          <Heading size="sm">
                            <Editable key={tabLists[listId].name} defaultValue={tabLists[listId].name} onSubmit={(name) => renameList(listId, name)}>
                              <EditablePreview />
                              <EditableInput />
                            </Editable>
                          </Heading>
                          <Spacer />
                          <CloseButton size="sm" onClick={() => removeList(listId)} />
                        </Flex>
                      </CardHeader>

                      <Droppable droppableId={`TabList::${listId}`}>
                        {(droppableProvider, snapshot) => (
                          <CardBody ref={droppableProvider.innerRef}
                            {...droppableProvider.droppableProps}
                            pt={0}
                            px={3}
                            minH={0}
                            overflowY="auto"
                            bgColor={snapshot.isDraggingOver ? "green.100" : ""}>
                            <VStack
                              alignItems="stretch"
                              spacing={1}
                            >
                              {tabLists[listId].tabs.map((tab, index) => (
                                <Draggable
                                  index={index}
                                  key={`${listId}::${index}`}
                                  draggableId={`${listId}::${index}`}
                                >
                                  {(draggableProvider, snapshot) => (
                                    <TabCard
                                      tab={tab}
                                      draggableProvider={draggableProvider}
                                      {...cardState(`${listId}::${index}`, snapshot)}
                                      cursor="pointer"
                                      onClick={(e) => selectClick(e, `${listId}::${index}`) || openSaved(listId, index)}
                                    />
                                  )}
                                </Draggable>
                              ))}
                              {droppableProvider.placeholder}
                            </VStack>
                          </CardBody>
                        )}
                      </Droppable>
                    </Card>
                  )
                })}
                <Droppable droppableId='NewList'>
                  {(droppableProvider, snapshot) => (
                    <Flex
                      ref={droppableProvider.innerRef}
                      {...droppableProvider.droppableProps}
                      flex="0 0 160px"
                      direction="column"
                      align="center"
                      justify="center"
                      border="2px dashed"
                      borderColor={snapshot.isDraggingOver ? "green.400" : "gray.300"}
                      borderRadius="md"
                      bgColor={snapshot.isDraggingOver ? "green.50" : ""}
                      color="gray.500"
                      cursor="pointer"
                      _hover={{ borderColor: "gray.400", color: "gray.600" }}
                      onClick={addList}
                    >
                      <Text fontWeight="semibold">+ New List</Text>
                      <Text fontSize="xs">click or drop a tab here</Text>
                      {droppableProvider.placeholder}
                    </Flex>
                  )}
                </Droppable>
              </Flex>
            </Flex>
          </Flex>
        </DragDropContext>
      </Box>
    </ChakraProvider>
  );
};

export default Newtab;
