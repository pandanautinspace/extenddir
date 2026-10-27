import React, { useEffect, useState } from 'react';
import './Newtab.css';
import './Newtab.scss';
import { DragDropContext, Draggable, Droppable } from '@hello-pangea/dnd';
import { Box, Button, Card, CardBody, CardHeader, ChakraProvider, CloseButton, Editable, EditableInput, EditablePreview, Flex, Heading, Image, Spacer, Text, VStack } from '@chakra-ui/react';

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

// Put tab at position in the window's tab order, as part of groupId (-1 for none),
// so the page shows the drop right away instead of waiting for Chrome.
const placeTab = (tabs, tab, windowId, position, groupId) => {
  const rest = tabs.filter(t => t.id != tab.id);
  const win = rest.filter(t => t.windowId == windowId);
  const at = position < win.length ? rest.indexOf(win[position])
    : win.length ? rest.indexOf(win.at(-1)) + 1 : rest.length;
  rest.splice(at, 0, { ...tab, windowId, groupId });
  return rest;
}

// Chrome adds a tab to a group when it's moved into the group's middle and takes it out
// when it's moved outside, so group first, move, then undo any grouping the move caused.
const moveOpenTab = async (tabId, windowId, index, groupId) => {
  if (groupId != -1) await chrome.tabs.group({ groupId, tabIds: tabId });
  await chrome.tabs.move(tabId, { windowId, index });
  if (groupId == -1 && (await chrome.tabs.get(tabId)).groupId != -1) await chrome.tabs.ungroup(tabId);
}

const newGroup = (tabId, windowId) => chrome.tabs.group({ tabIds: tabId, createProperties: { windowId } });

const TabCard = ({ tab, draggableProvider, children, ...props }) => (
  <Card
    ref={draggableProvider.innerRef}
    {...draggableProvider.draggableProps}
    {...draggableProvider.dragHandleProps}
    direction="row"
    px={2}
    py={1}
    gap={2}
    align="center"
    {...props}
  >
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

  const onDragEnd = ({ source, destination }) => {
    if (!destination) return;
    // open tab zones are "OpenTabs::<windowId>::<start>::<groupId>"
    const [fromKind, from, fromStart] = source.droppableId.split("::");
    const [toKind, to, toStart, toGroup] = destination.droppableId.split("::");
    const lists = structuredClone(tabLists);
    let ids = tabListIds;

    // take the dragged tab out of where it came from
    let saved;
    if (fromKind == "OpenTabs") {
      const position = Number(fromStart) + source.index;
      const tab = windowTabs(from)[position];
      if (toKind == "OpenTabs") {
        let index = Number(toStart) + destination.index;
        if (from == to && position < Number(toStart)) index -= 1;
        updateTabs(placeTab(tabs, tab, Number(to), index, Number(toGroup)));
        moveOpenTab(tab.id, Number(to), index, Number(toGroup));
        return;
      }
      if (toKind == "NewGroup") {
        newGroup(tab.id, Number(to));
        return;
      }
      chrome.tabs.remove(tab.id);
      updateTabs(tabs.filter(t => t.id != tab.id));
      saved = toSaved(tab);
    } else {
      [saved] = lists[from].tabs.splice(source.index, 1);
    }

    // and put it where it was dropped
    if (toKind == "OpenTabs") {
      const index = Number(toStart) + destination.index;
      chrome.tabs.create({ active: false, url: saved.url, windowId: Number(to), index })
        .then(tab => moveOpenTab(tab.id, Number(to), index, Number(toGroup)));
    } else if (toKind == "NewGroup") {
      chrome.tabs.create({ active: false, url: saved.url, windowId: Number(to) })
        .then(tab => newGroup(tab.id, Number(to)));
    } else {
      let listId = to;
      if (toKind == "NewList") {
        listId = crypto.randomUUID();
        lists[listId] = { "name": "New List!", "tabs": [] };
        ids = [...ids, listId];
      }
      lists[listId].tabs.splice(destination.index, 0, saved);
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
        <DragDropContext onDragEnd={onDragEnd}>
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
                                  {(draggableProvider) => (
                                    <TabCard tab={tab} draggableProvider={draggableProvider}>
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
                                  {(draggableProvider) => (
                                    <TabCard
                                      tab={tab}
                                      draggableProvider={draggableProvider}
                                      cursor="pointer"
                                      onClick={() => openSaved(listId, index)}
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
