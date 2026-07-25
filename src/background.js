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

chrome.action.onClicked.addListener((tab) => {
  console.log("[YLR-bg] toolbar clicked; tab", tab && tab.id, tab && tab.url);
  // Netflix still needs the click as its tabCapture gesture (nothing else can
  // grant it); everywhere else the click opens the saved-clips library.
  if (!tab || !tab.id || !/(^|\.)netflix\.com$/.test(hostOf(tab.url))) {
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
