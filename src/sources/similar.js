// Sorting things by topic: grouping a window's tabs, and finding the list a source's item
// belongs in. Texts become vectors that point the same way when they're about the same
// thing (see Offscreen/embed.js), so how alike two texts are is how close their vectors'
// directions are, from about 0 for unrelated texts to 1 for the same.

// how alike tabs must be to group them, and items to lists to go in them, found by trying
// (unrelated titles come out around 0.1, and ones about the same thing 0.3 and up)
const groupLike = 0.26;
const listLike = 0.33;

export const embed = async (texts) => {
  const { vectors, error } = await chrome.runtime.sendMessage({ type: "embed", texts });
  if (error) throw new Error(error);
  return vectors;
}

const alike = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);

// What a tab, saved tab or item is about: its title, or its words. Titles often end with
// the site's name ("Pizza - Wikipedia"), which says nothing about the page and makes
// every page from the site look alike, so a short last part like that is left out.
export const textOf = (item) => {
  const words = item.type == "text" ? item.text
    : item.type == "image" ? item.alt
      : item.type == "page" ? `${item.title} ${(item.body ?? "").replace(/!\[[^\]]*\]\([^)]*\)/g, "")}`
        : (item.title ?? "").replace(/\s+[-|–—·]\s+[^-|–—·]{1,30}$/, "");
  return (words ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
}

// Group things about the same topic. Each starts alone, then the two most alike groups
// join (going by how alike their members are on average) until no two are alike enough.
// Returns groups of indexes into vectors, biggest first, leaving out ones on their own.
// fixed groups (indexes too) are already together, and only take more in.
export const cluster = (vectors, fixed = [], threshold = groupLike) => {
  const inFixed = new Set(fixed.flat());
  let groups = [...fixed.map(members => ({ members, fixed: true })),
    ...vectors.flatMap((_, i) => inFixed.has(i) ? [] : [{ members: [i] }])];
  const pairs = vectors.map(a => vectors.map(b => alike(a, b)));
  const between = (g, h) => {
    let sum = 0;
    for (const i of g.members) for (const j of h.members) sum += pairs[i][j];
    return sum / (g.members.length * h.members.length);
  };
  for (; ;) {
    let best = null;
    groups.forEach((g, a) => groups.forEach((h, b) => {
      if (b <= a || (g.fixed && h.fixed)) return;
      const score = between(g, h);
      if (score >= threshold && score > (best?.score ?? -1)) best = { a, b, score };
    }));
    if (!best) break;
    const [g, h] = [groups[best.a], groups[best.b]];
    groups = groups.filter(x => x != g && x != h);
    groups.push({ members: [...g.members, ...h.members], fixed: g.fixed || h.fixed });
  }
  return groups.filter(g => g.fixed || g.members.length > 1)
    .sort((g, h) => h.members.length - g.members.length);
}

const stopWords = new Set(("a an and are as at be but by can com do for from get has have how i if in into is it its " +
  "just more my new no not now of on one or our out so than that the their them then there these they this " +
  "to up us vs was we what when where which who why will with you your www html org net").split(" "));

const wordsOf = (text) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu)?.filter(w => !stopWords.has(w) && !/^\d+$/.test(w)));

const centerOf = (vectors) => {
  const sum = vectors[0].map((_, i) => vectors.reduce((total, v) => total + v[i], 0));
  const length = Math.hypot(...sum) || 1;
  return sum.map(x => x / length);
}

// Names for groups of texts (indexes into texts, whose vectors are vectors): each a word
// from its texts, the one most like the group as a whole, helped by how many of them
// have it. Uses embedding to turn the words into vectors.
export const namesFor = async (groups, texts, vectors, embedding = embed) => {
  const candidates = groups.map(members => {
    const counts = new Map();
    members.forEach(i => wordsOf(texts[i]).forEach(w => counts.set(w, (counts.get(w) ?? 0) + 1)));
    return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 30);
  });
  const words = [...new Set(candidates.flat().map(([w]) => w))];
  const wordVectors = new Map(words.length ? (await embedding(words)).map((v, i) => [words[i], v]) : []);
  return groups.map((members, g) => {
    const center = centerOf(members.map(i => vectors[i]));
    const best = candidates[g].map(([word, count]) => ({
      word, score: alike(wordVectors.get(word), center) + 0.1 * count / members.length,
    })).sort((a, b) => b.score - a.score)[0];
    return best ? best.word[0].toUpperCase() + best.word.slice(1) : "";
  });
}

// Which list each item belongs in, if any: the list whose name it's most like, or whose
// items are most like it (going by the three most like it, so a list with a few topics
// still draws in each). lists are { name, items }, as vectors, with name null for lists
// whose name says nothing. Returns a list index, or -1, for each item.
export const bestLists = (items, lists, threshold = listLike) => items.map(item => {
  let best = -1;
  let bestScore = threshold;
  lists.forEach((list, index) => {
    const nearest = list.items.map(v => alike(item, v)).sort((a, b) => b - a).slice(0, 3);
    const byItems = nearest.length ? nearest.reduce((a, b) => a + b) / nearest.length : 0;
    const byName = list.name ? alike(item, list.name) : 0;
    const score = Math.max(byItems, byName);
    if (score >= bestScore) {
      best = index;
      bestScore = score;
    }
  });
  return best;
});
