// Turning one clicked element into a selector for all the similar items on a page, plus
// selectors for the fields inside each. Selectors avoid things that change whenever a
// site is rebuilt, like hashed class names, so they keep working across refreshes.

// css-1x9f2a, sc-bdVaJa, jsx-123, styled-components' ldvJot, React Native Web's r-1awozwy,
// Meta's atomic xstzfhl and x1lliihq and its short _aagv and _a6hd, Pinterest's
// Masonry__Item_O, noOutline_1g and pointer_s (a name with a short hash that changes every
// build, not a number like col_2), and other generated names
const isHashed = (c) => /^(css|sc|jsx|emotion|styled|svelte)-/.test(c) || /^r-[a-z0-9]{5,}$/.test(c) ||
  /^[a-zA-Z]\w*_(?:[a-zA-Z]|[A-Z][a-zA-Z0-9]|\d[a-zA-Z]|[a-z][A-Z\d])$/.test(c) ||
  /^x[a-z0-9]{5,8}$/.test(c) || /^_a[a-z0-9]{2,3}$/.test(c) ||
  (/^_?[a-zA-Z0-9]{5,8}$/.test(c) && /\d/.test(c) && /[a-zA-Z]/.test(c)) ||
  (/^[a-zA-Z]{4,8}$/.test(c) && /[a-z][A-Z]/.test(c));

// classes that come and go with the element's state
const isState = (c) => /^(is-|has-)|^(active|selected|current|open|hover|focus|first|last|odd|even|visible|hidden)$/.test(c);

// CSS modules (Card_title__x7Yq2) and styled-components (Grid-styles__GridStyled-sc-70d90311-0)
// add a hash to a stable name, so match the name part
const classSelector = (c) => {
  const named = c.match(/^(.+__)[a-zA-Z0-9_-]{5}$/) ?? c.match(/^(.+)-sc-[0-9a-f]+-\d+$/);
  if (named) return `[class*="${named[1]}"]`;
  return isHashed(c) || isState(c) ? null : `.${CSS.escape(c)}`;
}

// what an element is for, which doesn't change when a site is rebuilt: its role (but not
// "presentation" or "none", which only say it isn't anything) and names like Meta's
// data-pagelet="IGDInboxThreadListScrollableAreaPagelet"
const stableAttributes = ["data-testid", "data-test", "itemprop", "itemtype", "data-pagelet", "role"];
const meaningless = { role: ["presentation", "none", "generic"] };

// Attributes that say what an element is by a name with an id after it, like LinkedIn's
// componentkey="update-card-focusXaicz…" or data-urn="urn:li:activity:7234…". They match
// by the name: the lowercase words at the start that each end in a separator, at least
// two of them ("update-card-", "urn:li:activity:"). Ids have capitals and digits, and
// hyphens of their own, so values that are only an id are left out.
const keyedAttributes = ["componentkey", "data-urn", "data-view-name"];
const namePart = (value) => value.match(/^(?:[a-z]+[-_:]){2,}/)?.[0];

// The kind of thing a link goes to: the word before the id that ends its address, like
// "p" in Instagram's /natgeo/p/DfCnLHjlAAC/ or "status" in X's /nasa/status/1234.
// ids have digits or several capitals, unlike words such as "mutualOnly"
const isId = (segment) => /^[A-Za-z0-9_-]{6,}$/.test(segment) && (/\d/.test(segment) || /[A-Z].*[A-Z]/.test(segment));
const kindOf = (a) => {
  const segments = (a.getAttribute("href") ?? "").replace(/[?#].*$/, "").split("/").filter(Boolean);
  return segments.length >= 2 && isId(segments.at(-1)) && /^[a-z]+$/.test(segments.at(-2)) ? segments.at(-2) : null;
}

// A link with nothing else stable to go by matches links to the same kinds of thing: every
// kind linked to around it, out as far as it takes to have three links of its own kind,
// so Instagram's posts (/p/) and reels (/reel/) in a grid are both items, and the story
// highlights above the grid aren't.
const kindsSelector = (a) => {
  const kind = kindOf(a);
  if (!kind) return "";
  let area = a.parentElement;
  while (area.parentElement && [...area.querySelectorAll("a[href]")].filter(l => kindOf(l) == kind).length < 3) area = area.parentElement;
  const kinds = [...new Set([...area.querySelectorAll("a[href]")].map(kindOf).filter(Boolean))];
  return `:is(${kinds.map(kind => `[href*="/${kind}/"]`).join(", ")})`;
}

// tag, and stable attributes or else up to three stable classes, optionally only classes
// in keep; links with neither go by what they link to
export const signature = (el, keep) => {
  const attributes = [
    ...stableAttributes.filter(a => el.hasAttribute(a) && !meaningless[a]?.includes(el.getAttribute(a)))
      .map(a => `[${a}="${CSS.escape(el.getAttribute(a))}"]`),
    ...keyedAttributes.map(a => el.hasAttribute(a) && namePart(el.getAttribute(a)))
      .map((name, i) => name && `[${keyedAttributes[i]}^="${CSS.escape(name)}"]`).filter(Boolean),
  ];
  const classes = attributes.length ? [] : [...el.classList].filter(c => !keep || keep.includes(c))
    .map(classSelector).filter(Boolean).slice(0, 3);
  const kinds = !attributes.length && !classes.length && el.matches("a[href]") ? kindsSelector(el) : "";
  return el.tagName.toLowerCase() + attributes.join("") + classes.join("") + kinds;
}

// The element's siblings that look like it: the same tag, and sharing a class when it has any.
const similarSiblings = (el) => [...el.parentElement?.children ?? []].filter(s => s.tagName == el.tagName &&
  (!el.classList.length || [...el.classList].some(c => s.classList.contains(c))));

// signature with only the classes every similar sibling has, so one featured card's extra
// classes don't leave out the rest
export const sharedSignature = (el) => {
  const siblings = similarSiblings(el);
  const shared = [...el.classList].filter(c => siblings.every(s => s.classList.contains(c)));
  return signature(el, shared);
}

// the clicked element and its ancestors up to (not including) body
export const ancestry = (el) => {
  const chain = [];
  for (let at = el; at && at != document.body && at != document.documentElement; at = at.parentElement) chain.push(at);
  return chain;
}

const has = (el, selector) => el.matches(selector) || !!el.querySelector(selector);
const hasLink = (el) => has(el, "a[href]");

// whether other has the links and headings el has (not pictures: plenty of posts have none)
const sameShape = (el, other) => ["a[href]", "h1, h2, h3, h4, h5, h6"]
  .every(selector => !has(el, selector) || has(other, selector));

// what can be clicked as a whole
const clickables = "a[href], button, [role=button], [role=link], [role=option], [role=row], [role=listitem], [role=menuitem], [role=gridcell]";

// pieces of text, which repeat inside a paragraph but are never an item
export const inline = "span, em, strong, b, i, u, small, time, abbr, code, mark, sup, sub";

// The level in the chain that's most likely an item. A post or article marked as one wins
// when the page has more like it, even if they aren't siblings (feeds often wrap each
// post in a box of its own, as LinkedIn does), and so does a list item with a stable
// attribute (LinkedIn's posts are list items with a componentkey). Otherwise it's the
// first level that repeats, at or around anything clickable the click was in, where the
// repeats have what it has: a table row's cells are alike, but only one has the link,
// and a card's image and text columns are alike, but only one has the heading.
export const guessLevel = (chain) => {
  // Items never hold one another, so only the outermost matches count: a post with a
  // carousel of its own (Pinterest's) is still an item, and generic markers wrapping the
  // whole page as well as each post (LinkedIn's "auto-component-") aren't.
  const items = (el) => {
    const selector = signature(el);
    const outermost = [...document.querySelectorAll(selector)].filter(m => !m.parentElement?.closest(selector));
    return outermost.length >= 2 && outermost.includes(el);
  };
  const marked = (el) => el.matches("article, [role=article]") ||
    el.matches("li, [role=listitem]") && signature(el).includes("[");
  const article = chain.findIndex(el => marked(el) && items(el));
  if (article != -1) return article;
  // what was clicked in is at least as big as an item, like a chat in a list of them that's
  // a button, so the lines of words inside it, which look alike too, aren't items
  const clickable = Math.max(0, chain.findIndex(el => el.matches(clickables)));
  const level = chain.findIndex((el, i) => {
    if (i < clickable || el.matches(inline)) return false;
    const siblings = similarSiblings(el);
    const alike = siblings.filter(s => sameShape(el, s));
    return alike.length >= 2 && alike.length >= siblings.length * 0.8;
  });
  return level == -1 ? 0 : level;
}

// a selector for el that finds it again from root
export const relativeSelector = (root, el) => {
  if (el == root) return "";
  // a link around a timestamp is usually the link to the item itself
  if (root.querySelector("a[href]:has(time)") == el) return "a[href]:has(time)";
  const path = [];
  for (let at = el; at != root; at = at.parentElement) path.unshift(signature(at));
  // the shortest ending of the path that still finds el first
  for (let i = path.length - 1; i >= 0; i--) {
    const selector = path.slice(i).join(" ");
    if (root.querySelector(selector) == el) return selector;
  }
  // else the whole way down, saying which child where others look the same (items made
  // from one template have their parts in the same places)
  const steps = [];
  for (let at = el; at != root; at = at.parentElement) {
    const step = signature(at);
    const alike = [...at.parentElement.children].filter(c => c.matches(step));
    steps.unshift(alike.length > 1 ? `${step}:nth-child(${[...at.parentElement.children].indexOf(at) + 1})` : step);
  }
  return `:scope > ${steps.join(" > ")}`;
}

const hasText = (el) => el.textContent.trim().length > 0;

// whether el takes up room on the page; headings only for screen readers (LinkedIn's
// "Feed post" on every post) don't
const takesRoom = (el) => {
  const box = el.getBoundingClientRect();
  return box.width > 1 && box.height > 1;
}

const within = (root, el) => el && root.contains(el) ? el : null;

// The item's biggest picture, leaving out avatars and icons. Pictures that haven't
// loaded yet count by the size the page gives them.
const pictureIn = (root) => {
  const area = (img) => {
    const r = img.getBoundingClientRect();
    return Math.max(r.width * r.height, (Number(img.getAttribute("width")) * Number(img.getAttribute("height"))) || 0);
  };
  return [...root.querySelectorAll("img")].map(img => ({ img, area: area(img) }))
    .filter(({ area }) => area >= 64 * 64).sort((a, b) => b.area - a.area)[0]?.img ?? null;
}

// Guesses which parts of an item are its title, link, image and text. clicked is what the
// person clicked, which wins as the field it looks like.
export const guessFields = (root, clicked) => {
  const clickedLink = within(root, clicked.closest("a[href]"));
  const clickedHeading = within(root, clicked.closest("h1, h2, h3, h4, h5, h6"));
  // words clicked that aren't a heading or link are the text: the block they're in,
  // unless that's the whole item
  const block = !clickedHeading && !clickedLink && !clicked.matches("img, picture")
    ? within(root, clicked.closest(`:not(${inline})`)) : null;
  const clickedText = block != root ? block : null;
  const outsideText = (el) => !clickedText?.contains(el);
  const links = [...root.querySelectorAll("a[href]")].filter(el => hasText(el) && outsideText(el));
  // the words clicked are the title when they're a heading or a link, and otherwise
  // a heading, something called a title that links somewhere, or the longest link
  const title = clickedHeading ?? (clickedLink && hasText(clickedLink) ? clickedLink : null) ??
    [...root.querySelectorAll("h1, h2, h3, h4, h5, h6")].find(el => hasText(el) && takesRoom(el) && outsideText(el)) ??
    [...root.querySelectorAll("[class*=title], [class*=headline]")].find(el => hasText(el) && hasLink(el) && outsideText(el)) ??
    // words with a tooltip of themselves, like a name cut short to fit (Instagram's
    // chats), even among the words clicked
    [...root.querySelectorAll("[title]")].find(el => hasText(el) && el.textContent.trim() == el.getAttribute("title").trim()) ??
    links.sort((a, b) => b.textContent.length - a.textContent.length)[0];
  // words clicked that hold the title are the title and the rest, like a chat's name and
  // its last message, so the text is the biggest block of the rest
  const rest = clickedText && title && clickedText.contains(title) && clickedText != title
    ? [...clickedText.querySelectorAll(`:not(${inline})`)].filter(el => hasText(el) && !el.contains(title) && !title.contains(el))
      .sort((a, b) => b.textContent.length - a.textContent.length)[0] : null;
  // the link clicked, the heading's link, a link around a timestamp, then any
  const url = root.matches("a[href]") ? root : clickedLink ?? clickedHeading?.closest("a[href]") ?? clickedHeading?.querySelector("a[href]") ??
    root.querySelector("a[href]:has(time)") ?? title?.closest("a[href]") ?? title?.querySelector("a[href]") ?? links[0] ?? root.querySelector("a[href]");
  const image = root.matches("img") ? root : pictureIn(root);
  const text = rest ? rest : clickedText && !clickedText.contains(title) && clickedText.textContent.trim().length > 20 ? clickedText
    : [...root.querySelectorAll("p, [class*=summary], [class*=description], [class*=dek], [class*=excerpt], [class*=teaser], [data-testid*=text i]")]
      .find(el => el.textContent.trim().length > 40 && !el.contains(title) && !title?.contains(el));
  const fields = { title, url, image, text };
  if (clicked.matches("img, picture")) fields.image = clicked;
  // a title without words is no title
  if (fields.title && !hasText(fields.title)) delete fields.title;
  return Object.fromEntries(Object.entries(fields).filter(([, el]) => el && root.contains(el))
    .map(([name, el]) => [name, { selector: relativeSelector(root, el) }]));
}

// whether el's signature says something about it beyond its tag
const isStable = (el) => /[[.:]/.test(signature(el));

// The selector for all items like root, where at least 80% of the matches have the same
// fields, or else whichever comes closest. It tries root's shared signature, then that
// signature for only the ones holding what root holds on the way to the clicked element
// (feeds wrap ads like posts), then the signature with more and more ancestors in front.
// Pages whose classes are all generated (Instagram's) leave little to go by, so then it
// tries the way to root from its nearest ancestor with an attribute that says what it is
// (like Meta's data-pagelet), then the way down from root to the first thing on the way
// to the clicked element that says what it is (like a [role=button]), before ancestors'
// signatures. Items never hold one another, so where a selector's matches do, only the outermost count.
// Pictures don't count, since plenty of posts in a feed have none.
export const itemSelectorFor = (root, fields, clicked) => {
  const { image, ...needed } = fields;
  const shapeMatches = (el) => Object.values(needed).every(f => !f.selector || el.querySelector(f.selector));
  const own = sharedSignature(root);
  const down = ancestry(clicked);
  const child = down.find(el => el.parentElement == root);
  const candidates = [own, child && `${own}:has(> ${signature(child)})`];
  const path = down.slice(0, down.indexOf(root)).reverse();
  const landmark = path.findIndex(isStable);
  const anchor = ancestry(root.parentElement ?? root).find(el => /\[/.test(signature(el)));
  if (anchor) {
    const steps = ancestry(root).slice(0, ancestry(root).indexOf(anchor)).reverse().map(el => signature(el));
    candidates.push(`${signature(anchor)} > ${steps.join(" > ")}`);
  }
  if (landmark != -1) {
    const shaped = `${own}:has(> ${path.slice(0, landmark + 1).map(el => signature(el)).join(" > ")})`;
    candidates.push(anchor && `${signature(anchor)} ${shaped}`, shaped);
  }
  const parts = [own];
  for (let at = root.parentElement, depth = 0; at && at != document.body && depth < 3; at = at.parentElement, depth++) {
    parts.unshift(signature(at));
    candidates.push(parts.join(" > "));
  }
  // only the outermost matches, for a selector whose matches hold one another
  const outermost = (selector) => [...document.querySelectorAll(selector)].some(m => m.parentElement?.closest(selector))
    ? `${selector}:not(${selector} *)` : selector;
  let best = null;
  // lists that only draw what's on screen leave empty places for the rest, which don't count
  const drawn = (el) => el.textContent.trim() || el.querySelector("img");
  for (const selector of candidates.filter(Boolean).map(outermost)) {
    const matches = [...document.querySelectorAll(selector)].filter(drawn);
    const score = matches.includes(root) ? matches.filter(shapeMatches).length / matches.length : 0;
    if (score >= 0.8) return selector;
    if (score > (best?.score ?? -1)) best = { selector, score };
  }
  return best.selector;
}
