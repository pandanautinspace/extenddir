// Comparing what a refresh gets with the items picked, for the picker to show what each
// way of refreshing would do before saving.

import { itemKey } from './extract';

// The parts of an item to compare: its title, picture and words. Pictures compare
// without their query, which often only says what size to show them at.
export const partsOf = (item) => ({
  title: item.title ?? item.alt ?? "",
  picture: (item.src ?? item.body?.match(/^!\[\]\(<(.+?)>\)/)?.[1] ?? "").replace(/[?#].*$/, ""),
  words: item.text ?? item.body?.replace(/^!\[\]\(<.+?>\)\s*/, "") ?? "",
});

export const partNames = { title: "titles", picture: "pictures", words: "texts" };

// How a refresh's items compare with the ones picked: how many of these it finds, for each
// part that comes out different how many and the first example, and the first items side
// by side. A part only the picked item is missing (like a picture further down that hadn't
// loaded) doesn't count.
export const compare = (here, fresh) => {
  const freshByKey = new Map(fresh.map(item => [itemKey(item), item]));
  const rows = here.map(item => [item, freshByKey.get(itemKey(item)) ?? null]);
  const pairs = rows.filter(([, item]) => item);
  const differences = Object.keys(partNames).map(part => {
    const differ = pairs.filter(([a, b]) => partsOf(a)[part] && partsOf(a)[part] != partsOf(b)[part]);
    return differ.length > 0 && { part, count: differ.length, here: partsOf(differ[0][0])[part], there: partsOf(differ[0][1])[part] };
  }).filter(Boolean);
  return { found: pairs.length, of: here.length, extra: fresh.length - pairs.length, differences, rows: rows.slice(0, 12) };
}

// whether one comparison is better than another: more found, then fewer parts different
export const better = (a, b) => a.found != b.found ? a.found > b.found
  : a.differences.reduce((n, d) => n + d.count, 0) < b.differences.reduce((n, d) => n + d.count, 0);
