# Whatnot Orders Watcher (Chrome/Edge Extension)

Simple Manifest V3 extension that:

- Works on any `https://www.whatnot.com/` tab
- Lets you enable/disable monitoring
- Lets you set refresh interval in minutes (default `1`)
- Opens/focuses the Whatnot site from the popup
- Refreshes on a timer when enabled
- Detects new orders via the GraphQL API and sends a system notification

## Files

- `manifest.json` - extension manifest
- `background.js` - timer, settings, refresh orchestration, notifications
- `content.js` - intercepts GraphQL `GetMyPurchases` responses and polls the API
- `page-network-capture.js` - injected into the page context to hook `fetch`/XHR
- `popup.html`, `popup.js`, `popup.css` - toolbar popup UI

## Load in Chrome / Edge

1. Open `chrome://extensions` (or `edge://extensions`)
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this folder: `whatnotorders`

## Use

1. Open the extension popup.
2. Set refresh interval (minutes).
3. Enable service.
4. Click **Open Whatnot** if a Whatnot tab isn't already open.
5. Keep that tab open. On each refresh cycle, new unseen orders trigger a system notification.

## Notes

- Captured order state is stored in `sessionStorage` (page context), so it survives service worker restarts within the same browser session.
- Only responses from the extension's own polling requests are processed; orders browsed manually on the site do not affect the list.
- First successful capture establishes baseline and does not notify for existing orders.
- Notifications are never sent for orders older than the most recently notified order time.
