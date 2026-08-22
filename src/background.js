// Cross-origin fetches on behalf of content scripts, and the toolbar click.
console.log("[YLR-bg] service worker loaded");

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

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("library.html") });
});
