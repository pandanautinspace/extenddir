import React, { useEffect, useState } from 'react';
import { Box, Button, ChakraProvider, Flex, Heading, Text } from '@chakra-ui/react';
import { sitePattern } from '../../sources/extract';
import { addSource } from '../../sources/lists';

const truncate = { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };

// the RSS and Atom feeds a page says it has
const findFeeds = () => [...document.querySelectorAll('link[rel="alternate"][type*="rss"], link[rel="alternate"][type*="atom"]')]
  .map(link => ({ title: link.title || document.title, url: new URL(link.getAttribute("href"), location.href).href }));

const Popup = () => {
  const [tab, updateTab] = useState(null);
  const [feeds, updateFeeds] = useState([]);
  const [added, updateAdded] = useState([]);
  const [error, updateError] = useState(null);

  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => {
      updateTab(tab);
      if (!/^https?:/.test(tab?.url)) return;
      const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: findFeeds });
      updateFeeds(result ?? []);
    }).catch(() => { });
  }, []);

  // Starts the picker, then makes sure it's there before closing: errors inside it only
  // reach the page's console, and some pages take out what's added to them. It also asks
  // to read the site, so the picker can try refreshing it as you pick; that's asked first,
  // while the click still counts as the person asking, and the picker starts right away
  // anyway, since the question can close the popup.
  const pick = async () => {
    chrome.permissions.request({ origins: [sitePattern(tab.url)] }).catch(() => { });
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["picker.bundle.js"] });
      await new Promise(resolve => setTimeout(resolve, 500));
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.__extenddirPickerError ??
          (document.querySelector("extenddir-picker") ? null : "the page took it out as soon as it was added"),
      });
      if (result) throw new Error(result);
      window.close();
    } catch (error) {
      updateError(`Couldn't start the picker: ${error.message}`);
    }
  }

  const addFeed = async (feed) => {
    // The permission prompt can close the popup, so the source comes first; if the popup
    // goes away, the source's refresh in the new tab page asks again.
    const listId = await addSource({ name: feed.title.slice(0, 40), source: { kind: "feed", url: feed.url } });
    updateAdded([...added, feed.url]);
    if (await chrome.permissions.request({ origins: [sitePattern(feed.url)] })) {
      chrome.runtime.sendMessage({ type: "refresh", listId });
    }
  }

  const readable = /^https?:/.test(tab?.url);

  return (
    <ChakraProvider>
      <Flex direction="column" gap={3} w="300px" p={3}>
        <Heading size="sm">Add a source</Heading>
        {tab && !readable && <Text fontSize="sm" color="gray.500">This page can't be read. Try a regular web page.</Text>}
        {readable && (
          <>
            <Button colorScheme="blue" size="sm" onClick={pick}>Pick items on this page</Button>
            {error && <Text fontSize="xs" color="red.500">{error}</Text>}
            <Text fontSize="xs" color="gray.500">
              Click one item, like a headline or a card, and everything like it gets picked too.
            </Text>
          </>
        )}
        {feeds.length > 0 && (
          <Flex direction="column" gap={2}>
            <Text fontSize="xs" fontWeight="bold" color="gray.600" textTransform="uppercase">Feeds on this page</Text>
            <Text fontSize="xs" color="gray.500">Feeds keep working when the page changes, so they're more reliable than picking.</Text>
            {feeds.map(feed => (
              <Flex key={feed.url} align="center" gap={2}>
                <Box flex={1} minW={0}>
                  <Text fontSize="sm" {...truncate}>{feed.title}</Text>
                  <Text fontSize="xs" color="gray.500" {...truncate}>{feed.url}</Text>
                </Box>
                <Button size="xs" isDisabled={added.includes(feed.url)} onClick={() => addFeed(feed)}>
                  {added.includes(feed.url) ? "Added" : "Add source"}
                </Button>
              </Flex>
            ))}
          </Flex>
        )}
      </Flex>
    </ChakraProvider>
  );
};

export default Popup;
