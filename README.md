# extenddir

A Chrome extension that replaces the new tab page with a tab manager. It's for organizing lists: on one side are the sources things come from, your open tabs and the web pages and feeds you've picked; on the other are your lists.

- Drag open tabs to reorder them or move them between windows.
- Tab groups show with their color and name. Drag a tab in or out of a group, or onto **+ New group** to start one. Click a group's name to rename it, its dot to change color, its arrow to collapse it (in Chrome too), or hover for **Ungroup**. Windows collapse the same way.
- Drag a group by its header to move the whole group. Dropped in a list, it becomes a subgroup there and its tabs close; dragged back to a window, it reopens as a tab group with the same name and color.
- Drag an open tab into a list to save it and close the tab.
- Drag a tab onto **+ New list**, or click it, to start a new list.
- Drag a saved tab back to a window to reopen it, or click it to open it here. Either way it leaves the list until you close the tab, then goes back where it was, as whatever page the tab was on. Open tabs that will go back show a ↩; hover it for which list. Dragging one into a list keeps it there instead. Hover a tab for its ✕.
- A list's **⋯** has **Open all in this window**, and hovering a subgroup shows **Open**. Subgroups open as tab groups, and their tabs go back into the subgroup when closed. Tabs only remember their list until Chrome closes.
- Click a list's name to rename it.
- Drag a list by its header to move it. **Columns**, **Grid** and **Stack** change how the lists are laid out. The grid stacks lists in columns, like a pinboard, and a list stays in the column you drag it to. A list's **⋯** sets it narrow, normal or wide (in columns), moves it to the start or end, or deletes it. Its arrow collapses it; in columns, a collapsed list stands on its side.
- A list's **+** adds a note, an image (by address), or a page written in markdown. Click one to view or edit it. They drag between lists like tabs, but stay put when dropped on a window.
- Cmd-click tabs to select several, or Shift-click to select a range. Dragging any selected tab moves them all. Esc clears the selection.
- Search filters open and saved tabs by title and address.
- **Group by topic** on a window groups its tabs by what they're about: tabs join the groups they're like, and tabs like each other but no group get a new group, named for what they share. Pinned tabs stay put. The message after has **Undo**.
- **Sidebar** / **Top** switches the open tabs and sources between columns on the left and a row above the lists.

Lists and sources are kept in `chrome.storage.local`.

## Syncing between computers

**Sync off** at the top right switches on **Sync lists through Chrome**, which keeps your lists in your Chrome profile (`chrome.storage.sync`), so they show up on your other computers signed in to Chrome, with extension sync on and this switched on there too. It's set on each computer.

- Lists sync whole: names, items, groups and widths. Sources sync what they read and how, but not the items they found, since each computer refreshes its own; nor whether they're shown.
- A change on one computer goes to the others a few seconds later. If the same list changed on two computers before they synced, it ends up with the items from both, so nothing's lost, though something removed on one can come back.
- Chrome keeps 100 KB for an extension's synced data, and lists are kept compressed, so that's a few thousand saved tabs. The menu shows how much is used, and says so if they don't fit.
- Chrome ties synced data to the extension's ID. The `key` in `src/manifest.json` fixes it (`djbehkgedndihcnohchaklkolmjbigka`) wherever the extension is loaded from, so every computer shares the same synced data. The private half of the key is `key.pem`, which isn't checked in; it's only needed to pack the extension.

The syncing is in `src/pages/Background/sync.js`.

## Sources

A source is a page or feed whose items you can refresh. Sources sit next to your open tabs, which are always shown. The **Sources** menu at the top shows or hides each one, or all of them, and a source's ✕ hides it. When more are shown than fit, they scroll sideways, so the lists keep at least half the page. **Refresh visible** refreshes the sources that are shown, and **Refresh all** every source, asking once for any sites the extension can't read yet.

- Drag a source's items into a list to copy them there. The source keeps them, and dims the ones that are in a list already. Click one to open it.
- **Sort into lists** at the top, or in a source's **⋯**, copies items from the sources into the lists they're like, by the lists' names and what's in them. Items already in a list, items of only a word or two, and empty lists still called "New List!" are left out. The message after has **Undo**.
- A source can be shown as a list, which refreshes the same way: drag it by its header among the lists, or choose **Show as a list** from its **⋯**. A list shown this way can go back with **Move to sources**, or by dragging it back. Lists you made yourself can't be sources.

## Sources from web pages

A source comes from a page and can be refreshed from it later.

- On any page, open the extension's popup and click **Pick items on this page**. Hover to see what you'd pick, and click one item, like a headline or a card. Everything like it on the page is picked too.
- The panel shows how many items were found. **Wider** and **Narrower** change how much of the page counts as one item. You can choose what to save them as (links, notes, images or pages), and switch off parts like the image or text.
- The picker guesses each item's title, link, image and text. To set one yourself, click its **Choose** and then click that part in any of the green items.
- Under **Refreshing**, the extension tries each way of refreshing what you've picked, as a refresh would, and compares what it gets with what you see: downloading the page and reading the data in it right away, loading it out of sight after that, and loading it in a tab when you click for it. Click a way to see where it reads each field from and its items beside the page's. Saving remembers the way that works, so the first refresh starts with it.
- Sites whose class names are all generated, like Instagram's and Pinterest's, change them whenever they're rebuilt, so the picker leaves those out and goes by what's stable: roles (`role=listitem`), names like Meta's `data-pagelet`, what links point to, and failing that, the item's place under something stable. A source picked before the picker knew a site's generated names can stop finding anything after the site updates; pick it again.
- Pages that redraw themselves often come down in another layout than they're shown in. The extension then finds your items in the download and reads it by its own selectors.
- Starting the picker asks for permission to read the site, so it can try refreshing it.
- **Save** adds them as a new source, a new list or to an existing list. Clicking another item starts over, and Esc cancels.
- If the page has an RSS or Atom feed, the popup offers it too. Feeds keep working when a page's layout changes.
- In the new tab page, a source, or a list from a page, has **↻** to refresh it. The first refresh asks for permission to read that site.
- A refresh replaces the items from before. Things you added to the list yourself, or edited, stay. Items you move to another list become yours there.
- Items without a link of their own link to the page they came from, scrolled to the item's words.
- If a refresh finds nothing, the list keeps its items and says it couldn't refresh. Hover that message for why.

Pages are read the cheapest way that works, and the list remembers which way worked:

1. Downloading the page, for pages that come with their content.
2. Reading the data the page embeds for its scripts, for pages like YouTube that draw their content from it. When you save, the picker looks for your items in that data and remembers where they are.
3. Loading it in a hidden frame, for pages that fill in with JavaScript.
4. Loading it in a background tab, for pages that won't load in a frame or need you signed in, like X, LinkedIn and Instagram. Chrome doesn't draw tabs in the background, and feeds like Instagram's only load more when they're drawn, so the extension screencasts the tab (at the smallest size) while it reads it, which makes Chrome draw it. Chrome shows a bar saying the extension is debugging the browser meanwhile; that's this.

A page loaded in a frame or tab is scrolled until it has 30 items, or as many as you picked, collecting them along the way, since feeds like X's only keep the items on screen. Feeds that show different items every time count as working when a refresh gets enough new ones.

The picker is in `src/pages/Picker/`, refreshing is in `src/pages/Background/refresh.js`, and finding and reading items is in `src/sources/`.

## Sorting by topic

Grouping tabs and sorting items into lists compare what texts are about with a small sentence model, [all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2), run in the extension's hidden offscreen page (`src/pages/Offscreen/embed.js`), so titles aren't sent anywhere. The first use downloads the model from Hugging Face (about 23 MB), and the browser caches it. The code that runs it comes with the extension in `build/ort/`. How alike things must be is set in `src/sources/similar.js`. Very short titles are hard to judge, so a one-word title can land in an odd group.

## Development

Requires Node.js 18 or later.

```sh
npm install
npm start          # dev build with auto-reload, written to build/
```

The dev server runs on port 3737. Run it as `PORT=4000 npm start` to use another one.

Then open `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and select the `build` folder. Chrome loads the extension from that folder, not from the server; the server rebuilds the folder as you edit and tells the open pages to update.

The new tab page, popup and options page update on their own. For changes to the background, the picker, or anything else that runs in web pages, click the reload button on extenddir in `chrome://extensions`, then reload the web pages you're testing on.

For a production build:

```sh
NODE_ENV=production npm run build
```

The new tab page is in `src/pages/Newtab/`.

Built on [chrome-extension-boilerplate-react](https://github.com/lxieyang/chrome-extension-boilerplate-react).
