// Injected into a page from the popup. Hover to see what you'd pick, click an item to
// collect all the items like it, then save them, with where they came from, to a list.

import { partNames, partsOf } from '../../sources/compare';
import { checkDownload, fetchText } from '../../sources/download';
import { enoughItems, extractItems, fieldValues, guessType } from '../../sources/extract';
import { addList, addSource, loadAllLists, updateList, withFreshItems } from '../../sources/lists';
import { ancestry, guessFields, guessLevel, inline, itemSelectorFor, relativeSelector } from '../../sources/selectors';

const style = `
  :host { all: initial; position: absolute; top: 0; left: 0; z-index: 2147483647; }
  * { box-sizing: border-box; font: 13px/1.4 system-ui, sans-serif; color: #1a202c; }
  .hover { position: fixed; pointer-events: none; border: 2px solid #3182ce; background: rgba(49,130,206,.08); border-radius: 3px; }
  .match { position: absolute; pointer-events: none; border: 2px solid #38a169; background: rgba(56,161,105,.08); border-radius: 3px; }
  .match.chosen { border-color: #2f855a; border-width: 3px; }
  .panel { position: fixed; inset: auto 16px 16px auto; margin: 0; border: none; width: 320px; max-height: 80vh; overflow-y: auto; padding: 12px;
    background: white; border-radius: 10px; box-shadow: 0 6px 30px rgba(0,0,0,.25); display: flex; flex-direction: column; gap: 10px; }
  .row { display: flex; align-items: center; gap: 6px; }
  .grow { flex: 1; min-width: 0; }
  .title { font-weight: 600; }
  .muted { color: #718096; font-size: 12px; }
  .truncate { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  button, select { padding: 4px 10px; border: 1px solid #cbd5e0; border-radius: 6px; background: white; cursor: pointer; }
  button:hover { background: #edf2f7; }
  button:disabled { opacity: .4; cursor: default; }
  button.primary { background: #3182ce; border-color: #3182ce; color: white; font-weight: 600; }
  button.close { border: none; padding: 0 6px; font-size: 16px; color: #718096; }
  select { flex: 1; min-width: 0; }
  label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
  .preview { display: flex; flex-direction: column; gap: 6px; padding: 8px; background: #f7fafc; border-radius: 6px; }
  .preview img { width: 36px; height: 36px; object-fit: cover; border-radius: 4px; flex-shrink: 0; }
  .hover.choosing { border-color: #805ad5; background: rgba(128,90,213,.12); }
  .choosing { padding: 6px 8px; background: #faf5ff; color: #553c9a; border-radius: 6px; }
  .field { width: 36px; }
  button.small { padding: 1px 8px; font-size: 12px; }
  button.active { background: #805ad5; border-color: #805ad5; color: white; }
  .check { display: flex; flex-direction: column; gap: 4px; }
  .subtitle { font-weight: 600; font-size: 12px; color: #4a5568; }
  .good { color: #2f855a; font-weight: 600; }
  .okay { color: #b7791f; font-weight: 600; }
  .bad { color: #c53030; font-weight: 600; }
  .indent { padding-left: 18px; }
  .panel.wide { width: 460px; }
  .method { cursor: pointer; border-radius: 4px; }
  .method:hover { background: #f7fafc; }
  .details { display: flex; flex-direction: column; gap: 6px; margin: 2px 0 6px 18px; padding: 8px; background: #f7fafc; border-radius: 6px; }
  .reads { font: 11px/1.4 ui-monospace, monospace; color: #4a5568; word-break: break-all; }
  .side { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 8px; font-size: 12px; }
  .side > * { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 12px; }
  .side .head { font-weight: 600; color: #4a5568; }
  .side .bad { font-weight: 400; }
`;

const fieldNames = { title: "Title", url: "Link", image: "Image", text: "Text" };
const typeNames = { link: "Links", text: "Notes", image: "Images", page: "Pages" };
// the ways of refreshing, in the order a refresh tries them (see Background/refresh.js)
const methodNames = {
  fetch: "Downloading it", data: "Reading its data", frame: "Loading it out of sight", tab: "Loading it in a tab",
};

// a tiny element builder: h("div", { class: "row", onclick }, child, ...)
const h = (tag, props = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (value != null && value !== false) el.setAttribute(key, value === true ? "" : value);
  }
  el.append(...children.flat().filter(c => c != null && c !== false));
  return el;
}

const start = () => {
  const host = h("extenddir-picker");
  const shadow = host.attachShadow({ mode: "open" });
  const hoverBox = h("div", { class: "hover" });
  const matchLayer = h("div");
  // the panel goes in the top layer, above anything the page shows, whatever its z-index
  const panel = h("div", { class: "panel", popover: "manual" });
  shadow.append(h("style", {}, style), matchLayer, hoverBox, panel);

  // Inline !important beats page styles that hide things they don't know. The page may
  // also take the picker out from beside its body, so then it goes back inside the body.
  let attachments = 0;
  const attach = () => {
    if (host.isConnected) return;
    (attachments++ ? document.body : document.documentElement).append(host);
    panel.showPopover();
  }
  host.style.setProperty("display", "block", "important");
  host.style.setProperty("visibility", "visible", "important");
  attach();
  const keepAttached = setInterval(attach, 250);

  // What's been picked: the clicked element, how far up from it the item is, the fields
  // switched off, the ones chosen by hand ({ title: { selector } }), the field being
  // chosen, and the check of what a refresh will get, with what it was checked for.
  let picked = null;
  let lists = [];
  loadAllLists().then(l => { lists = l; render(); });

  const inPicker = (e) => e.composedPath().includes(host);

  // SVG pieces aren't useful items, so use whatever holds the SVG
  const pickable = (el) => el instanceof SVGElement ? el.closest("svg")?.parentElement ?? el : el;

  const showBox = (box, el, fixed) => {
    const r = el.getBoundingClientRect();
    Object.assign(box.style, {
      left: `${r.left + (fixed ? 0 : scrollX)}px`, top: `${r.top + (fixed ? 0 : scrollY)}px`,
      width: `${r.width}px`, height: `${r.height}px`, display: r.width ? "block" : "none",
    });
  }

  // the picked item, its fields (guessed, then chosen), every item like it, and what
  // they'll become
  const current = () => {
    const root = picked.chain[picked.level];
    const detected = { ...guessFields(root, picked.clicked), ...picked.chosen };
    const fields = Object.fromEntries(Object.entries(detected).filter(([name]) => !picked.off.includes(name)));
    const itemSelector = itemSelectorFor(root, fields, picked.clicked);
    const matches = [...document.querySelectorAll(itemSelector)];
    const itemType = picked.type ?? guessType(fieldValues(root, fields, location.href));
    return { root, fields, itemSelector, matches, itemType, detected };
  }

  // What a click picks: what's under the pointer, or the picture under something laid over
  // it in the same link, like the counts Instagram shows over its grid's pictures
  const pickAt = (e) => {
    const target = pickable(e.target);
    const link = target.closest("a[href]");
    const picture = link && target.tagName != "IMG" && document.elementsFromPoint(e.clientX, e.clientY)
      .find(el => el.tagName == "IMG" && link.contains(el));
    return picture || target;
  }

  const pick = (el) => {
    const chain = ancestry(el);
    picked = { clicked: el, chain, level: guessLevel(chain), off: [], chosen: {}, choosing: null, type: null, target: "source" };
    render();
  }

  // What clicking at a point chooses as a field, and the item it's in. It looks under
  // links laid over whole items (Reddit) and badges laid over pictures (YouTube) for a
  // picture, a link, or words, and takes the whole block of words for text.
  const chooseAt = (e, name) => {
    const stack = document.elementsFromPoint(e.clientX, e.clientY).filter(el => el != host);
    const target = pickable(e.target);
    const ownWords = (el) => [...el.childNodes].some(n => n.nodeType == Node.TEXT_NODE && n.textContent.trim());
    let el = name == "image" ? stack.find(el => el.tagName == "IMG") ?? target.querySelector("img") ?? target
      : name == "url" ? stack.map(el => el.closest("a[href]")).find(Boolean) ?? target
      : stack.find(ownWords) ?? target;
    const root = current().matches.find(m => m.contains(el));
    if (!root) return null;
    if (name == "text") el = el.closest(`:not(${inline})`) ?? el;
    // the outermost element with just these words, short of the whole item
    if (name == "title" || name == "text") {
      while (el != root && el.parentElement != root && el.parentElement.textContent.trim() == el.textContent.trim()) el = el.parentElement;
    }
    return { el, root };
  }

  const onMove = (e) => {
    if (inPicker(e)) return;
    const choosing = picked?.choosing && chooseAt(e, picked.choosing);
    hoverBox.className = picked?.choosing ? "hover choosing" : "hover";
    showBox(hoverBox, choosing ? choosing.el : pickAt(e), true);
  }

  // Keep the page from following links or reacting to clicks while picking. A click picks
  // an item, or while choosing a field, the part of an item that's that field.
  const block = (e) => {
    if (inPicker(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (e.type != "click") return;
    if (!picked?.choosing) return pick(pickAt(e));
    const chosen = chooseAt(e, picked.choosing);
    if (!chosen) return;
    const name = picked.choosing;
    picked.chosen = { ...picked.chosen, [name]: { selector: relativeSelector(chosen.root, chosen.el) } };
    picked.off = picked.off.filter(n => n != name);
    picked.choosing = null;
    render();
  }

  const onKey = (e) => {
    if (e.key != "Escape") return;
    if (!picked?.choosing) return stop();
    picked.choosing = null;
    render();
  }

  const events = ["click", "mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "contextmenu"];
  events.forEach(type => document.addEventListener(type, block, true));
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("keydown", onKey, true);
  const onResize = () => picked && render();
  addEventListener("resize", onResize);

  const stop = () => {
    events.forEach(type => document.removeEventListener(type, block, true));
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("keydown", onKey, true);
    removeEventListener("resize", onResize);
    clearInterval(keepAttached);
    host.remove();
    delete window.__extenddirPicker;
  }

  // The extension tries refreshing what's picked the way a refresh would (see
  // Background/refresh.js), or null when it can't read the site.
  const tryFromExtension = (request) => chrome.runtime.sendMessage({ type: "try-refresh", ...request })
    .then(response => response && !response.error ? response : null, () => null);

  // Without the extension, this page downloads itself and checks that instead, which only
  // tells about downloading and reading its data. It's downloaded once.
  let download = null;
  const checkFromHere = async ({ source, here, values }) => {
    const page = await (download ??= fetchText(location.href).catch(() => null));
    return page ? checkDownload(page, source, here, values) : { results: [] };
  }

  // a try's results added to the check's, in place of any for the same way of refreshing
  const merge = (check, more) => ({
    ...check, ...more,
    results: [...check.results.filter(r => !more.results.some(m => m.method == r.method)), ...more.results],
  });

  // Tries refreshing again whenever what's picked changes: downloading first, since it's
  // quick, then loading it out of sight, which can take a while. Loading it in a tab
  // waits to be asked for, since it shows a tab.
  const checkIfChanged = ({ itemSelector, fields, itemType, matches }, here) => {
    const key = JSON.stringify([itemSelector, fields, itemType]);
    if (picked.checkKey == key) return;
    const source = { url: location.href, itemSelector, fields, itemType, expected: matches.length };
    const request = { source, here, values: matches.map(el => fieldValues(el, fields, location.href)) };
    const update = (more) => {
      if (picked?.checkKey != key) return;
      picked.check = merge(picked.check ?? { results: [] }, more);
      render();
    };
    const tryWay = async (method) => {
      update({ results: [{ method, pending: true }] });
      update(await tryFromExtension({ ...request, methods: [method] }) ?? { results: [{ method, error: "couldn't try it", ...emptyResult }] });
    };
    Object.assign(picked, { checkKey: key, check: null, tryTab: () => tryWay("tab") });
    picked.checking = (async () => {
      const fromExtension = await tryFromExtension({ ...request, methods: ["download"] });
      update(fromExtension ? { ...fromExtension, from: "extension" } : { ...await checkFromHere(request), from: "page" });
      if (fromExtension) tryWay("frame");
    })();
  }

  const emptyResult = { found: 0, of: 0, extra: 0, differences: [], rows: [] };

  // the order a refresh tries its ways in
  const methods = Object.keys(methodNames);
  const inOrder = (results) => [...results].sort((a, b) => methods.indexOf(a.method) - methods.indexOf(b.method));

  // Whether a way of refreshing gets enough items: ones like here, or new ones, since
  // feeds like X's timeline come back with other items every time they load.
  const getsEnough = (r, expected) => !r.pending && !r.error && r.found + r.extra >= enoughItems({ expected });

  // the way of refreshing to try first: the first that gets enough items the same as
  // here, or else enough items at all
  const bestMethod = (check, expected) => {
    const enough = (r) => getsEnough(r, expected);
    const results = inOrder(check.results);
    return (results.find(r => enough(r) && r.found >= enoughItems({ expected }) && !r.differences.length) ?? results.find(enough))?.method;
  }

  const save = async () => {
    const { fields, itemSelector, matches, itemType } = current();
    panel.querySelector("button.primary").textContent = "Saving…";
    await picked.checking;
    const check = picked.check;
    const source = {
      url: location.href, itemSelector, fields, itemType, expected: matches.length,
      data: check.data, html: check.html, method: bestMethod(check, matches.length),
    };
    const items = extractItems(document, source, location.href);
    const list = lists.find(l => l.id == picked.target);
    const name = document.title.slice(0, 40) || location.hostname;
    if (list) {
      await updateList(list.id, l => ({ ...l, source, tabs: withFreshItems(l.tabs, items) }));
    } else {
      await (picked.target == "list" ? addList : addSource)({ name, tabs: items, source });
    }
    matchLayer.replaceChildren();
    panel.replaceChildren(h("div", { class: "title" },
      `Saved ${items.length} items to ${list?.name ?? (picked.target == "list" ? "a new list" : "a new source")}`),
      h("div", { class: "muted" }, "Open a new tab to see them, and refresh them there to update them."));
    setTimeout(stop, 2500);
  }

  const previewOf = (item) => {
    if (!item) return null;
    const words = item.title || item.text || item.alt || item.body?.replace(/^!\[\]\(<.+?>\)\s*/, "") || item.url;
    // a page's image is the first thing in its body
    const image = item.src ?? item.body?.match(/^!\[\]\(<(.+?)>\)/)?.[1];
    return h("div", { class: "row" }, image && h("img", { src: image }), h("div", { class: "grow truncate" }, words || "(empty)"));
  }

  const render = () => {
    if (!picked) {
      panel.replaceChildren(
        h("div", { class: "row" }, h("div", { class: "title grow" }, "Pick items for a list"), h("button", { class: "close", onclick: stop }, "✕")),
        h("div", { class: "muted" }, "Click one item, like a headline or a card, and everything like it gets picked too. Esc to cancel."));
      return;
    }
    const { fields, itemSelector, matches, itemType, detected } = current();
    matchLayer.replaceChildren(...matches.slice(0, 300).map(el => {
      const box = h("div", { class: el == picked.chain[picked.level] ? "match chosen" : "match" });
      showBox(box, el, false);
      return box;
    }));
    const preview = extractItems(document, { itemSelector, fields, itemType }, location.href);
    const sample = fieldValues(picked.chain[picked.level], detected, location.href);
    const change = (changes) => { Object.assign(picked, changes); render(); };
    checkIfChanged({ itemSelector, fields, itemType, matches }, preview);

    const fieldRow = (name) => h("div", { class: "row" },
      h("input", {
        type: "checkbox", checked: !!detected[name] && !picked.off.includes(name), disabled: !detected[name],
        onchange: () => change({ off: picked.off.includes(name) ? picked.off.filter(n => n != name) : [...picked.off, name] }),
      }),
      h("span", { class: "field" }, fieldNames[name]),
      h("span", { class: "muted grow truncate", title: sample[name] ?? "" }, detected[name] ? sample[name] || "(empty in this one)" : "none"),
      h("button", {
        class: picked.choosing == name ? "small active" : "small",
        title: `Click here, then click the ${fieldNames[name].toLowerCase()} in any of the green items`,
        onclick: () => change({ choosing: picked.choosing == name ? null : name }),
      }, picked.choosing == name ? "Cancel" : "Choose"));

    const enough = (r) => getsEnough(r, preview.length);

    // where a way of refreshing reads a field from: a selector in each item, or a path in
    // the page's JSON, shortened to its end
    const readsFrom = (how) => Array.isArray(how)
      ? "…" + how.slice(-5).map(key => key == "*" ? "[each]" : typeof key == "number" ? `[${key}]` : `.${key}`).join("").replace(/^\./, "")
      : how.selector || "the item itself";

    // the items here beside what a way of refreshing got for them, with what it reads from
    const details = (r) => h("div", { class: "details" },
      r.note && h("div", { class: "muted" }, r.note),
      r.reads && h("div", { class: "reads" },
        Object.entries(r.reads).map(([name, how]) => h("div", {}, `${fieldNames[name]} ← ${readsFrom(how)}`))),
      h("div", { class: "side" },
        h("div", { class: "head" }, "On the page"), h("div", { class: "head" }, methodNames[r.method]),
        r.rows.flatMap(([here, there]) => {
          const a = partsOf(here);
          const b = there && partsOf(there);
          const differ = b ? Object.keys(partNames).filter(part => a[part] && a[part] != b[part]) : [];
          return [
            h("div", { title: [a.title, a.words, a.picture].filter(Boolean).join("\n") }, a.title || a.words || here.url || "(empty)"),
            !b ? h("div", { class: "bad" }, "not found")
              : h("div", { class: differ.length ? "bad" : "", title: [b.title, b.words, b.picture].filter(Boolean).join("\n") },
                (differ.length ? `(${differ.map(part => partNames[part]).join(", ")} differ) ` : "") + (b.title || b.words || "(no words)")),
          ];
        })),
      r.of > r.rows.length && h("div", { class: "muted" }, `and ${r.of - r.rows.length} more`));

    // a way of refreshing: how it does, and when opened, the items it got
    const resultView = (r) => {
      const open = picked.open == r.method;
      const same = enough(r) && r.found >= enoughItems({ expected: preview.length }) && !r.differences.length;
      const summary = r.pending ? "trying…" : r.error ? r.error
        : `${r.found} of ${r.of}${r.extra ? `, and ${r.extra} others` : ""}${same ? ", the same" : ""}`;
      return h("div", {},
        h("div", { class: "row method", onclick: () => !r.pending && change({ open: open ? null : r.method }) },
          h("span", { class: r.pending ? "muted" : same ? "good" : enough(r) ? "okay" : "bad" }, r.pending ? "…" : enough(r) ? "✓" : "✗"),
          h("span", { class: "grow" }, `${methodNames[r.method]}: ${summary}`),
          !r.pending && !r.error && h("span", { class: "muted" }, open ? "▾" : "▸")),
        !open && !r.pending && r.differences?.map(d => h("div", { class: "muted truncate indent" },
          `${d.count} ${partNames[d.part]} differ, like “${d.there || "nothing"}” for “${d.here || "nothing"}”`)),
        open && details(r));
    };

    const checkView = () => {
      const check = picked.check;
      if (!check) return h("div", { class: "muted" }, "Trying a refresh…");
      const results = inOrder(check.results);
      if (!results.length) return h("div", { class: "muted" }, "Couldn't download this page to try refreshing it.");
      return [
        check.from == "page" && h("div", { class: "muted" },
          "extenddir can't read this site yet, so this is only what this page can download. Pick again from the popup and allow it to try every way."),
        ...results.map(resultView),
        check.from == "extension" && !results.some(r => r.method == "tab") &&
          h("button", { class: "small", onclick: picked.tryTab, title: "Opens the page in a background tab for a moment" }, "Try loading it in a tab"),
        !results.some(r => r.pending || enough(r)) && h("div", { class: "muted" },
          "Nothing gets these items yet. Try choosing fields that every item has, or Wider or Narrower."),
      ];
    };

    panel.className = picked.open ? "panel wide" : "panel";

    panel.replaceChildren(
      h("div", { class: "row" },
        h("div", { class: "title grow", title: `Each item is ${itemSelector}` }, `${preview.length} items`),
        h("button", { onclick: () => change({ level: picked.level + 1, chosen: {} }), disabled: picked.level >= picked.chain.length - 1, title: "Pick a bigger part of the page" }, "Wider"),
        h("button", { onclick: () => change({ level: picked.level - 1, chosen: {} }), disabled: picked.level == 0, title: "Pick a smaller part of the page" }, "Narrower"),
        h("button", { class: "close", onclick: stop }, "✕")),
      picked.choosing
        ? h("div", { class: "choosing" }, `Click the ${fieldNames[picked.choosing].toLowerCase()} in any of the green items. Esc to stop.`)
        : h("div", { class: "muted" }, "Click another item to start over."),
      h("div", { class: "row" }, h("span", {}, "Save as"),
        h("select", { onchange: (e) => change({ type: e.target.value }) },
          Object.entries(typeNames).map(([type, name]) => h("option", { value: type, selected: type == itemType }, name)))),
      h("div", {}, Object.keys(fieldNames).map(fieldRow)),
      h("div", { class: "preview" }, preview.length
        ? [...preview.slice(0, 4).map(previewOf), preview.length > 4 && h("div", { class: "muted" }, `and ${preview.length - 4} more`)]
        : h("div", { class: "muted" }, "Nothing to save with these fields")),
      h("div", { class: "check" }, h("div", { class: "subtitle" }, "Refreshing"), checkView()),
      h("div", { class: "row" }, h("span", {}, "To"),
        h("select", { onchange: (e) => { picked.target = e.target.value; } },
          h("option", { value: "source" }, "A new source"),
          h("option", { value: "list", selected: picked.target == "list" }, "A new list"),
          lists.map(l => h("option", { value: l.id, selected: l.id == picked.target }, l.name)))),
      h("button", { class: "primary", onclick: save, disabled: !preview.length }, `Save ${preview.length} items`),
    );
  }

  render();
  return { stop };
}

// injecting again starts over; the popup reads the error to say why it didn't start
try {
  window.__extenddirPicker?.stop();
  window.__extenddirPickerError = null;
  window.__extenddirPicker = start();
} catch (error) {
  window.__extenddirPickerError = `${error.name}: ${error.message}`;
  throw error;
}
