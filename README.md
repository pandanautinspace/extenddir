# extenddir

A Chrome extension that replaces the new tab page with a tab manager. It shows your open tabs, grouped by window, next to your saved lists of tabs.

- Drag open tabs to reorder them or move them between windows.
- Tab groups show with their color and name. Drag a tab in or out of a group, or onto **New group** to start one. Click a group's name to rename it, its dot to change color, or **Ungroup**.
- Drag an open tab into a list to save it and close the tab.
- Drag a tab onto **+ New List**, or click it, to start a new list.
- Drag a saved tab back to a window to reopen it, or click it to open it here. Either way it leaves the list.
- Click a list's name to rename it.
- Cmd-click tabs to select several, or Shift-click to select a range. Dragging any selected tab moves them all. Esc clears the selection.

Lists are kept in `chrome.storage.local`.

## Development

Requires Node.js 18 or later.

```sh
npm install
npm start          # dev build with auto-reload, written to build/
```

Then open `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and select the `build` folder.

For a production build:

```sh
NODE_ENV=production npm run build
```

The new tab page is in `src/pages/Newtab/`.

Built on [chrome-extension-boilerplate-react](https://github.com/lxieyang/chrome-extension-boilerplate-react).
