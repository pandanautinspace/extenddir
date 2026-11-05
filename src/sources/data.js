// Reading items from the data a page embeds for its scripts. Pages built with JavaScript
// often ship their content as JSON inside the page (YouTube's ytInitialData, Next.js's
// __NEXT_DATA__) and draw it after loading, so a page that's only downloaded, never
// shown, has no items to read but does have that JSON. When an item is picked, the
// picker learns where in the JSON its values are, as paths with "*" for the position
// in the list of items:
//   data: { where: { name } or { id }, fields: { title: ["contents", "*", "title"], ... } }
// where is the variable the page assigns the JSON to, or the id of the script holding it.

import { absolute, clean, dedupe, makeItem } from './extract';

// the end of the {...} object starting at start, skipping over strings, or -1
const objectEnd = (text, start) => {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c == '"') {
      for (i++; i < text.length && text[i] != '"'; i++) if (text[i] == "\\") i++;
    } else if (c == "{") depth++;
    else if (c == "}" && --depth == 0) return i + 1;
  }
  return -1;
}

// the JSON a page embeds: script tags of JSON with an id, and objects assigned to variables
export const embeddedData = (doc) => {
  const blobs = [];
  for (const script of doc.querySelectorAll("script")) {
    const text = script.textContent;
    if (/json/.test(script.type)) {
      if (!script.id) continue;
      try { blobs.push({ where: { id: script.id }, data: JSON.parse(text) }); } catch { }
      continue;
    }
    for (const match of text.matchAll(/(?:\b(?:var|let|const)\s+|window\.|window\[["'])([\w$]+)["']?\]?\s*=\s*\{/g)) {
      const start = match.index + match[0].length - 1;
      const end = objectEnd(text, start);
      if (end == -1) continue;
      try { blobs.push({ where: { name: match[1] }, data: JSON.parse(text.slice(start, end)) }); } catch { }
    }
  }
  return blobs;
}

const sameWhere = (a, b) => a.id == b.id && a.name == b.name;

// the paths in data to strings that are wanted, up to a limit
const pathsTo = (data, wanted, limit = 20) => {
  const found = [];
  const walk = (node, path) => {
    if (found.length >= limit) return;
    if (typeof node == "string") {
      if (wanted(node)) found.push(path);
    } else if (node && typeof node == "object") {
      for (const key of Object.keys(node)) walk(node[key], [...path, Array.isArray(node) ? Number(key) : key]);
    }
  };
  walk(data, []);
  return found;
}

// the pattern two paths to different items share, with "*" where their list positions differ
const commonPattern = (a, b) => {
  if (a.length != b.length || !a.every((key, i) => key === b[i] || (typeof key == "number" && typeof b[i] == "number"))) return null;
  const pattern = a.map((key, i) => key === b[i] ? key : "*");
  return pattern.includes("*") ? pattern : null;
}

const fieldNames = ["title", "url", "text", "image"];

// every way of filling in a pattern's stars that reaches a value: one per item
const entriesOf = (data, pattern) => {
  const entries = [];
  const walk = (node, i, stars) => {
    if (node == null) return;
    if (i == pattern.length) return entries.push(stars);
    if (pattern[i] != "*") return walk(node[pattern[i]], i + 1, stars);
    if (Array.isArray(node)) node.forEach((child, j) => walk(child, i + 1, [...stars, j]));
  };
  walk(data, 0, []);
  return entries;
}

const valueAt = (data, pattern, stars) => {
  let star = 0;
  return pattern.reduce((node, key) => node?.[key == "*" ? stars[star++] : key], data);
}

// the part of a pattern up to its last star: the entry for one item in the list
const entryOf = (pattern) => pattern.slice(0, pattern.lastIndexOf("*") + 1);

// Within each item's entry, the shortest path to words under a key named like the field
// (title, headline, name), for a field whose words the page shows differently from its
// data. It has to give words for the first two items.
const namedField = (data, entry, named) => {
  const [first, second] = entriesOf(data, entry);
  if (!second) return null;
  const node = valueAt(data, entry, first);
  const paths = pathsTo(node, s => s.trim().length > 2 && s.length < 500 && !/^(\/|https?:)/.test(s), 2000)
    .filter(path => path.some(key => typeof key == "string" && named.test(key)))
    .sort((a, b) => a.length - b.length);
  const path = paths.find(p => typeof valueAt(data, [...entry, ...p], second) == "string");
  return path ? [...entry, ...path] : null;
}

const namedLike = { title: /title|headline|name/i, text: /description|summary|snippet|body/i };

// The path patterns to the picked items' values in the page's JSON, or null if they
// aren't there. values are the picked items' field values, in order.
export const learnData = (doc, values, baseUrl) => {
  const isAddress = (s) => s.length < 2000 && /^(\/|https?:)/.test(s);
  // images are often shown at another size than the page lists, which changes the query
  const withoutQuery = (url) => url?.replace(/[?#].*$/, "");
  const sameWords = (value) => (s) => s.length < value.length * 2 && clean(s) == value;
  // words the page shows with more around them, like a badge or a duration
  const partOfWords = (value) => (s) => {
    const words = clean(s);
    return words.length >= 8 && words.length < value.length && value.includes(words);
  };
  const matches = {
    title: [sameWords, partOfWords],
    text: [sameWords, partOfWords],
    url: [(value) => (s) => isAddress(s) && absolute(s, baseUrl) == value],
    image: [(value) => (s) => isAddress(s) && withoutQuery(absolute(s, baseUrl)) == withoutQuery(value)],
  };
  // the pattern for a field, from the first two items whose values are there (the page
  // may have changed a little), the shortest way there when there are several, since
  // that's the least likely to change
  const learn = (data, name, match) => {
    const found = values.filter(v => v[name]).slice(0, 6)
      .map(v => pathsTo(data, match(v[name]))).filter(paths => paths.length).slice(0, 2);
    if (found.length < 2) return null;
    return found[0].flatMap(a => found[1].map(b => commonPattern(a, b))).filter(Boolean)
      .sort((a, b) => a.length - b.length)[0] ?? null;
  };
  for (const blob of embeddedData(doc)) {
    const fields = {};
    for (const name of fieldNames) {
      const pattern = matches[name].reduce((found, match) => found ?? learn(blob.data, name, match), null);
      if (pattern) fields[name] = pattern;
    }
    const anchor = fieldNames.find(name => fields[name]);
    if (!anchor) continue;
    // every field is read from the same entry in the list as the anchor
    const entry = entryOf(fields[anchor]);
    for (const name of Object.keys(fields)) {
      if (JSON.stringify(entryOf(fields[name])) != JSON.stringify(entry)) delete fields[name];
    }
    // words the page has but that weren't found go by what the data calls them
    for (const name of ["title", "text"]) {
      if (!fields[name] && values.some(v => v[name])) {
        const pattern = namedField(blob.data, entry, namedLike[name]);
        if (pattern) fields[name] = pattern;
      }
    }
    return { where: blob.where, fields };
  }
  return null;
}

// the items in a downloaded page's JSON, by the paths learnData found
export const extractData = (doc, data, itemType, baseUrl) => {
  const blob = embeddedData(doc).find(b => sameWhere(b.where, data.where));
  if (!blob) return [];
  const anchor = data.fields[fieldNames.find(name => data.fields[name])];
  return dedupe(entriesOf(blob.data, anchor).map(stars => {
    const value = (name) => {
      const found = data.fields[name] && valueAt(blob.data, data.fields[name], stars);
      return typeof found == "string" ? found : null;
    };
    return makeItem(itemType, {
      title: clean(value("title")),
      url: value("url") ? absolute(value("url"), baseUrl) : null,
      image: value("image") ? absolute(value("image"), baseUrl) : null,
      text: clean(value("text")),
    }, baseUrl);
  }).filter(Boolean)).map(item => ({ ...item, sourced: true }));
}
