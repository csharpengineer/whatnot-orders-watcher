(() => {
  const MESSAGE_TYPE = "WHATNOT_PURCHASES_CAPTURE";
  const DEBUG_MESSAGE_TYPE = "WHATNOT_PURCHASES_DEBUG";
  const REPLAY_MESSAGE_TYPE = "WHATNOT_PURCHASES_REPLAY_REQUEST";
  const SOURCE_TAG = "whatnot-orders-watcher";

  if (window.__whatnotOrdersCaptureInstalled) return;
  window.__whatnotOrdersCaptureInstalled = true;

  const isGraphQlUrl = (url) => typeof url === "string" && url.includes("/services/graphql/");
  const hasPurchasesPayload = (payload) => {
    if (!payload || typeof payload !== "object") return false;
    return Boolean(
      Array.isArray(payload?.data?.myOrders?.edges) ||
        Array.isArray(payload?.data?.myOrders?.nodes) ||
        Array.isArray(payload?.data?.viewer?.myOrders?.edges) ||
        Array.isArray(payload?.data?.viewer?.myOrders?.nodes) ||
        Array.isArray(payload?.data?.myPurchases?.edges) ||
        Array.isArray(payload?.data?.myPurchases?.nodes) ||
        Array.isArray(payload?.data?.orders?.edges) ||
        Array.isArray(payload?.data?.orders?.nodes)
    );
  };

  const getOrderCount = (payload) => {
    const edges =
      payload?.data?.myOrders?.edges ||
      payload?.data?.viewer?.myOrders?.edges ||
      payload?.data?.myPurchases?.edges ||
      payload?.data?.orders?.edges;
    if (Array.isArray(edges)) return edges.length;

    const nodes =
      payload?.data?.myOrders?.nodes ||
      payload?.data?.viewer?.myOrders?.nodes ||
      payload?.data?.myPurchases?.nodes ||
      payload?.data?.orders?.nodes;
    if (Array.isArray(nodes)) return nodes.length;

    return 0;
  };

  const emitIfPurchasesPayload = (payload, isOwnRequest = false) => {
    if (!hasPurchasesPayload(payload)) return;
    window.postMessage({ source: SOURCE_TAG, type: MESSAGE_TYPE, payload, isOwnRequest }, "*");
  };

  const emitDebug = (event, details = {}) => {
    window.postMessage(
      {
        source: SOURCE_TAG,
        type: DEBUG_MESSAGE_TYPE,
        payload: {
          event,
          ...details
        }
      },
      "*"
    );
  };

  emitDebug("booted", {
    url: window.location.href
  });

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = async function (...args) {
      const response = await originalFetch.apply(this, args);
      try {
        const requestUrl = typeof args[0] === "string" ? args[0] : args[0]?.url;
        if (isGraphQlUrl(requestUrl)) {
          emitDebug("fetch_seen", { url: requestUrl });
          response
            .clone()
            .json()
            .then((payload) => {
              const orderCount = Array.isArray(payload?.data?.myOrders?.edges)
                ? payload.data.myOrders.edges.length
                : getOrderCount(payload);
              emitDebug("fetch_json_ok", { url: requestUrl, orderCount });
              emitIfPurchasesPayload(payload);
            })
            .catch((error) => {
              emitDebug("fetch_json_error", {
                url: requestUrl,
                error: error?.message || "Unknown fetch JSON parse error"
              });
            });
        }
      } catch {}
      return response;
    };
  }

  const originalXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__whatnotOrdersUrl = url;
    return originalXhrOpen.call(this, method, url, ...rest);
  };

  const originalXhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", function () {
      try {
        if (!isGraphQlUrl(this.__whatnotOrdersUrl)) return;
        emitDebug("xhr_seen", { url: this.__whatnotOrdersUrl });
        const responseText = typeof this.responseText === "string" ? this.responseText : "";
        if (!responseText) return;
        const payload = JSON.parse(responseText);
        const orderCount = getOrderCount(payload);
        emitDebug("xhr_json_ok", { url: this.__whatnotOrdersUrl, orderCount });
        emitIfPurchasesPayload(payload);
      } catch {}
    });

    return originalXhrSend.apply(this, args);
  };

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== SOURCE_TAG || data.type !== REPLAY_MESSAGE_TYPE) return;

    const request = data.payload || {};
    const requestUrl = typeof request.url === "string" ? request.url : "";
    if (!isGraphQlUrl(requestUrl)) {
      emitDebug("replay_invalid_url", { url: requestUrl || "" });
      return;
    }

    const method = String(request.method || "POST").toUpperCase();
    const headers = request.headers && typeof request.headers === "object" ? request.headers : {};

    emitDebug("replay_requested", { url: requestUrl, method });

    try {
      const response = await originalFetch.call(window, requestUrl, {
        method,
        headers,
        credentials: "include",
        mode: "cors",
        cache: "no-store",
        referrer: request.referrer || "https://www.whatnot.com/?activityTab=purchases",
        body: method === "POST" ? request.body : undefined
      });

      const text = await response.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        emitDebug("replay_not_json", { url: requestUrl, status: response.status });
        return;
      }

      emitDebug("replay_json_ok", {
        url: requestUrl,
        status: response.status,
        orderCount: getOrderCount(payload)
      });

      emitIfPurchasesPayload(payload, true);
    } catch (error) {
      emitDebug("replay_error", {
        url: requestUrl,
        error: error?.message || "Replay request failed"
      });
    }
  });
})();
