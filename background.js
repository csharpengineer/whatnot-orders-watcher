const TARGET_URL = "https://www.whatnot.com/";
const TARGET_URL_WITH_TRAILING_SLASH = "https://www.whatnot.com/";
const ALARM_NAME = "whatnot-refresh";
const NOTIFICATION_ICON = chrome.runtime.getURL("icons/icon-128.png");

const defaultSettings = {
  enabled: false,
  refreshMinutes: 1
};

const defaultScanStatus = {
  lastScanAt: 0,
  lastOrders: [],
  lastNotifiedAt: 0
};

const SEEN_ORDER_IDS_STORAGE_KEY = "seenOrderIds";

let knownOrderIds = new Set();
let knownOrderIdsLoaded = false;
let isInitialized = false;
let isScanInProgress = false;
let lastGetMyPurchasesUrl = "";
let lastGetMyPurchasesTemplate = null;
const pendingPurchasesRequests = new Map();
const whatnotTabLoadedAt = new Map();

function isGetMyPurchasesUrl(url) {
  return (
    typeof url === "string" &&
    url.includes("/services/graphql/") &&
    url.includes("operationName=GetMyPurchases")
  );
}

function decodeRequestBody(requestBody) {
  if (!requestBody) return "";

  if (requestBody.raw && Array.isArray(requestBody.raw) && requestBody.raw[0]?.bytes) {
    try {
      const bytes = new Uint8Array(requestBody.raw[0].bytes);
      return new TextDecoder("utf-8").decode(bytes);
    } catch {
      return "";
    }
  }

  if (requestBody.formData && typeof requestBody.formData === "object") {
    try {
      return JSON.stringify(requestBody.formData);
    } catch {
      return "";
    }
  }

  return "";
}

function normalizeRefreshMinutes(value) {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  if (parsed > 60) return 60;
  return parsed;
}

function isTargetUrl(urlString) {
  if (!urlString) return false;
  try {
    const url = new URL(urlString);
    return url.origin === "https://www.whatnot.com";
  } catch {
    return false;
  }
}

function normalizeOrderId(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function normalizeSeenOrderIds(value) {
  if (!Array.isArray(value)) return [];
  const unique = new Set();

  for (const candidate of value) {
    const normalized = normalizeOrderId(candidate);
    if (!normalized) continue;
    unique.add(normalized);
  }

  return Array.from(unique);
}

async function getSettings() {
  const stored = await chrome.storage.local.get(defaultSettings);
  return {
    enabled: Boolean(stored.enabled),
    refreshMinutes: normalizeRefreshMinutes(stored.refreshMinutes)
  };
}

async function persistKnownOrderIds() {
  await chrome.storage.local.set({
    [SEEN_ORDER_IDS_STORAGE_KEY]: Array.from(knownOrderIds)
  });
}

function getOrderIdsFromOrders(orders) {
  if (!Array.isArray(orders)) return [];

  const ids = [];
  for (const order of orders) {
    const id = normalizeOrderId(order?.id);
    if (!id) continue;
    ids.push(id);
  }
  return ids;
}

function getNewestOrderTime(orders) {
  if (!Array.isArray(orders) || !orders.length) return 0;
  let newest = 0;
  for (const order of orders) {
    const t = order.dateFull ? new Date(order.dateFull).getTime() : 0;
    if (t > newest) newest = t;
  }
  return newest;
}

async function ensureKnownOrderIdsLoaded() {
  if (knownOrderIdsLoaded) return;

  const stored = await chrome.storage.local.get({
    [SEEN_ORDER_IDS_STORAGE_KEY]: [],
    ...defaultScanStatus
  });

  const normalizedStoredIds = normalizeSeenOrderIds(stored[SEEN_ORDER_IDS_STORAGE_KEY]);
  if (normalizedStoredIds.length) {
    knownOrderIds = new Set(normalizedStoredIds);
    knownOrderIdsLoaded = true;
    return;
  }

  const bootstrapIds = getOrderIdsFromOrders(stored.lastOrders);
  knownOrderIds = new Set(bootstrapIds);
  knownOrderIdsLoaded = true;

  if (bootstrapIds.length) {
    await persistKnownOrderIds();
  }
}

function getTabLoadedAt(tabId) {
  if (typeof tabId !== "number") return 0;
  return Number(whatnotTabLoadedAt.get(tabId) || 0);
}

async function hasAnyWhatnotTab() {
  const tabs = await queryTargetTabs();
  return tabs.length > 0;
}

async function updateAlarmFromSettings() {
  const settings = await getSettings();
  const existingAlarm = await chrome.alarms.get(ALARM_NAME);

  if (isScanInProgress) {
    if (existingAlarm) {
      await chrome.alarms.clear(ALARM_NAME);
    }
    return;
  }

  const hasWhatnotTab = await hasAnyWhatnotTab();
  const shouldRun = settings.enabled && hasWhatnotTab;

  if (!shouldRun) {
    if (existingAlarm) {
      await chrome.alarms.clear(ALARM_NAME);
    }
    return;
  }

  const currentPeriod = Number(existingAlarm?.periodInMinutes || 0);
  const desiredPeriod = Number(settings.refreshMinutes);
  const periodMatches = Math.abs(currentPeriod - desiredPeriod) < 0.0001;

  if (existingAlarm && periodMatches) {
    return;
  }

  await chrome.alarms.create(ALARM_NAME, {
    periodInMinutes: settings.refreshMinutes
  });
}

async function ensureInitialized() {
  if (isInitialized) return;
  isInitialized = true;
  await ensureKnownOrderIdsLoaded();
  const settings = await getSettings();
  await chrome.storage.local.set({
    enabled: settings.enabled,
    refreshMinutes: settings.refreshMinutes
  });
  await updateAlarmFromSettings();
}

async function queryTargetTab() {
  const tabs = await queryTargetTabs();
  return tabs[0] || null;
}

async function queryTargetTabs() {
  const tabs = await chrome.tabs.query({ url: "https://www.whatnot.com/*" });
  const matchingTabs = tabs.filter((tab) => isTargetUrl(tab.url));

  return matchingTabs.sort((a, b) => {
    const loadedDelta = getTabLoadedAt(b.id) - getTabLoadedAt(a.id);
    if (loadedDelta !== 0) return loadedDelta;
    return Number(b.lastAccessed || 0) - Number(a.lastAccessed || 0);
  });
}

async function ensureContentScriptReady(tabId) {
  try {
    const ping = await chrome.tabs.sendMessage(tabId, { type: "WHATNOT_PING" });
    if (ping?.ok) return true;
  } catch {
    // receiver likely missing; try injecting below
  }

  try {
    // Clear any stale double-injection guard left by an orphaned context
    // (e.g. after extension reload the old content script can't respond but its
    // window.__whatnotOrdersWatcherLoaded flag still blocks a fresh injection)
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => { window.__whatnotOrdersWatcherLoaded = false; }
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
  } catch {
    return false;
  }

  try {
    const ping = await chrome.tabs.sendMessage(tabId, { type: "WHATNOT_PING" });
    return Boolean(ping?.ok);
  } catch {
    return false;
  }
}

async function sendMessageToWhatnotTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    const ready = await ensureContentScriptReady(tabId);
    if (!ready) {
      throw new Error("Could not establish connection to Whatnot page script");
    }
    return chrome.tabs.sendMessage(tabId, message);
  }
}

async function getGraphQlDebug() {
  const tabs = await queryTargetTabs();
  if (!tabs.length) {
    return {
      available: false,
      reason: "Target tab not found"
    };
  }

  for (const tab of tabs) {
    if (!tab?.id) continue;
    try {
      const response = await sendMessageToWhatnotTab(tab.id, { type: "WHATNOT_GET_GRAPHQL_DEBUG" });
      return {
        available: true,
        ...(response || {})
      };
    } catch {
      // try next tab
    }
  }

  return {
    available: false,
    reason: "Could not establish connection to Whatnot page script"
  };
}

async function getNextAlarmTime() {
  try {
    const alarm = await chrome.alarms.get(ALARM_NAME);
    return Number(alarm?.scheduledTime || 0);
  } catch {
    return 0;
  }
}

async function createOrderNotification({ title, message, contextMessage, imageUrl }) {
  const preferredIconUrl = typeof imageUrl === "string" && imageUrl.trim() ? imageUrl : NOTIFICATION_ICON;
  const base = {
    iconUrl: preferredIconUrl,
    title,
    message,
    contextMessage,
    requireInteraction: true,
    priority: 2
  };

  if (typeof imageUrl === "string" && imageUrl.trim()) {
    try {
      return await chrome.notifications.create({
        ...base,
        type: "image",
        imageUrl
      });
    } catch {
      // fallback below
    }
  }

  try {
    return await chrome.notifications.create({
      ...base,
      type: "basic"
    });
  } catch {
    return chrome.notifications.create({
      ...base,
      type: "basic",
      iconUrl: NOTIFICATION_ICON
    });
  }
}

async function notifyNewOrders(newOrders) {
  if (!newOrders.length) return;

  const first = newOrders[0];
  const parsedDate = first.dateFull ? new Date(first.dateFull) : null;
  const dateText = parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toLocaleString() : first.date || "Unknown";
  const messageLines = [
    `Status: ${first.status || "Unknown"}`,
    `Purchased: ${first.price || "Unknown"}`,
    `Date: ${dateText}`
  ];

  if (newOrders.length > 1) {
    messageLines.push(`+${newOrders.length - 1} more new order(s)`);
  }

  await createOrderNotification({
    title: first.title || "New Whatnot order",
    message: messageLines.join("\n"),
    contextMessage: "Whatnot Orders Watcher",
    imageUrl: first.iconUrl || ""
  });
}

function sanitizeOrdersForStorage(orders) {
  if (!Array.isArray(orders)) return [];

  return orders
    .filter((order) => order && typeof order.id === "string")
    .map((order) => ({
      id: order.id,
      title: typeof order.title === "string" ? order.title : "(No title)",
      href: typeof order.href === "string" ? order.href : "",
      orderUrl:
        typeof order.orderUrl === "string" && order.orderUrl
          ? order.orderUrl
          : `https://www.whatnot.com${typeof order.href === "string" ? order.href : ""}`,
      iconUrl: typeof order.iconUrl === "string" ? order.iconUrl : "",
      price: typeof order.price === "string" ? order.price : "Unknown",
      status: typeof order.status === "string" ? order.status : "Unknown",
      date: typeof order.date === "string" ? order.date : "Unknown",
      dateFull: typeof order.dateFull === "string" ? order.dateFull : "",
      sellerUsername: typeof order.sellerUsername === "string" ? order.sellerUsername : "",
      sellerProfileImageUrl: typeof order.sellerProfileImageUrl === "string" ? order.sellerProfileImageUrl : "",
      isPremierShop: Boolean(order.isPremierShop),
      description: typeof order.description === "string" ? order.description : "",
      shippingServiceName: typeof order.shippingServiceName === "string" ? order.shippingServiceName : "",
      courierLogoSmallUrl: typeof order.courierLogoSmallUrl === "string" ? order.courierLogoSmallUrl : "",
      shippingEta: typeof order.shippingEta === "string" ? order.shippingEta : ""
    }))
    .slice(0, 100);
}

async function updateScanStatus(orders) {
  const sanitizedOrders = sanitizeOrdersForStorage(orders);
  const sortedOrders = sanitizedOrders.slice().sort((a, b) => {
    const ta = a.dateFull ? new Date(a.dateFull).getTime() : 0;
    const tb = b.dateFull ? new Date(b.dateFull).getTime() : 0;
    return tb - ta;
  });
  const payload = {
    lastScanAt: Date.now()
  };

  if (sortedOrders.length > 0) {
    payload.lastOrders = sortedOrders;
  }

  await chrome.storage.local.set({
    ...payload
  });
}

async function captureOrdersFromTab(tabId) {
  const response = await sendMessageToWhatnotTab(tabId, { type: "WHATNOT_CAPTURE_ORDERS" });
  const orders = Array.isArray(response?.orders) ? response.orders : [];
  await updateScanStatus(orders);
  return orders;
}

async function captureOrdersFromAnyTab() {
  const tabs = await queryTargetTabs();
  if (!tabs.length) {
    throw new Error("Target tab not found");
  }

  let lastError = null;
  for (const tab of tabs) {
    if (!tab?.id) continue;
    try {
      return await captureOrdersFromTab(tab.id);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Unable to capture orders from any Whatnot tab");
}

async function processCapturedOrders(orders) {
  if (!orders.length) return;

  await ensureKnownOrderIdsLoaded();

  const orderIds = getOrderIdsFromOrders(orders);
  if (!orderIds.length) return;

  const stored = await chrome.storage.local.get({ lastNotifiedAt: 0 });
  const lastNotifiedAt = Number(stored.lastNotifiedAt || 0);

  if (knownOrderIds.size === 0) {
    knownOrderIds = new Set(orderIds);
    await persistKnownOrderIds();
    const newestTime = getNewestOrderTime(orders);
    if (newestTime > lastNotifiedAt) {
      await chrome.storage.local.set({ lastNotifiedAt: newestTime });
    }
    return;
  }

  const newOrders = [];
  let hasKnownOrdersChanges = false;
  for (const order of orders) {
    const orderId = normalizeOrderId(order?.id);
    if (!orderId) continue;

    if (!knownOrderIds.has(orderId)) {
      knownOrderIds.add(orderId);
      hasKnownOrdersChanges = true;
      const orderTime = order.dateFull ? new Date(order.dateFull).getTime() : 0;
      if (orderTime > lastNotifiedAt) {
        newOrders.push(order);
      }
    }
  }

  if (hasKnownOrdersChanges) {
    await persistKnownOrderIds();
  }

  if (newOrders.length > 0) {
    newOrders.sort((a, b) => {
      const ta = a.dateFull ? new Date(a.dateFull).getTime() : 0;
      const tb = b.dateFull ? new Date(b.dateFull).getTime() : 0;
      return tb - ta;
    });
    const newestNotifiedTime = Math.max(
      ...newOrders.map((o) => (o.dateFull ? new Date(o.dateFull).getTime() : 0))
    );
    await notifyNewOrders(newOrders);
    if (newestNotifiedTime > lastNotifiedAt) {
      await chrome.storage.local.set({ lastNotifiedAt: newestNotifiedTime });
    }
  }
}

async function refreshAndCheckOrders(isRetry = false) {
  const settings = await getSettings();
  if (!settings.enabled) return;

  if (isScanInProgress) return;
  isScanInProgress = true;

  await chrome.alarms.clear(ALARM_NAME);

  try {
    const orders = await captureOrdersFromAnyTab();
    await processCapturedOrders(orders);
  } catch {
    // content script may not be ready yet
    if (!isRetry) {
      // One quick retry while the service worker is still active
      setTimeout(() => refreshAndCheckOrders(true).catch(() => {}), 8000);
    }
    return;
  } finally {
    isScanInProgress = false;
    await updateAlarmFromSettings();
  }
}

function triggerImmediateScan() {
  if (isScanInProgress) return false;
  refreshAndCheckOrders().catch(() => {
    // best-effort immediate scan
  });
  return true;
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureInitialized();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureInitialized();
});

ensureInitialized().catch(() => {
  // initialization will be retried via lifecycle events or user actions
});

chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName !== "local") return;
  if (changes.enabled || changes.refreshMinutes) {
    await updateAlarmFromSettings();
  }

  if (changes.enabled && Boolean(changes.enabled.newValue) === true) {
    await refreshAndCheckOrders();
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  await refreshAndCheckOrders();
});

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") });
});

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!isGetMyPurchasesUrl(details?.url)) return;
    lastGetMyPurchasesUrl = details.url;

    const requestBodyText = decodeRequestBody(details.requestBody);
    const pending = pendingPurchasesRequests.get(details.requestId) || {};
    pendingPurchasesRequests.set(details.requestId, {
      ...pending,
      url: details.url,
      method: details.method || pending.method || "POST",
      body: requestBodyText || pending.body || ""
    });
  },
  {
    urls: ["https://www.whatnot.com/services/graphql/*"],
    types: ["xmlhttprequest"]
  },
  ["requestBody"]
);

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!isGetMyPurchasesUrl(details?.url)) return;

    const pending = pendingPurchasesRequests.get(details.requestId) || {};
    const requestHeaders = Array.isArray(details.requestHeaders) ? details.requestHeaders : [];
    const headersObject = {};
    for (const header of requestHeaders) {
      if (!header?.name) continue;
      headersObject[header.name.toLowerCase()] = header.value || "";
    }

    const template = {
      url: pending.url || details.url,
      method: pending.method || details.method || "POST",
      body: pending.body || "",
      headers: headersObject
    };

    lastGetMyPurchasesTemplate = template;
    pendingPurchasesRequests.delete(details.requestId);
  },
  {
    urls: ["https://www.whatnot.com/services/graphql/*"],
    types: ["xmlhttprequest"]
  },
  ["requestHeaders", "extraHeaders"]
);

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && isTargetUrl(tab.url)) {
    whatnotTabLoadedAt.set(tabId, Date.now());
  }

  if (changeInfo.url || changeInfo.status === "complete") {
    await updateAlarmFromSettings();
  }

  if (changeInfo.status !== "complete") return;
  if (!isTargetUrl(tab.url)) return;

  try {
    await refreshAndCheckOrders();
  } catch {
    return;
  }
});

chrome.tabs.onActivated.addListener(async () => {
  await updateAlarmFromSettings();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  whatnotTabLoadedAt.delete(tabId);
  await updateAlarmFromSettings();
});

chrome.windows.onFocusChanged.addListener(async () => {
  await updateAlarmFromSettings();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "WHATNOT_OPEN_TARGET") {
    chrome.tabs.query({ url: "https://www.whatnot.com/*" }).then(async (tabs) => {
      const target = tabs.find((tab) => isTargetUrl(tab.url));
      if (target?.id) {
        await chrome.tabs.update(target.id, { active: true });
        if (typeof target.windowId === "number") {
          await chrome.windows.update(target.windowId, { focused: true });
        }
      } else {
        await chrome.tabs.create({ url: TARGET_URL_WITH_TRAILING_SLASH });
      }
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message?.type === "WHATNOT_GET_STATUS") {
    Promise.all([
      getSettings(),
      chrome.storage.local.get(defaultScanStatus),
      getGraphQlDebug(),
      chrome.tabs.query({ active: true, currentWindow: true }),
      getNextAlarmTime(),
      queryTargetTabs()
    ])
      .then(([settings, scanStatus, graphqlDebug, tabs, nextScanAt, targetTabs]) => {
        const active = tabs[0];
        sendResponse({
          settings,
          lastScanAt: Number(scanStatus.lastScanAt || 0),
          nextScanAt: Number(nextScanAt || 0),
          isScanning: isScanInProgress,
          orders: sanitizeOrdersForStorage(scanStatus.lastOrders),
          graphqlDebug,
          isOnTargetPage: isTargetUrl(active?.url),
          hasTargetTab: targetTabs.length > 0
        });
      })
      .catch(() => {
        sendResponse({
          settings: defaultSettings,
          lastScanAt: 0,
          nextScanAt: 0,
          isScanning: false,
          orders: [],
          graphqlDebug: { available: false, reason: "Status request failed" },
          isOnTargetPage: false,
          hasTargetTab: false
        });
      });
    return true;
  }

  if (message?.type === "WHATNOT_SAVE_SETTINGS") {
    const enabled = Boolean(message.payload?.enabled);
    const refreshMinutes = normalizeRefreshMinutes(message.payload?.refreshMinutes);

    chrome.storage.local
      .set({ enabled, refreshMinutes })
      .then(async () => {
        await updateAlarmFromSettings();
        const hasTargetTab = await hasAnyWhatnotTab();
        const nextScanAt = await getNextAlarmTime();
        const scanStarted = enabled ? triggerImmediateScan() : false;
        sendResponse({
          ok: true,
          scanStarted,
          isOnTargetPage: hasTargetTab,
          hasTargetTab,
          nextScanAt: Number(nextScanAt || 0),
          isScanning: isScanInProgress
        });
      })
      .catch(() => sendResponse({ ok: false }));

    return true;
  }

  if (message?.type === "WHATNOT_TRIGGER_SCAN") {
    const scanStarted = triggerImmediateScan();
    Promise.all([hasAnyWhatnotTab(), getNextAlarmTime()])
      .then(([hasTargetTab, nextScanAt]) => {
        sendResponse({ ok: true, scanStarted, hasTargetTab, nextScanAt: Number(nextScanAt || 0), isScanning: isScanInProgress });
      })
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message?.type === "WHATNOT_TEST_NOTIFICATION") {
    chrome.storage.local
      .get(defaultScanStatus)
      .then((scanStatus) => {
        const orders = sanitizeOrdersForStorage(scanStatus.lastOrders);
        const latest = orders[0];

        if (latest) {
          const parsedDate = latest.dateFull ? new Date(latest.dateFull) : null;
          const dateText =
            parsedDate && !Number.isNaN(parsedDate.getTime())
              ? parsedDate.toLocaleString()
              : latest.date || "Unknown";

          return createOrderNotification({
            title: latest.title || "Latest discovered order",
            message: [`Status: ${latest.status || "Unknown"}`, `Purchased: ${latest.price || "Unknown"}`, `Date: ${dateText}`].join("\n"),
            contextMessage: "Test notification",
            imageUrl: latest.iconUrl || ""
          });
        }

        return chrome.notifications.create({
          type: "basic",
          iconUrl: NOTIFICATION_ICON,
          title: "No discovered orders yet",
          message: "Enable service and run a scan first.",
          requireInteraction: true,
          priority: 2
        });
      })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        const errorMessage =
          error?.message ||
          (typeof error === "string" ? error : "Unknown notification error");
        sendResponse({ ok: false, error: errorMessage });
      });

    return true;
  }

  if (message?.type === "WHATNOT_PAGE_REFRESHED") {
    if (!sender?.tab?.id || !isTargetUrl(sender.tab.url)) {
      sendResponse({ ok: false });
      return false;
    }

    refreshAndCheckOrders()
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));

    return true;
  }

  if (message?.type === "WHATNOT_GET_LAST_PURCHASES_URL") {
    sendResponse({
      url: lastGetMyPurchasesUrl || "",
      template: lastGetMyPurchasesTemplate
    });
    return false;
  }

  return false;
});
