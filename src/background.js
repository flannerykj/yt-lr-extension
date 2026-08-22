// Clicking the toolbar icon enables tab-audio capture for that tab (one gesture
// per session — the Language Reactor model). The click is the user gesture
// Chrome requires for tabCapture. We get a streamId and hand it to the tab's
// content script, which turns it into a MediaStream for the audio ring buffer.
console.log("[YLR-bg] service worker loaded");

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return "";
  }
}

function openLibrary() {
  chrome.tabs.create({ url: chrome.runtime.getURL("library.html") });
}

// Byte ranges for the direct audio fetch. Same reason as the text fetch: the
// worker isn't bound by the page's CORS rules. Returned base64 because extension
// messages are JSON.
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || msg.type !== "YLR_FETCH_BYTES") return;
  const init = { credentials: "omit" };
  if (msg.from != null) init.headers = { Range: "bytes=" + msg.from + "-" + msg.to };
  fetch(msg.url, init)
    .then((res) => {
      if (!res.ok && res.status !== 206) throw new Error("HTTP " + res.status);
      return res.arrayBuffer();
    })
    .then((buf) => {
      const bytes = new Uint8Array(buf);
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000)
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      respond({ ok: true, body: btoa(binary) });
    })
    .catch((e) => {
      console.log("[YLR-bg] byte fetch failed:", msg.url && msg.url.slice(0, 80), e.message);
      respond({ ok: false, error: e.message });
    });
  return true;
});

// DRM sites (Netflix, Prime Video) can't have their <video> tapped, so their
// audio comes from tabCapture — which needs this click as its user gesture.
function needsTabCapture(url) {
  return /(^|\.)(netflix\.com|primevideo\.com)$/.test(hostOf(url));
}

// Amazon's subtitle CDN doesn't reliably send CORS headers for the page origin,
// so the content script asks the worker (which has host access) to fetch for it.
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || msg.type !== "YLR_FETCH_TEXT") return;
  fetch(msg.url, { credentials: "omit" })
    .then((res) => {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.text();
    })
    .then((text) => respond({ ok: true, text }))
    .catch((e) => {
      console.log("[YLR-bg] fetch failed:", msg.url, e.message);
      respond({ ok: false, error: e.message });
    });
  return true;
});

chrome.action.onClicked.addListener((tab) => {
  console.log("[YLR-bg] toolbar clicked; tab", tab && tab.id, tab && tab.url);
  // Everywhere else the click opens the saved-clips library.
  if (!tab || !tab.id || !needsTabCapture(tab.url)) {
    openLibrary();
    return;
  }
  if (!chrome.tabCapture || !chrome.tabCapture.getMediaStreamId) {
    console.log("[YLR-bg] chrome.tabCapture.getMediaStreamId unavailable");
    chrome.tabs.sendMessage(tab.id, { type: "ENABLE_CAPTURE", error: "tabCapture API unavailable" });
    return;
  }
  chrome.tabCapture.getMediaStreamId(
    { targetTabId: tab.id, consumerTabId: tab.id },
    (streamId) => {
      const err = chrome.runtime.lastError;
      if (err || !streamId) {
        console.log("[YLR-bg] getMediaStreamId failed:", err && err.message);
        chrome.tabs.sendMessage(tab.id, {
          type: "ENABLE_CAPTURE",
          error: (err && err.message) || "no streamId returned"
        });
        return;
      }
      console.log("[YLR-bg] got streamId (len " + String(streamId).length + "); sending to tab", tab.id);
      chrome.tabs.sendMessage(tab.id, { type: "ENABLE_CAPTURE", streamId }, () => {
        if (chrome.runtime.lastError) {
          console.log("[YLR-bg] sendMessage to tab failed:", chrome.runtime.lastError.message);
        } else {
          console.log("[YLR-bg] ENABLE_CAPTURE delivered to tab");
        }
      });
    }
  );
});
