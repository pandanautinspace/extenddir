// Turning a page into list items. A source describes where a list's items come from:
//   page: { url, itemSelector, fields, itemType, expected, data?, method?, ... }
//     fields maps title, url, image and text to { selector }, relative to each item
//     ("" is the item itself); expected is how many items there were when it was picked;
//     data says where the items are in the JSON the page embeds, if they are (see data.js)
//   feed: { kind: "feed", url }  (RSS or Atom)
// Items made from a source carry sourced: true, so a refresh knows which ones to replace.

export const clean = (text) => (text ?? "").replace(/\s+/g, " ").trim();

export const absolute = (url, baseUrl) => {
  try {
    const resolved = new URL(url, baseUrl);
    return /^https?:$/.test(resolved.protocol) ? resolved.href : null;
  } catch {
    return null;
  }
}

// the last (usually largest) candidate in a srcset
const fromSrcset = (srcset) => srcset?.split(",").map(s => s.trim().split(/\s+/)[0]).filter(Boolean).at(-1);

// Lazy-loading images keep their real address in data attributes or a srcset, with a
// placeholder in src, so look there first. currentSrc is only set on a live page.
export const imageOf = (el, baseUrl) => {
  const img = el.tagName == "IMG" ? el : el.querySelector("img") ?? el;
  const source = img.closest("picture")?.querySelector("source[srcset]");
  const candidates = [
    img.currentSrc,
    img.getAttribute("data-src"),
    img.getAttribute("data-lazy-src"),
    img.getAttribute("data-original"),
    fromSrcset(img.getAttribute("srcset") ?? img.getAttribute("data-srcset")),
    fromSrcset(source?.getAttribute("srcset")),
    img.getAttribute("src"),
  ];
  return candidates.map(c => c && absolute(c, baseUrl)).find(Boolean) ?? null;
}

const linkOf = (el, baseUrl) => {
  const a = el.closest("a[href]") ?? el.querySelector("a[href]");
  return a ? absolute(a.getAttribute("href"), baseUrl) : null;
}

const find = (root, field) => !field ? null : field.selector ? root.querySelector(field.selector) : root;

// An item's biggest picture, leaving out avatars and icons, by its size on the page or
// else the size it says it is. For items whose picture sits somewhere else than in the
// one picked (Instagram's videos and carousels).
const biggestImage = (root) => {
  const area = (img) => {
    const box = img.getBoundingClientRect();
    return box.width * box.height || Number(img.getAttribute("width")) * Number(img.getAttribute("height")) || 0;
  };
  return [...root.querySelectorAll("img")].map(img => ({ img, area: area(img) }))
    .filter(({ area }) => area >= 64 * 64).sort((a, b) => b.area - a.area)[0]?.img ?? null;
}

// the raw field values of one item element
export const fieldValues = (root, fields, baseUrl) => {
  const at = (name) => find(root, fields[name]);
  const image = at("image") ?? (fields.image && biggestImage(root));
  return {
    title: at("title") ? clean(at("title").textContent) : "",
    url: at("url") ? linkOf(at("url"), baseUrl) : null,
    image: image ? imageOf(image, baseUrl) : null,
    text: at("text") ? clean(at("text").textContent) : "",
  };
}

// links when there's nothing else, images when there's no words, notes when there's
// only words, and pages for anything richer
export const guessType = ({ title, url, image, text }) => {
  if (image && !title && !text) return "image";
  if (!image && !text) return "link";
  if (!image && !url && !title) return "text";
  return "page";
}

// A link to the page an item was found on, for items without one of their own, that
// scrolls to the item's words (by a text fragment), so each item's link is its own.
// Items without words get none, since they'd all have the same link.
export const linkToItem = (pageUrl, { title, text }) => {
  const words = clean(title || text).split(" ").filter(Boolean);
  if (!pageUrl || !words.length) return null;
  // text fragments use - and , to mark where text starts and ends
  const encode = (some) => encodeURIComponent(some.join(" ")).replace(/-/g, "%2D");
  const fragment = words.length <= 8 ? encode(words) : `${encode(words.slice(0, 4))},${encode(words.slice(-4))}`;
  const url = new URL(pageUrl);
  url.hash = `${url.hash.slice(1)}:~:text=${fragment}`;
  return url.href;
}

// One item of type from field values, or null when there's nothing to show. Items
// without a link of their own link to pageUrl, the page they're from (see linkToItem).
export const makeItem = (type, values, pageUrl) => {
  const { title, image, text } = values;
  if (!title && !values.url && !image && !text) return null;
  const url = values.url ?? linkToItem(pageUrl, values);
  if (type == "link") return url ? { title: title || text || url, url } : null;
  if (type == "image") return image ? { type, src: image, alt: title || text, ...(url && { url }) } : null;
  if (type == "text" && !url) return { type, text: [title, text].filter(Boolean).join("\n\n") };
  // pages, and words with a link, which show as a page so they can open it
  return {
    type: "page",
    title,
    body: [image && `![](<${image}>)`, text].filter(Boolean).join("\n\n"),
    ...(url && { url }),
  };
}

// what makes two items the same story
export const itemKey = (item) => item.url ?? item.src ?? item.text ?? item.title;

export const dedupe = (items) => {
  const seen = new Set();
  return items.filter(item => !seen.has(itemKey(item)) && seen.add(itemKey(item)));
}

export const extractItems = (doc, source, baseUrl) => dedupe([...doc.querySelectorAll(source.itemSelector)]
  .map(el => makeItem(source.itemType, fieldValues(el, source.fields, baseUrl), baseUrl))
  .filter(Boolean))
  .map(item => ({ ...item, sourced: true }));

// RSS items or Atom entries as links
export const parseFeed = (xml, baseUrl) => {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const text = (el, name) => clean(el.getElementsByTagName(name)[0]?.textContent);
  const entries = [...doc.getElementsByTagName("item"), ...doc.getElementsByTagName("entry")];
  return dedupe(entries.map(entry => {
    // Atom puts the address in href, RSS in the text
    const link = [...entry.getElementsByTagName("link")].find(l => (l.getAttribute("rel") ?? "alternate") == "alternate");
    const url = absolute(link?.getAttribute("href") || link?.textContent?.trim(), baseUrl);
    return url && { title: text(entry, "title") || url, url, sourced: true };
  }).filter(Boolean));
}

// the match pattern for a source's whole site, so www. and other subdomains it
// redirects to are covered by the same permission (IP addresses can't have subdomains)
export const sitePattern = (url) => {
  const { hostname } = new URL(url);
  return /^[\d.]+$|:/.test(hostname) ? `*://${hostname}/*` : `*://*.${hostname.replace(/^www\./, "")}/*`;
}

// how many items a refresh needs to find to count as working
export const enoughItems = (source) => Math.max(1, Math.ceil((source.expected ?? 1) / 2));

// what scrolls el into view: the nearest panel around it that scrolls, or else the page
const scrollerOf = (el) => {
  for (let at = el?.parentElement; at && at != document.body; at = at.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(at).overflowY) && at.scrollHeight > at.clientHeight) return at;
  }
  return document.scrollingElement;
}

// Waits until the page has enough items (pages that render with JavaScript fill in
// after loading), then extracts them. Pages that load more as they're scrolled (Reddit),
// or only keep the items on screen (X's timeline), are scrolled until there are 20 items
// or as many as were picked, collecting items along the way. It goes most of a screen
// every half second, so every item is shown on the way down, since pages like Instagram
// only draw items as they're scrolled to. It stops when it has the items wanted, when
// it's been at the bottom for 4 seconds with nothing new (pages take a while to load
// more), or after 20 seconds. Pages that scroll a panel rather than the window (LinkedIn)
// scroll that panel. Runs in the page being read.
export const extractWhenReady = async (source, timeout = 10000) => {
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const start = Date.now();
  while (Date.now() - start < timeout &&
    document.querySelectorAll(source.itemSelector).length < enoughItems(source)) {
    await sleep(500);
  }
  // an item seen again keeps its fullest version, since pages fill items in as they scroll by
  const found = new Map();
  const fullness = (item) => Object.values(item).filter(v => v).join("").length;
  const collect = () => extractItems(document, source, location.href).forEach(item => {
    const seen = found.get(itemKey(item));
    if (!seen || fullness(item) > fullness(seen)) found.set(itemKey(item), item);
  });
  collect();
  const wanted = Math.max(source.expected ?? 0, 30);
  const scrolling = Date.now();
  let progress = Date.now();
  while (found.size < wanted && Date.now() - progress < 4000 && Date.now() - scrolling < 20000) {
    const before = found.size;
    const scroller = scrollerOf([...document.querySelectorAll(source.itemSelector)].at(-1));
    scroller.scrollBy(0, scroller.clientHeight * 0.8);
    await sleep(500);
    collect();
    const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 50;
    if (found.size > before || !atBottom) progress = Date.now();
  }
  return [...found.values()];
}
