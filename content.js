function isOnWhatnotPage() {
  try {
    return new URL(window.location.href).origin === "https://www.whatnot.com";
  } catch {
    return false;
  }
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeTitleKey(value) {
  return normalizeText(value).toLowerCase();
}

function parseOrderId(value) {
  if (!value || typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  const hrefMatch = trimmed.match(/\/order\/([^/?#]+)/);
  if (hrefMatch) return hrefMatch[1];
  if (/^[A-Za-z0-9_:-]{6,}$/.test(trimmed)) return trimmed;
  return "";
}

function coerceOrderId(value) {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  if (!text) return "";
  return parseOrderId(text) || text;
}

function parseTimestamp(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function parseIconUrl(value) {
  if (!value || typeof value !== "string") return "";
  try {
    return new URL(value, window.location.origin).href;
  } catch {
    return "";
  }
}

function pickFirstImageUrl(candidates) {
  for (const candidate of candidates) {
    const parsed = parseIconUrl(candidate);
    if (parsed) return parsed;
  }
  return "";
}

function looksLikeImageUrl(value) {
  if (typeof value !== "string") return false;
  const lowered = value.toLowerCase();
  if (!lowered.startsWith("http://") && !lowered.startsWith("https://")) return false;
  return lowered.includes("image") || lowered.includes("img") || lowered.includes("cdn") || lowered.includes("whatnot");
}

function findImageUrlDeep(input, maxDepth = 4) {
  const queue = [{ value: input, depth: 0 }];
  const visited = new Set();

  while (queue.length) {
    const current = queue.shift();
    const value = current?.value;
    const depth = Number(current?.depth || 0);
    if (!value || depth > maxDepth) continue;

    if (typeof value === "string") {
      if (looksLikeImageUrl(value)) {
        const parsed = parseIconUrl(value);
        if (parsed) return parsed;
      }
      continue;
    }

    if (typeof value !== "object") continue;
    if (visited.has(value)) continue;
    visited.add(value);

    if (Array.isArray(value)) {
      for (const item of value) {
        queue.push({ value: item, depth: depth + 1 });
      }
      continue;
    }

    const entries = Object.entries(value);
    const preferredKeys = ["url", "src", "image", "imageUrl", "thumbnail", "thumbnailUrl", "coverImage", "placeholderImage"];

    for (const [key, child] of entries) {
      if (preferredKeys.includes(key) && typeof child === "string") {
        const parsed = parseIconUrl(child);
        if (parsed) return parsed;
      }
    }

    for (const [, child] of entries) {
      queue.push({ value: child, depth: depth + 1 });
    }
  }

  return "";
}

function extractListingImageUrl(listing, itemNode, node) {
  return pickFirstImageUrl([
    listing?.images?.[0]?.url,
    listing?.images?.[0],
    listing?.images?.edges?.[0]?.node?.url,
    listing?.placeholderImage?.url,
    listing?.placeholderImageUrl,
    listing?.image?.url,
    listing?.coverImage?.url,
    listing?.thumbnailUrl,
    itemNode?.image?.url,
    itemNode?.images?.[0]?.url,
    itemNode?.images?.edges?.[0]?.node?.url,
    itemNode?.placeholderImage?.url,
    itemNode?.listingImage?.url,
    node?.image?.url,
    node?.thumbnailUrl,
    node?.coverImage?.url,
    node?.placeholderImage?.url,
    findImageUrlDeep(listing),
    findImageUrlDeep(itemNode),
    findImageUrlDeep(node)
  ]);
}

function collectDomOrderImagesByHref() {
  const map = new Map();
  const anchors = document.querySelectorAll('a[href^="/order/"]');
  for (const anchor of anchors) {
    const href = typeof anchor.getAttribute === "function" ? anchor.getAttribute("href") : "";
    if (!href || !href.startsWith("/order/")) continue;

    const img = anchor.querySelector("img");
    if (!img) continue;

    const srcCandidate = img.getAttribute("src") || img.currentSrc || "";
    const iconUrl = parseIconUrl(srcCandidate);
    if (!iconUrl) continue;

    if (!map.has(href)) {
      map.set(href, iconUrl);
    }
  }
  return map;
}

function collectDomPlaceholderImageUrl() {
  const exact = document.querySelector('img[src*="empty_product_placeholder"]');
  if (exact) {
    const src = exact.getAttribute("src") || exact.currentSrc || "";
    const parsed = parseIconUrl(src);
    if (parsed) return parsed;
  }

  const srcsetMatch = document.querySelector('img[srcset*="empty_product_placeholder"]');
  if (srcsetMatch) {
    const srcset = srcsetMatch.getAttribute("srcset") || "";
    const firstToken = srcset.split(",")[0]?.trim()?.split(" ")[0] || "";
    const parsed = parseIconUrl(firstToken);
    if (parsed) return parsed;
  }

  return "";
}

function formatMoneyFromCents(amountSafe, currency) {
  if (!Number.isFinite(Number(amountSafe))) return "";
  const dollars = Number(amountSafe) / 100;
  if (String(currency || "").toUpperCase() === "USD") {
    return `$${dollars.toFixed(2)}`;
  }
  return `${dollars.toFixed(2)} ${String(currency || "").toUpperCase()}`.trim();
}

const GRAPHQL_CAPTURE_MESSAGE = "WHATNOT_PURCHASES_CAPTURE";
const GRAPHQL_DEBUG_MESSAGE = "WHATNOT_PURCHASES_DEBUG";
const GRAPHQL_REPLAY_REQUEST_MESSAGE = "WHATNOT_PURCHASES_REPLAY_REQUEST";
const PAGE_SOURCE_TAG = "whatnot-orders-watcher";
const INJECTED_SCRIPT_ID = "whatnot-orders-network-capture-fallback";
const INJECTED_SCRIPT_FILE = "page-network-capture.js";
const DEFAULT_GET_MY_PURCHASES_URL = "https://www.whatnot.com/services/graphql/?operationName=GetMyPurchases&ssr=0";
const DEFAULT_WHATNOT_PLACEHOLDER_IMAGE_URL =
  "https://www.whatnot.com/cdn/assets/045f9cb1550f8b9e/_next/static/media/empty_product_placeholder.9f3f94c5.png";

const graphQlDebug = {
  hookInjected: false,
  fetchHits: 0,
  xhrHits: 0,
  pollAttempts: 0,
  pollHits: 0,
  payloadHits: 0,
  lastOrderCount: 0,
  lastCaptureAt: 0,
  lastPollAt: 0,
  lastPollUrl: "",
  lastUrl: "",
  lastEvent: "waiting_for_hook_boot",
  lastError: ""
};

let latestOrders = [];
let latestOrdersById = new Map();
let latestOrdersByTitle = new Map();
let isGraphQlPollInFlight = false;
let lastFetchedGraphQlUrl = "";

const ORDERS_SESSION_KEY = "whatnot-orders-watcher:orders";

function loadOrdersFromSession() {
  try {
    const stored = sessionStorage.getItem(ORDERS_SESSION_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveOrdersToSession(orders) {
  try {
    sessionStorage.setItem(ORDERS_SESSION_KEY, JSON.stringify(orders));
  } catch {}
}

function sortOrdersByDateDesc(orders) {
  return orders.slice().sort((a, b) => {
    const ta = a.dateFull ? new Date(a.dateFull).getTime() : 0;
    const tb = b.dateFull ? new Date(b.dateFull).getTime() : 0;
    return tb - ta;
  });
}

(function initOrdersFromSession() {
  const stored = loadOrdersFromSession();
  if (!stored.length) return;
  latestOrders = stored;
  latestOrdersById = new Map(stored.map((o) => [o.id, o]));
  latestOrdersByTitle = new Map(stored.map((o) => [normalizeTitleKey(o.title), o]));
})();

const fallbackPurchasesBody = JSON.stringify({
  operationName: "GetMyPurchases",
  variables: {
    cursor: null,
    first: 20,
    status: []
  },
  query:
    "query GetMyPurchases($first:Int$cursor:String$status:[String]){myOrders(first:$first after:$cursor status:$status){pageInfo{hasNextPage hasPreviousPage endCursor startCursor __typename}edges{node{id total{...Money __typename}createdAt prettyStatus uuid status supportRequest{id ordersPageChip{text variant __typename}__typename}items{edges{node{id status prettyStatus listing{id title description images{id url __typename}user{id username profileImage{id url __typename}premierShopStatus{isPremierShop __typename}__typename}__typename}shipment{shippingServiceName courierLogoSmallUrl trackingMetadata{title eta __typename}__typename}__typename}__typename}__typename}__typename}__typename}__typename}}fragment Money on Money{amount currency amountSafe __typename}"
});

function ensurePageHookFallbackInjected() {
  if (document.getElementById(INJECTED_SCRIPT_ID)) return;

  const script = document.createElement("script");
  script.id = INJECTED_SCRIPT_ID;
  script.src = chrome.runtime.getURL(INJECTED_SCRIPT_FILE);
  script.addEventListener("error", () => {
    graphQlDebug.lastError = "Fallback hook script failed to load";
    graphQlDebug.lastEvent = "hook_fallback_error";
  });

  const parent = document.head || document.documentElement;
  if (parent) {
    parent.appendChild(script);
    graphQlDebug.lastEvent = "hook_fallback_injected";
  }
}

function extractOrdersFromPayload(payload) {
  const domOrderImagesByHref = collectDomOrderImagesByHref();
  const domPlaceholderImageUrl = collectDomPlaceholderImageUrl();

  const rawEdges =
    payload?.data?.myOrders?.edges ||
    payload?.data?.viewer?.myOrders?.edges ||
    payload?.data?.myPurchases?.edges ||
    payload?.data?.orders?.edges ||
    [];

  const nodes =
    payload?.data?.myOrders?.nodes ||
    payload?.data?.viewer?.myOrders?.nodes ||
    payload?.data?.myPurchases?.nodes ||
    payload?.data?.orders?.nodes ||
    [];

  const edges = Array.isArray(rawEdges)
    ? rawEdges
    : Array.isArray(nodes)
      ? nodes.map((node) => ({ node }))
      : [];

  if (!Array.isArray(edges)) return [];

  const orders = [];
  for (const edge of edges) {
    const node = edge?.node;
    const itemNode = node?.items?.edges?.[0]?.node || node?.item;
    const listing = itemNode?.listing;

    const id =
      parseOrderId(node?.uuid) ||
      parseOrderId(node?.orderUuid) ||
      parseOrderId(node?.order?.uuid) ||
      parseOrderId(node?.id) ||
      parseOrderId(itemNode?.id) ||
      parseOrderId(node?.href) ||
      parseOrderId(node?.url) ||
      coerceOrderId(node?.uuid) ||
      coerceOrderId(node?.orderUuid) ||
      coerceOrderId(node?.id) ||
      coerceOrderId(itemNode?.id);
    if (!id) continue;

    const hrefId = parseOrderId(node?.uuid) || parseOrderId(node?.orderUuid) || parseOrderId(node?.order?.uuid) || parseOrderId(node?.href) || parseOrderId(node?.url) || parseOrderId(node?.id) || "";

    const title = normalizeText(listing?.title || node?.title || "(No title)");
    const status = normalizeText(node?.prettyStatus || itemNode?.prettyStatus || node?.supportRequest?.ordersPageChip?.text || node?.status || "Unknown");
    const price =
      formatMoneyFromCents(node?.total?.amountSafe, node?.total?.currency) ||
      formatMoneyFromCents(node?.total?.amount, node?.total?.currency) ||
      normalizeText(node?.prettyTotal || node?.totalAmount || "") ||
      "Unknown";
    const graphQlIconUrl = extractListingImageUrl(listing, itemNode, node);
    const dateFull = parseTimestamp(node?.createdAt || node?.purchaseDate || node?.date);
    const date = dateFull ? new Date(dateFull).toLocaleDateString() : "Unknown";
    const href = hrefId ? `/order/${encodeURIComponent(hrefId)}` : "";
    const iconUrl =
      graphQlIconUrl ||
      (href ? domOrderImagesByHref.get(href) || "" : "") ||
      domPlaceholderImageUrl ||
      DEFAULT_WHATNOT_PLACEHOLDER_IMAGE_URL;

    const sellerUsername = normalizeText(listing?.user?.username || "");
    const sellerProfileImageUrl = typeof listing?.user?.profileImage?.url === "string" ? listing.user.profileImage.url : "";
    const isPremierShop = Boolean(listing?.user?.premierShopStatus?.isPremierShop);
    const description = normalizeText(listing?.description || "");
    const shippingServiceName = normalizeText(itemNode?.shipment?.shippingServiceName || "");
    const courierLogoSmallUrl = typeof itemNode?.shipment?.courierLogoSmallUrl === "string" ? itemNode.shipment.courierLogoSmallUrl : "";
    const etaRaw = itemNode?.shipment?.trackingMetadata?.eta;
    const shippingEta = etaRaw ? new Date(Number(etaRaw) * 1000).toLocaleDateString() : "";

    orders.push({
      id,
      title,
      href,
      orderUrl: href ? `https://www.whatnot.com${href}` : "https://www.whatnot.com",
      price,
      status,
      iconUrl,
      date,
      dateFull,
      sellerUsername,
      sellerProfileImageUrl,
      isPremierShop,
      description,
      shippingServiceName,
      courierLogoSmallUrl,
      shippingEta
    });
  }

  return orders;
}

function mergeGraphQlPayload(payload, sourceEvent, sourceUrl = "") {
  const orders = extractOrdersFromPayload(payload);
  graphQlDebug.payloadHits += 1;
  graphQlDebug.lastCaptureAt = Date.now();
  graphQlDebug.lastOrderCount = orders.length;
  graphQlDebug.lastEvent = sourceEvent;
  if (sourceUrl) {
    graphQlDebug.lastUrl = sourceUrl;
  }

  if (!orders.length) {
    graphQlDebug.lastError = "Payload captured but no mappable orders found";
    return;
  }

  latestOrders = sortOrdersByDateDesc(orders);
  latestOrdersById = new Map(latestOrders.map((order) => [order.id, order]));
  latestOrdersByTitle = new Map(latestOrders.map((order) => [normalizeTitleKey(order.title), order]));
  saveOrdersToSession(latestOrders);
  graphQlDebug.lastError = "";
}

async function getLatestGraphQlUrlFromBackground() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "WHATNOT_GET_LAST_PURCHASES_URL" });
    return {
      url: typeof response?.url === "string" ? response.url : "",
      template: response?.template || null
    };
  } catch {
    return {
      url: "",
      template: null
    };
  }
}

function getLatestGraphQlUrlFromPerformance() {
  const entries = performance.getEntriesByType("resource");
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const url = entries[index]?.name;
    if (!url || typeof url !== "string") continue;
    if (!url.includes("/services/graphql/")) continue;
    if (!url.includes("operationName=GetMyPurchases")) continue;
    return url;
  }
  return "";
}

function buildReplayRequest(template, fallbackUrl) {
  const resolvedUrl = template?.url || fallbackUrl || "";
  const method = (template?.method || "POST").toUpperCase();
  const headers = template?.headers || {};

  const replayHeaders = {
    accept: headers.accept || "*/*",
    "content-type": headers["content-type"] || "application/json",
    authorization: headers.authorization || "Cookie",
    "x-client-timezone": headers["x-client-timezone"] || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    "x-whatnot-app": headers["x-whatnot-app"] || "whatnot-web",
    "x-whatnot-app-context": headers["x-whatnot-app-context"] || "next-js/browser",
    "x-whatnot-app-pathname": headers["x-whatnot-app-pathname"] || window.location.pathname || "/",
    "x-whatnot-app-screen": headers["x-whatnot-app-screen"] || window.location.pathname || "/"
  };

  const optionalHeaders = [
    "x-whatnot-app-pathname",
    "x-whatnot-app-screen",
    "x-whatnot-app-session-id",
    "x-whatnot-app-user-session-id",
    "x-whatnot-app-version",
    "x-whatnot-rum-session-id",
    "x-whatnot-usgmt",
    "x-kpsdk-cd",
    "x-kpsdk-ct",
    "x-kpsdk-h",
    "x-kpsdk-v",
    "x-request-id",
    "cache-control",
    "pragma"
  ];

  for (const name of optionalHeaders) {
    if (headers[name]) replayHeaders[name] = headers[name];
  }

  return {
    url: resolvedUrl,
    method,
    headers: replayHeaders,
    body: template?.body || fallbackPurchasesBody,
    referrer: "https://www.whatnot.com/?activityTab=purchases"
  };
}

function requestReplayInPage(replayRequest) {
  window.postMessage(
    {
      source: PAGE_SOURCE_TAG,
      type: GRAPHQL_REPLAY_REQUEST_MESSAGE,
      payload: replayRequest
    },
    "*"
  );
}

function waitForPayloadIncrement(previousPayloadHits, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (graphQlDebug.payloadHits > previousPayloadHits) {
        clearInterval(timer);
        resolve(true);
        return;
      }

      if (Date.now() - start >= timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, 100);
  });
}

async function pollGraphQlPayload() {
  if (isGraphQlPollInFlight) return;

  const backgroundState = await getLatestGraphQlUrlFromBackground();
  const performanceUrl = getLatestGraphQlUrlFromPerformance();
  const url = backgroundState.url || performanceUrl || DEFAULT_GET_MY_PURCHASES_URL;

  const replayRequest = buildReplayRequest(backgroundState.template, url);

  graphQlDebug.lastPollUrl = url;
  graphQlDebug.lastPollAt = Date.now();
  graphQlDebug.lastEvent = backgroundState.url ? "poll_url_from_background" : "poll_url_from_performance";

  isGraphQlPollInFlight = true;
  graphQlDebug.pollAttempts += 1;

  try {
    const previousPayloadHits = graphQlDebug.payloadHits;
    requestReplayInPage(replayRequest);

    const pageReplayMerged = await waitForPayloadIncrement(previousPayloadHits, 2500);
    if (pageReplayMerged) {
      graphQlDebug.pollHits += 1;
      lastFetchedGraphQlUrl = url;
      graphQlDebug.lastEvent = "poll_payload_merged_page_replay";
      graphQlDebug.lastError = "";
      return;
    }

    graphQlDebug.lastEvent = "poll_page_replay_timeout_fallback_fetch";

    const response = await fetch(replayRequest.url, {
      method: replayRequest.method,
      headers: replayRequest.headers,
      credentials: "include",
      cache: "no-store",
      body: replayRequest.method === "POST" ? replayRequest.body : undefined
    });

    if (!response.ok) {
      graphQlDebug.lastEvent = "poll_http_error";
      graphQlDebug.lastError = `HTTP ${response.status}`;
      return;
    }

    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      graphQlDebug.lastEvent = "poll_not_json";
      graphQlDebug.lastError = "Polling response was not JSON";
      return;
    }

    graphQlDebug.pollHits += 1;
    lastFetchedGraphQlUrl = url;
    mergeGraphQlPayload(payload, "poll_payload_merged", url);
  } catch (error) {
    graphQlDebug.lastEvent = "poll_error";
    graphQlDebug.lastError = error?.message || "Polling GraphQL failed";
  } finally {
    isGraphQlPollInFlight = false;
  }
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== "whatnot-orders-watcher") return;

  if (data.type === GRAPHQL_DEBUG_MESSAGE) {
    const payload = data.payload || {};
    graphQlDebug.lastEvent = payload.event || graphQlDebug.lastEvent;
    graphQlDebug.lastUrl = payload.url || graphQlDebug.lastUrl;
    if (payload.event === "booted") graphQlDebug.hookInjected = true;
    if (payload.event === "fetch_seen") graphQlDebug.fetchHits += 1;
    if (payload.event === "xhr_seen") graphQlDebug.xhrHits += 1;
    if (payload.event === "fetch_json_error" || payload.event === "xhr_json_error") {
      graphQlDebug.lastError = payload.error || "GraphQL JSON parsing failed";
    }
    return;
  }

  if (data.type === GRAPHQL_CAPTURE_MESSAGE) {
    if (data.isOwnRequest) {
      mergeGraphQlPayload(data.payload, "payload_merged");
    }
  }
});

function getOrdersForUi() {
  return latestOrders;
}

function notifyPageRefreshed() {
  if (!isOnWhatnotPage()) return;
  chrome.runtime.sendMessage({ type: "WHATNOT_PAGE_REFRESHED" }, () => {
    void chrome.runtime.lastError;
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "WHATNOT_PING") {
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "WHATNOT_CAPTURE_ORDERS") {
    pollGraphQlPayload()
      .then(() => sendResponse({ orders: getOrdersForUi() }))
      .catch(() => sendResponse({ orders: getOrdersForUi() }));
    return true;
  }

  if (message?.type === "WHATNOT_GET_GRAPHQL_DEBUG") {
    sendResponse({
      ...graphQlDebug,
      mapSize: latestOrders.length
    });
    return true;
  }

  return false;
});

ensurePageHookFallbackInjected();

if (document.readyState === "complete") {
  notifyPageRefreshed();
} else {
  window.addEventListener("load", notifyPageRefreshed, { once: true });
}
