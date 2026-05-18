# Whatnot Orders Watcher (Chrome/Edge Extension)

Simple Manifest V3 extension that:

- Works only for `https://www.whatnot.com/?activityTab=purchases`
- Lets you enable/disable monitoring
- Lets you set refresh interval in minutes (default `1`)
- Opens/focuses the purchases page from the popup
- Refreshes on a timer when enabled
- Detects new orders in the purchases panel and sends a system notification

## Files

- `manifest.json` - extension manifest
- `background.js` - timer, settings, refresh orchestration, notifications
- `content.js` - extracts order IDs/titles from `/order/*` links
- `popup.html`, `popup.js`, `popup.css` - simple toolbar popup configuration UI

## Load in Chrome / Edge

1. Open `chrome://extensions` (or `edge://extensions`)
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this folder: `whatnotorders`

## Use

1. Open extension popup.
2. Set refresh interval (minutes).
3. Enable service.
4. Click **Open purchases page** if not already there.
5. Click **Test notification** to verify browser/system notifications are working.
6. Keep that tab open. On each refresh cycle, new unseen orders trigger a system notification.

## Notes

- New order state is held in extension memory (service worker lifetime).
- First successful capture establishes baseline and does not notify existing rows.
