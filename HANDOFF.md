# Handoff

The README covers how everything works for a user. This file covers what you need to pick up the work.

## Build and load

- `npm install`, then `NODE_ENV=production npm run build`, then load `build/` unpacked in Chrome.
- The `key` in `src/manifest.json` fixes the extension ID to `djbehkgedndihcnohchaklkolmjbigka`, whatever folder it's loaded from. Don't change or remove the key: a new ID starts with empty storage and stops sharing synced data with other computers. The private key (`key.pem`) stays on the first computer and is only needed to pack a `.crx`.
- The user's lists sync through `chrome.storage.sync` once **Sync lists through Chrome** is switched on in the new tab page. It's off by default and set on each computer.

## Where things are

| Area | Files |
|---|---|
| New tab page (lists, sources, drag and drop, layouts) | `src/pages/Newtab/Newtab.jsx`, `Items.jsx` |
| Picker (turns a click into selectors) | `src/pages/Picker/index.js`, `src/sources/selectors.js` |
| Reading items from a page | `src/sources/extract.js`, `download.js`, `data.js`, `remap.js` |
| Refreshing (fetch, data, frame, tab) | `src/pages/Background/refresh.js` |
| Tabs that go back to their list when closed | `src/pages/Background/opened.js` |
| Sync | `src/pages/Background/sync.js` |
| Grouping by topic (MiniLM model run in the offscreen page) | `src/sources/similar.js`, `src/pages/Offscreen/embed.js` |

## Lessons from this session

- **Testing refreshes:** while Playwright is connected over CDP, Chrome draws background tabs as if they were visible. That hides the real behaviour: Instagram's feed returned 30 posts in tests but 2 for the user. To test refreshes realistically, disconnect Playwright and send `Runtime.evaluate` over a bare CDP websocket to the extension's service worker. Timers in hidden extension pages are throttled to about once a minute after 5 minutes hidden, so run test code in the service worker.
- **The `debugger` permission:** the tab refresh method screencasts its background tab through `chrome.debugger`, so Chrome draws it and infinite-scroll feeds keep loading. Chrome shows a "debugging this browser" bar while that runs; that's expected.
- **Generated class names:** sites like Instagram and Pinterest change their class names with every build. `isHashed` in `selectors.js` drops them, and the picker falls back to `role`, `data-pagelet`, link kinds, or the path down from a stable ancestor. A source that stops finding items after a site update usually needs a new pick.
- **Picking:** the user prefers to do picks themselves unless the picker logic is changing. What they care about most is how many items a refresh gets.

## Open items

- Grouping by topic is weak on one-word titles. The thresholds in `similar.js` were tuned by hand on a small sample.
- The tab refresh method opens a real background tab, which can take 20–30 seconds per source.
