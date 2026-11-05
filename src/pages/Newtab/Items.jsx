import React, { useState } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { Box, Button, Flex, Image, Input, Modal, ModalBody, ModalCloseButton, ModalContent, ModalFooter, ModalHeader, ModalOverlay, Text, Textarea } from '@chakra-ui/react';

// Saved items are links, { title, url }, unless they have a type:
//   text:  { type: "text", text }
//   image: { type: "image", src, alt?, url? }  (url is where clicking through goes)
//   page:  { type: "page", title, body }  (body is markdown)
export const itemType = (item) => item.type ?? "link";

export const isLink = (item) => itemType(item) == "link";

export const newItem = (type) => ({
  text: { type, text: "" },
  image: { type, src: "", alt: "" },
  page: { type, title: "", body: "" },
})[type];

// what search looks through; open tabs count as links
export const itemText = (item) => ({
  text: () => item.text,
  image: () => `${item.alt} ${item.src} ${item.url ?? ""}`,
  page: () => `${item.title} ${item.body}`,
})[itemType(item)]?.() ?? `${item.title} ${item.url || item.pendingUrl}`;

// Chrome's favicon cache; returns a default icon for pages without one
const faviconUrl = (url) => chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`);

export const domainOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const truncate = { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };

// links in a page open in a new tab instead of replacing the new tab page
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName == "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

// page bodies may come from scraped pages, so they're always sanitized
const renderMarkdown = (body) => ({ __html: DOMPurify.sanitize(marked.parse(body ?? "")) });

// Chakra resets heading and list styles, so put back enough for markdown to read well
// (headings only get space above when something comes before them, since :first-child
// isn't safe with Chakra's styling)
const markdownStyle = {
  "h1, h2, h3, h4": { fontWeight: "bold", lineHeight: 1.3, mb: 1 },
  "* + h1, * + h2, * + h3, * + h4": { mt: 3 },
  h1: { fontSize: "xl" }, h2: { fontSize: "lg" }, "h3, h4": { fontSize: "md" },
  "p, ul, ol, pre, blockquote": { mb: 2 },
  "ul, ol": { pl: 5 },
  a: { color: "blue.600", textDecoration: "underline" },
  img: { maxW: "100%", borderRadius: "md", my: 2 },
  code: { fontFamily: "mono", fontSize: "0.9em", bgColor: "gray.100", px: 1, borderRadius: "sm" },
  pre: { bgColor: "gray.100", p: 2, borderRadius: "md", overflowX: "auto" },
  "pre code": { p: 0 },
  blockquote: { borderLeft: "3px solid", borderColor: "gray.300", pl: 3, color: "gray.600" },
};

export const Markdown = ({ body, ...props }) => (
  <Box sx={markdownStyle} dangerouslySetInnerHTML={renderMarkdown(body)} {...props} />
);

// what goes inside an item's card in a list
export const ItemContent = ({ item }) => {
  switch (itemType(item)) {
    case "text":
      return <Text fontSize="sm" whiteSpace="pre-wrap" noOfLines={6}>{item.text || "Empty note"}</Text>;
    case "image":
      return (
        <Box>
          <Image src={item.src} alt={item.alt} w="100%" maxH="160px" objectFit="cover" borderRadius="md" draggable={false} />
          {item.alt && <Text fontSize="xs" color="gray.500" mt={1} {...truncate}>{item.alt}</Text>}
        </Box>
      );
    case "page": {
      // a page that starts with a picture (as pages from the picker do) shows it small,
      // beside the title and a faded preview of the first few lines
      const picture = item.body?.match(/^!\[[^\]]*\]\(<?([^)\s>]+)>?\)\s*/);
      const rest = picture ? item.body.slice(picture[0].length) : item.body;
      return (
        <Flex gap={2} align="start">
          {picture && <Image src={picture[1]} boxSize="56px" objectFit="cover" borderRadius="md" flexShrink={0} draggable={false} />}
          <Box flex={1} minW={0}>
            {(item.title || !rest) && <Text fontSize="sm" fontWeight="semibold" noOfLines={2}>{item.title || "Untitled page"}</Text>}
            <Markdown
              body={rest}
              fontSize="xs"
              color="gray.600"
              maxH="72px"
              overflow="hidden"
              pointerEvents="none"
              sx={{ ...markdownStyle, maskImage: "linear-gradient(to bottom, black 60%, transparent)" }}
            />
          </Box>
        </Flex>
      );
    }
    default: {
      const url = item.url || item.pendingUrl;
      return (
        <Flex gap={2} align="center">
          <Image src={faviconUrl(url)} boxSize="16px" flexShrink={0} />
          <Box flex={1} minW={0}>
            <Text fontSize="sm" fontWeight="semibold" {...truncate}>{item.title}</Text>
            <Text fontSize="xs" color="gray.500" {...truncate}>{domainOf(url)}</Text>
          </Box>
        </Flex>
      );
    }
  }
}

const typeNames = { text: "Note", image: "Image", page: "Page" };

// Views and edits a note, image or page. New items (isNew) start out editing, and notes
// are always edited since there's nothing more to view, unless the item is readOnly (as a
// source's items are). onSave gets the changed item.
export const ItemEditor = ({ item, isNew, readOnly, onSave, onClose }) => {
  const [draft, updateDraft] = useState(item);
  const [editing, updateEditing] = useState(!readOnly && (isNew || itemType(item) == "text"));
  const change = (field) => (e) => updateDraft({ ...draft, [field]: e.target.value });
  const type = itemType(draft);

  const save = () => {
    onSave(draft);
    onClose();
  }

  const view = {
    text: () => <Text whiteSpace="pre-wrap">{draft.text}</Text>,
    image: () => (
      <>
        <Image src={draft.src} alt={draft.alt} maxW="100%" maxH="70vh" mx="auto" borderRadius="md" />
        {draft.alt && <Text mt={2} color="gray.600">{draft.alt}</Text>}
      </>
    ),
    page: () => <Markdown body={draft.body} />,
  }[type];

  const edit = {
    text: () => <Textarea autoFocus rows={8} placeholder="Write a note" value={draft.text} onChange={change("text")} />,
    image: () => (
      <Flex direction="column" gap={2}>
        <Input autoFocus placeholder="Image address" value={draft.src} onChange={change("src")} />
        <Input placeholder="Caption" value={draft.alt} onChange={change("alt")} />
        <Input placeholder="Link (optional)" value={draft.url ?? ""} onChange={change("url")} />
        {draft.src && <Image src={draft.src} maxH="200px" objectFit="contain" borderRadius="md" />}
      </Flex>
    ),
    page: () => (
      <Flex direction="column" gap={2}>
        <Input autoFocus placeholder="Title" value={draft.title} onChange={change("title")} />
        <Textarea rows={14} fontFamily="mono" fontSize="sm" placeholder="Write in markdown" value={draft.body} onChange={change("body")} />
      </Flex>
    ),
  }[type];

  return (
    <Modal isOpen onClose={onClose} size={type == "text" ? "lg" : "2xl"} scrollBehavior="inside">
      <ModalOverlay />
      <ModalContent>
        <ModalHeader pr={12}>
          {type == "page" && !editing ? (draft.title || "Untitled page")
            : readOnly ? typeNames[type] : `${isNew ? "New" : "Edit"} ${typeNames[type].toLowerCase()}`}
        </ModalHeader>
        <ModalCloseButton />
        <ModalBody>{editing ? edit() : view()}</ModalBody>
        <ModalFooter gap={2}>
          {type != "text" && draft.url && !editing && (
            <Button variant="ghost" onClick={() => chrome.tabs.create({ url: draft.url })}>Open link</Button>
          )}
          {editing
            ? <Button colorScheme="blue" onClick={save}>{isNew ? "Add" : "Save"}</Button>
            : !readOnly && <Button onClick={() => updateEditing(true)}>Edit</Button>}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
