// Clicking the toolbar icon enables tab-audio capture on the active tab. The
// click is the user gesture Chrome requires for tabCapture. We hand the
// resulting streamId to the tab's content script, which turns it into a
// MediaStream for the audio ring buffer (used on Netflix, where the DRM-blocked
// element tap won't work).
chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id) return;
  chrome.tabCapture.getMediaStreamId(
    { targetTabId: tab.id, consumerTabId: tab.id },
    (streamId) => {
      if (chrome.runtime.lastError || !streamId) {
        console.log("[YLR] getMediaStreamId failed:", chrome.runtime.lastError);
        return;
      }
      chrome.tabs.sendMessage(tab.id, { type: "ENABLE_CAPTURE", streamId });
    }
  );
});
