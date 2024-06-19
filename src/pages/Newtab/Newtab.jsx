import React, { useEffect, useState } from 'react';
import logo from '../../assets/img/logo.svg';
import './Newtab.css';
import './Newtab.scss';
import OpenTab from './OpenTab';
import TabList from './TabList';
import { DragDropContext, Draggable, Droppable } from '@hello-pangea/dnd';
import { AspectRatio, Box, Card, CardBody, CardHeader, Center, ChakraProvider, CloseButton, Editable, EditableInput, EditablePreview, Flex, Heading, Image, List, Spacer, Spinner, Square, Text, VStack, Wrap, list } from '@chakra-ui/react';

const getTabList = async (tabListId) => {
  const ret = await chrome.storage.sync.get(tabListId);
  if (ret.hasOwnProperty(tabListId)) {
    return ret[tabListId];
  }
  return null;
}

const setTabList = async (tabListId, obj) => {
  return await chrome.storage.sync.set({ [tabListId]: obj });
}

const getTabLists = async () => {
  const ret = await chrome.storage.sync.get("__tab_lists");
  if (ret.hasOwnProperty("__tab_lists")) {
    return ret["__tab_lists"];
  }
  return null;
}

const getLists = async (listIds) => {
  const ret = await chrome.storage.sync.get(listIds);
  return ret;
}

const setTabLists = async (lists) => {
  return await chrome.storage.sync.set({ "__tab_lists": lists })
}

const setTabListTabs = async (tabListId, tabs) => {
  const tabList = await getTabList(tabListId);
  return await setTabList(tabListId, { ...tabList, tabs: tabs })
}

const addTabList = async (tabListId, tabListName) => {
  const tl = await getTabLists();
  if (!tl.includes(tabListId)) {
    await setTabList(tabListId, { "name": tabListName, "tabs": [] });
    await setTabLists([...tl, tabListId]);
    return;
  }
  return;
}

const removeTabList = async (tabListId) => {
  const tl = await getTabLists();
  await chrome.storage.sync.remove(tabListId);
  await setTabLists(tl.filter(id => id != tabListId));
  return;
}

const renameTabList = async (tabListId, tabListName) => {
  const tl = await getTabLists();
  if (tl.includes(tabListId)) {
    const tabList = await getTabList(tabListId);
    await setTabList(tabListId, { ...tabList, "name": tabListName });
    return;
  }
}

const Newtab = () => {
  let [tabs, updateTabs] = useState([]);

  //TODO: read from chrome.storage.local
  let [tabLists, updateTabLists] = useState({
    "readlater": { "name": "Read Later", "tabs": [] }
  });
  let [tabListIds, updateTabListIds] = useState(["readlater"]);
  const refresh = () => {
    chrome.tabs.query({}).then(updateTabs);
  }

  let [currentWindow, updateCurrentWindow] = useState(chrome.windows.WINDOW_ID_CURRENT);

  useEffect(() => {
    chrome.tabs.query({}).then(updateTabs);
    chrome.windows.getCurrent().then(x => updateCurrentWindow(x.id));


    getTabLists().then(async (result) => {
      if (result === null) {
        console.log("No lists in storage, creating defaults...")
        setTabLists(tabListIds);
        for (let id of tabListIds) {
          setTabList(id, tabLists[id]);
        }
      }
      else {
        updateTabLists(await getLists(result));
        updateTabListIds(result);
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
  }, []);

  const onDragEnd = async (result) => {
    console.log(result);
    if (!result.destination) return;
    const startIndex = result.source.index
    const endIndex = result.destination.index
    if (result.source.droppableId == "OpenTabs") {
      if (result.destination.droppableId == "OpenTabs") {
        chrome.tabs.move(tabs[startIndex].id, {
          index: endIndex
        })
        const copyTabs = [...tabs]
        const [reorderTabs] = copyTabs.splice(startIndex, 1)
        copyTabs.splice(endIndex, 0, reorderTabs)
        updateTabs(copyTabs)
      }
      else if (result.destination.droppableId == "NewList") {
        let randId = crypto.randomUUID();
        const copyTabs = [...tabs]
        const [reorderTabs] = copyTabs.splice(startIndex, 1)
        addTabList(randId, "New List!").then(async () => {
          await setTabListTabs(randId, [reorderTabs])
          const lists = await getTabLists();
          console.log(lists);
          updateTabLists(await getLists(lists));
          updateTabListIds(lists);
          updateTabs(copyTabs)
          chrome.tabs.remove(tabs[startIndex].id)
          console.log(tabListIds);
        })
      }
      else {
        console.log("Got interesting destination")
        let destinationList = result.destination.droppableId.split("::")[1];
        const copyTabs = [...tabs]
        let removedTabs = copyTabs.splice(startIndex, 1)
        let copyTabLists = { ...tabLists }
        copyTabLists[destinationList].tabs.splice(0, 0, ...removedTabs)
        updateTabLists(copyTabLists)
        setTabList(destinationList, copyTabLists[destinationList])
        chrome.tabs.remove(tabs[startIndex].id)
        updateTabs(copyTabs)
        console.log(tabLists)
      }
    } else {
      if (result.destination.droppableId == "OpenTabs") {
        let source = result.source.droppableId.split("::")[1];
        const copyTabLists = { ...tabLists }
        const copyTabs = [...tabs]
        console.log("copyTabLists", copyTabLists)
        const [reorderTabs] = copyTabLists[source].tabs.splice(startIndex, 1)
        let createdTab = await chrome.tabs.create({
          active: false,
          url: reorderTabs.url,
          index: endIndex
        })
        copyTabs.splice(endIndex, 0, createdTab)
        updateTabs(copyTabs)
        updateTabLists(copyTabLists)
        setTabList(source, copyTabLists[source]);
      }
      else {
        console.log("Got interesting destination")
        let destinationList = result.destination.droppableId.split("::")[1];
        let source = result.source.droppableId.split("::")[1];
        let copyTabLists = { ...tabLists }
        const [reorderTabs] = copyTabLists[source].tabs.splice(startIndex, 1)
        copyTabLists[destinationList].tabs.splice(0, 0, reorderTabs)
        updateTabLists(copyTabLists)
        console.log(tabLists)
      }
    }
  }


  const updateListName = (listId) => {
    return (newName) => {
      renameTabList(listId, newName);
    }
  }

  return (
    <ChakraProvider>
      <Box w="100vw" h="100vh" bgColor="gray.100">
        <DragDropContext onDragEnd={onDragEnd}>
          <Flex height="100%" overflow="clip" gap={4}>
            <Flex direction="column" w="300px" overflowY="clip">
              <Heading>Open Tabs:</Heading>
              <Droppable droppableId="OpenTabs">
                {(droppableProvider) => (
                  <VStack
                    ref={droppableProvider.innerRef}
                    {...droppableProvider.droppableProps}
                    align='stretch'
                    overflowY="scroll"
                  >
                    {tabs.filter((tab) => {
                      console.log("TAB", tab.windowId, currentWindow)
                      return tab.windowId == currentWindow;
                    }).map((tab, index) => (
                      <Draggable
                        index={index}
                        key={tab.id}
                        draggableId={`${tab.id}`}
                      >
                        {(draggableProvider) => (
                          <Card
                            ref={draggableProvider.innerRef}
                            {...draggableProvider.draggableProps}
                            {...draggableProvider.dragHandleProps}
                            direction="row"
                            p="5px"
                            width="full"
                            align="center"
                          >
                            <Square maxW='28px'>
                              <Image src={tab.favIconUrl} fallback={<Spinner />} objectFit='cover' />
                            </Square>
                            <Box ml="5px" overflowX="hidden" width="full">
                              <Box as="b" display="block" maxW={"calc(100% - 48px)"} textOverflow={'ellipsis'} overflow={"hidden"} whiteSpace="nowrap">{tab.title}</Box>
                              <Text maxW={"calc(100% - 48px)"} textOverflow={'ellipsis'} overflow={"hidden"} whiteSpace="nowrap">{tab.url}</Text>
                            </Box>
                            <CloseButton onClick={() => {
                              chrome.tabs.remove(tab.id)
                              chrome.tabs.query({}).then(updateTabs);
                            }} />
                          </Card>
                        )}
                      </Draggable>
                    ))}
                    {droppableProvider.placeholder}
                  </VStack>
                )}
              </Droppable>
            </Flex>
            <Flex direction="column" overflow="clip">
              <Heading>My Lists</Heading>
              <Flex gap={4} flex={1} overflowX="scroll">
                {tabListIds.map((title, index) => {
                  return (
                    <Card flex={1} minW="400px" key={title}>
                      <CardHeader>
                        <Flex>
                          <Heading size="md">
                            <Editable defaultValue={tabLists[title].name} onSubmit={updateListName(title)}>
                              <EditablePreview />
                              <EditableInput />
                            </Editable>
                          </Heading>
                          <Spacer />
                          <CloseButton onClick={async () => {
                            await removeTabList(title)
                            const lists = await getTabLists()
                            updateTabLists(await getLists(lists))
                            updateTabListIds(lists)
                          }} />
                        </Flex>
                      </CardHeader>

                      <Droppable droppableId={`TabList::${title}`}>
                        {(droppableProvider, snapshot) => (
                          <CardBody ref={droppableProvider.innerRef}
                            {...droppableProvider.droppableProps}
                            bgColor={snapshot.isDraggingOver ? "green.100" : ""}>
                            <VStack
                              alignItems="stretch"
                            >
                              {tabLists[title].tabs.map((tab, index) => (
                                <Draggable
                                  index={index}
                                  key={index}
                                  draggableId={`${tab.id}`}
                                >
                                  {(draggableProvider) => (
                                    <Card
                                      ref={draggableProvider.innerRef}
                                      {...draggableProvider.draggableProps}
                                      {...draggableProvider.dragHandleProps}
                                      direction="row"
                                      p="5px"
                                      width="full"
                                      align="center"
                                    >
                                      <Square maxW='28px'>
                                        <Image src={tab.favIconUrl} fallback={<Spinner />} objectFit='cover' />
                                      </Square>
                                      <Box ml="5px" overflowX="hidden" width="full">
                                        <Box as="b" display="block" maxW={"calc(100% - 48px)"} textOverflow={'ellipsis'} overflow={"hidden"} whiteSpace="nowrap">{tab.title}</Box>
                                        <Text maxW={"calc(100% - 48px)"} textOverflow={'ellipsis'} overflow={"hidden"} whiteSpace="nowrap">{tab.url}</Text>
                                      </Box>
                                    </Card>
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
                <Card minW="400px" flex={1}>
                  <CardHeader>
                    <Heading size="md">Make New List</Heading>
                  </CardHeader>
                  <Droppable droppableId='NewList'>
                    {(droppableProvider, snapshot) => (
                      <CardBody
                        ref={droppableProvider.innerRef}
                        {...droppableProvider.droppableProps}
                        bgColor={snapshot.isDraggingOver ? "green.100" : ""}
                      >
                        {droppableProvider.placeholder}
                      </CardBody>
                    )}
                  </Droppable>
                </Card>
              </Flex>
            </Flex>
          </Flex>
        </DragDropContext>
      </Box>
    </ChakraProvider>
  );
};

export default Newtab;
