const enabledEl = document.getElementById("enabled");
const refreshMinutesEl = document.getElementById("refreshMinutes");
const openPageEl = document.getElementById("openPage");
const refreshOrdersEl = document.getElementById("refreshOrders");
const scanStateEl = document.getElementById("scanState");
const countdownStateEl = document.getElementById("countdownState");
const ordersListEl = document.getElementById("ordersList");
const DEFAULT_WHATNOT_PLACEHOLDER_IMAGE_URL =
  "https://www.whatnot.com/cdn/assets/045f9cb1550f8b9e/_next/static/media/empty_product_placeholder.9f3f94c5.png";

let latestStatus = {
  enabled: false,
  nextScanAt: 0,
  isScanning: false,
  isOnTargetPage: false,
  hasTargetTab: false
};

function formatScanTime(timestamp) {
  if (!timestamp) return "Last successful scan:\nnever";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "Last successful scan:\nunknown";
  return `Last successful scan:\n${date.toLocaleString()}`;
}

function formatOrderDate(order) {
  const full = order?.dateFull ? new Date(order.dateFull) : null;
  if (full && !Number.isNaN(full.getTime())) {
    return full.toLocaleString();
  }

  const rawDate = String(order?.date || "").trim();
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(rawDate)) {
    return `${rawDate} (time unavailable)`;
  }

  const fallback = rawDate ? new Date(rawDate) : null;
  if (fallback && !Number.isNaN(fallback.getTime())) {
    return fallback.toLocaleString();
  }

  return rawDate || "Unknown";
}

function formatCountdownText() {
  if (!latestStatus.enabled) return "Next scan: disabled";
  if (latestStatus.isScanning) return "Next scan: on hold";
  if (!latestStatus.hasTargetTab) return "Next scan: paused (open a Whatnot page tab)";
  if (!latestStatus.nextScanAt) return "Next scan: paused (open a Whatnot page tab)";

  const remainingMs = latestStatus.nextScanAt - Date.now();
  if (remainingMs <= 0) return "Next scan: due now";

  const remainingSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  const secondsText = String(seconds).padStart(2, "0");

  return `Next scan in: ${minutes}:${secondsText}`;
}

function renderCountdown() {
  countdownStateEl.textContent = formatCountdownText();
}

function getStatusClass(statusValue) {
  const value = String(statusValue || "").toLowerCase();

  if (value.includes("delivered") || value.includes("complete")) return "statusDelivered";
  if (value.includes("cancel") || value.includes("refund") || value.includes("failed")) return "statusCancelled";
  if (value.includes("pending") || value.includes("await") || value.includes("review")) return "statusPending";
  if (value.includes("preparing") || value.includes("processing") || value.includes("confirmed") || value.includes("shipp")) {
    return "statusPreparing";
  }

  return "";
}

function renderOrders(orders) {
  ordersListEl.textContent = "";

  if (!Array.isArray(orders) || !orders.length) {
    const empty = document.createElement("div");
    empty.className = "emptyMessage";
    empty.textContent = "No orders captured yet.";
    ordersListEl.appendChild(empty);
    return;
  }

  for (const order of orders) {
    const card = document.createElement("div");
    card.className = "orderCard";

    const imageWrap = document.createElement("div");
    imageWrap.className = "cardImageWrap";
    const img = document.createElement("img");
    img.className = "cardImage";
    img.src = order.iconUrl || DEFAULT_WHATNOT_PLACEHOLDER_IMAGE_URL;
    img.alt = "Order item";
    imageWrap.appendChild(img);

    const cardBody = document.createElement("div");
    cardBody.className = "cardBody";

    const meta = document.createElement("div");
    meta.className = "orderMeta";

    const sellerRow = document.createElement("div");
    sellerRow.className = "orderSellerRow";

    const statusBadge = document.createElement("span");
    const statusClass = getStatusClass(order.status);
    statusBadge.className = statusClass ? `statusBadge ${statusClass}` : "statusBadge";
    statusBadge.textContent = order.status || "Unknown";
    sellerRow.appendChild(statusBadge);

    if (order.sellerUsername) {
      const sellerChip = document.createElement("span");
      sellerChip.className = "sellerChip";

      if (order.sellerProfileImageUrl) {
        const avatarWrap = document.createElement("span");
        avatarWrap.className = "sellerAvatarWrap";

        const avatar = document.createElement("img");
        avatar.className = "sellerAvatar";
        avatar.src = order.sellerProfileImageUrl;
        avatar.alt = "";
        avatarWrap.appendChild(avatar);

        if (order.isPremierShop) {
          avatarWrap.classList.add("sellerAvatarWrap--premier");
          const badge = document.createElementNS("http://www.w3.org/2000/svg", "svg");
          badge.setAttribute("fill", "none");
          badge.setAttribute("viewBox", "0 0 38 38");
          badge.setAttribute("class", "sellerPremierBadge");
          badge.innerHTML = '<defs><linearGradient id="pg0" x1="30.7666" x2="30.7666" y1="0.4" y2="30.93" gradientUnits="userSpaceOnUse"><stop offset="0.255" stop-color="#F0D400"/><stop offset="1" stop-color="#E39601"/></linearGradient><linearGradient id="pg1" x1="7.231" x2="7.231" y1="0.4" y2="30.93" gradientUnits="userSpaceOnUse"><stop offset="0.255" stop-color="#F0D400"/><stop offset="1" stop-color="#E39601"/></linearGradient></defs><path d="M32.3776 12.1644C31.1032 13.437 31.0795 14.6153 31.4769 16.2019C31.6705 17.0997 31.7725 18.0316 31.7725 18.9872C31.7725 19.7721 31.7037 20.541 31.572 21.2881C31.4939 21.7292 31.3942 22.162 31.2738 22.586C30.3229 25.9369 28.0778 28.744 25.1106 30.4356C24.7941 30.6159 24.6841 31.0184 24.8647 31.3342C24.9694 31.517 25.1482 31.6309 25.342 31.6594C25.483 31.6801 25.6317 31.6557 25.7649 31.5796C26.6107 31.0973 27.4034 30.5326 28.1317 29.8962C29.1625 30.6969 30.7017 31.4334 32.1067 31.0127C33.4494 30.6534 34.2498 29.6602 34.874 28.4751C35.0252 28.188 34.9348 27.8316 34.6681 27.6635C33.5414 26.9535 32.4039 26.4592 31.0569 26.8196C30.9412 26.8504 30.8296 26.8861 30.7218 26.9261C31.2702 26.0917 31.7346 25.1972 32.1031 24.2547C33.3321 24.2784 34.4668 24.0942 35.3868 23.1759C36.3697 22.1944 36.5655 20.9348 36.5125 19.5968C36.4998 19.2726 36.2429 19.0091 35.9277 18.9967C34.8974 18.9561 33.9259 19.0307 33.0822 19.523C33.0886 19.3452 33.0919 19.1666 33.0919 18.9872C33.0919 18.081 33.0087 17.1943 32.8492 16.3341C33.7903 16.2673 34.6562 16.001 35.3868 15.2717C36.3697 14.2903 36.5655 13.0307 36.5125 11.6926C36.4998 11.3684 36.2429 11.105 35.9277 11.0926C34.5964 11.0401 33.3638 11.1798 32.3776 12.1644Z" fill="url(#pg0)"/><path d="M5.62045 12.1644C6.8948 13.437 6.91851 14.6153 6.52113 16.2019C6.32759 17.0997 6.22554 18.0316 6.22554 18.9872C6.22554 19.7721 6.29435 20.541 6.42604 21.2881C6.50412 21.7292 6.60385 22.162 6.7242 22.586C7.67513 25.9369 9.92025 28.744 12.8874 30.4356C13.2039 30.6159 13.3139 31.0184 13.1333 31.3342C13.0287 31.517 12.8498 31.6309 12.656 31.6594C12.515 31.6801 12.3664 31.6557 12.2331 31.5796C11.3874 31.0973 10.5947 30.5326 9.86639 29.8962C8.83557 30.6969 7.2963 31.4334 5.8913 31.0127C4.54866 30.6534 3.74823 29.6602 3.12408 28.4751C2.9728 28.188 3.06326 27.8316 3.32998 27.6635C4.45666 26.9535 5.59417 26.4592 6.94119 26.8196C7.0569 26.8504 7.16848 26.8861 7.2762 26.9261C6.72781 26.0917 6.26343 25.1972 5.89491 24.2547C4.66592 24.2784 3.53125 24.0942 2.61125 23.1759C1.62836 22.1944 1.43251 20.9348 1.48559 19.5968C1.49822 19.2726 1.75515 19.0091 2.07032 18.9967C3.10063 18.9561 4.07217 19.0307 4.91589 19.523C4.90945 19.3452 4.9061 19.1666 4.9061 18.9872C4.9061 18.081 4.98934 17.1943 5.14886 16.3341C4.20772 16.2673 3.34184 16.001 2.61125 15.2717C1.62836 14.2903 1.43251 13.0307 1.48559 11.6926C1.49822 11.3684 1.75515 11.105 2.07032 11.0926C3.40162 11.0401 4.63422 11.1798 5.62045 12.1644Z" fill="url(#pg1)"/>';
          avatarWrap.appendChild(badge);
        }

        sellerChip.appendChild(avatarWrap);
      }

      const sellerName = document.createElement("a");
      sellerName.className = "sellerName";
      sellerName.textContent = order.sellerUsername;
      sellerName.href = `https://www.whatnot.com/user/${encodeURIComponent(order.sellerUsername)}`;
      sellerName.target = "_blank";
      sellerName.rel = "noopener noreferrer";
      sellerChip.appendChild(sellerName);
      sellerRow.appendChild(sellerChip);
    }

    meta.appendChild(sellerRow);

    const title = document.createElement("a");
    title.className = "orderTitle";
    title.textContent = order.title || "(No title)";
    title.href = order.orderUrl || (order.href ? `https://www.whatnot.com${order.href}` : "https://www.whatnot.com");
    title.target = "_blank";
    title.rel = "noopener noreferrer";
    meta.appendChild(title);

    const purchased = document.createElement("div");
    purchased.className = "orderLine";

    const purchasedLabel = document.createElement("span");
    purchasedLabel.className = "orderLabel";
    purchasedLabel.textContent = "Purchased:";

    const purchasedValue = document.createElement("span");
    purchasedValue.className = "orderValue";
    purchasedValue.textContent = order.price || "Unknown";

    purchased.appendChild(purchasedLabel);
    purchased.appendChild(purchasedValue);

    const dateLine = document.createElement("div");
    dateLine.className = "orderLine";

    const dateLabel = document.createElement("span");
    dateLabel.className = "orderLabel";
    dateLabel.textContent = "Date:";

    const dateValue = document.createElement("span");
    dateValue.className = "orderValue";
    dateValue.textContent = formatOrderDate(order);

    dateLine.appendChild(dateLabel);
    dateLine.appendChild(dateValue);

    meta.appendChild(purchased);
    meta.appendChild(dateLine);

    if (order.description) {
      const descLine = document.createElement("div");
      descLine.className = "orderLine";

      const descText = document.createElement("span");
      descText.className = "orderDescText";
      descText.textContent = order.description;
      descLine.appendChild(descText);
      meta.appendChild(descLine);
    }

    if (order.shippingServiceName) {
      const shippedLine = document.createElement("div");
      shippedLine.className = "orderLine";

      const shippedLabel = document.createElement("span");
      shippedLabel.className = "orderLabel";
      shippedLabel.textContent = "Shipped:";

      const shippedValue = document.createElement("span");
      shippedValue.className = "orderValue orderShippedValue";

      if (order.courierLogoSmallUrl) {
        const courierLogo = document.createElement("img");
        courierLogo.className = "courierLogo";
        courierLogo.src = order.courierLogoSmallUrl;
        courierLogo.alt = "";
        shippedValue.appendChild(courierLogo);
      }

      shippedValue.appendChild(document.createTextNode(" " + order.shippingServiceName));

      if (order.shippingEta) {
        const etaSpan = document.createElement("span");
        etaSpan.className = "shippingEta";
        etaSpan.textContent = " \u00b7 ETA: " + order.shippingEta;
        shippedValue.appendChild(etaSpan);
      }

      shippedLine.appendChild(shippedLabel);
      shippedLine.appendChild(shippedValue);
      meta.appendChild(shippedLine);
    }

    cardBody.appendChild(meta);
    card.appendChild(imageWrap);
    card.appendChild(cardBody);
    ordersListEl.appendChild(card);
  }
}

async function loadStatus() {
  const response = await chrome.runtime.sendMessage({ type: "WHATNOT_GET_STATUS" });
  const settings = response?.settings || { enabled: false, refreshMinutes: 1 };

  enabledEl.checked = Boolean(settings.enabled);
  refreshMinutesEl.value = String(settings.refreshMinutes || 1);
  scanStateEl.textContent = formatScanTime(response?.lastScanAt);
  latestStatus = {
    enabled: Boolean(settings.enabled),
    nextScanAt: Number(response?.nextScanAt || 0),
    isScanning: Boolean(response?.isScanning),
    isOnTargetPage: Boolean(response?.isOnTargetPage),
    hasTargetTab: Boolean(response?.hasTargetTab)
  };
  renderCountdown();
  renderOrders(response?.orders || []);
}

async function saveSettings() {
  const refreshMinutes = Math.max(1, Math.round(Number(refreshMinutesEl.value) || 1));
  refreshMinutesEl.value = String(refreshMinutes);

  const payload = {
    enabled: enabledEl.checked,
    refreshMinutes
  };

  const response = await chrome.runtime.sendMessage({
    type: "WHATNOT_SAVE_SETTINGS",
    payload
  });

  latestStatus.enabled = Boolean(payload.enabled);
  latestStatus.isScanning = Boolean(response?.isScanning || (payload.enabled && response?.scanStarted));
  latestStatus.isOnTargetPage = Boolean(response?.isOnTargetPage);
  latestStatus.hasTargetTab = Boolean(response?.hasTargetTab);
  latestStatus.nextScanAt = Number(response?.nextScanAt || 0);
  if (!latestStatus.enabled) {
    latestStatus.nextScanAt = 0;
    latestStatus.isScanning = false;
    latestStatus.isOnTargetPage = false;
    latestStatus.hasTargetTab = false;
  }
  renderCountdown();

  if (response?.ok) {
    await loadStatus();
  }
}

enabledEl.addEventListener("change", () => {
  saveSettings();
});
refreshMinutesEl.addEventListener("change", saveSettings);
refreshMinutesEl.addEventListener("blur", () => {
  const normalized = Math.max(1, Math.round(Number(refreshMinutesEl.value) || 1));
  refreshMinutesEl.value = String(normalized);
  saveSettings();
});

openPageEl.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "WHATNOT_OPEN_TARGET" });
  await loadStatus();
});

refreshOrdersEl.addEventListener("click", async () => {
  refreshOrdersEl.disabled = true;
  refreshOrdersEl.textContent = "Refreshing…";
  try {
    await chrome.runtime.sendMessage({ type: "WHATNOT_TRIGGER_SCAN" });
    await loadStatus();
  } finally {
    refreshOrdersEl.disabled = false;
    refreshOrdersEl.textContent = "Refresh";
  }
});

loadStatus().catch(() => {
  // Service worker may still be starting up; retry once after a short delay
  setTimeout(() => loadStatus().catch(() => {}), 1500);
});

setInterval(() => {
  renderCountdown();
}, 1000);

setInterval(() => {
  loadStatus().catch(() => {
    // keep popup responsive even if a background call fails intermittently
  });
}, 5000);
