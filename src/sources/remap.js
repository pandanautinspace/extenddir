// Finding the picked items in the page as it's downloaded. Pages that draw themselves with
// JavaScript often come down in a different layout than they're shown in, so the selectors
// picked on the page shown don't find anything in the download. This looks for the picked
// items' values in the download instead, and works out its own selectors from where they
// are: { itemSelector, fields }, used in place of the picked ones when refreshing by
// downloading.

import { absolute, clean, imageOf } from './extract';
import { relativeSelector, sharedSignature, signature } from './selectors';

const withoutQuery = (url) => url?.replace(/[?#].*$/, "");

// the smallest element in doc with exactly these words, outside scripts and styles
const elementWithWords = (doc, words) => {
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const piece = clean(node.textContent);
    if (!piece || !words.includes(piece) || node.parentElement.closest("script, style, noscript, template")) continue;
    for (let el = node.parentElement; el && el != doc.body; el = el.parentElement) {
      const text = clean(el.textContent);
      if (text == words) return el;
      if (text.length > words.length) break;
    }
  }
  return null;
}

const finders = {
  title: (doc, value) => elementWithWords(doc, value),
  text: (doc, value) => elementWithWords(doc, value),
  url: (doc, value, baseUrl) => [...doc.querySelectorAll("a[href]")].find(a => absolute(a.getAttribute("href"), baseUrl) == value),
  image: (doc, value, baseUrl) => [...doc.querySelectorAll("img")].find(img => withoutQuery(imageOf(img, baseUrl)) == withoutQuery(value)),
};

// the smallest element holding all of els
const holding = (els) => {
  let at = els[0];
  while (at && !els.every(el => at.contains(el))) at = at.parentElement;
  return at;
}

// Selectors for the picked items in a downloaded page, from their field values, or null
// when they can't be found there. It takes the first two items found: the elements their
// values are in, the smallest element holding each item's, and the two items' common
// container; each item is then the container's child holding it.
export const learnHtml = (doc, values, baseUrl) => {
  const found = values.slice(0, 8)
    .map(v => Object.fromEntries(Object.keys(finders).filter(name => v[name])
      .map(name => [name, finders[name](doc, v[name], baseUrl)]).filter(([, el]) => el)))
    .filter(f => Object.keys(f).length);
  if (found.length < 2) return null;
  const [first, second] = found;
  const a = holding(Object.values(first));
  const b = holding(Object.values(second));
  const container = a && b && holding([a, b]);
  if (!container || container == a || container == b) return null;
  const itemOf = (el) => {
    while (el.parentElement != container) el = el.parentElement;
    return el;
  };
  const root = itemOf(a);
  const other = itemOf(b);
  const fields = Object.fromEntries(Object.entries(first).map(([name, el]) => [name, { selector: relativeSelector(root, el) }]));
  // the item's signature, or with its container's in front if that alone takes in more
  // things than look like items
  const has = (el) => Object.values(fields).every(f => !f.selector || el.querySelector(f.selector));
  const own = sharedSignature(root);
  const itemSelector = [own, `${signature(container)} > ${own}`].find(selector => {
    const matches = [...doc.querySelectorAll(selector)];
    return matches.includes(root) && matches.includes(other) && matches.filter(has).length >= matches.length * 0.8;
  });
  return itemSelector ? { itemSelector, fields } : null;
}
