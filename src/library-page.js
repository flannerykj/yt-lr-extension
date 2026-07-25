// The extension's library page. Clips are stored in IndexedDB under the site's
// origin, so this page can't read them directly — it asks a content script in an
// open YouTube/Netflix tab to hand them over, a few at a time (each clip carries
// a base64 WAV, so one big message would be far too large). YouTube and Netflix
// have separate origins and therefore separate databases: both get pulled.
(function () {
  const CHUNK = 4;
  const SITES = ["*://www.youtube.com/*", "*://www.netflix.com/*"];

  const style = document.createElement("style");
  style.textContent = window.YLRView.CSS;
  document.head.appendChild(style);

  const statusEl = document.getElementById("status");
  const view = window.YLRView.mount({
    list: document.getElementById("list"),
    search: document.getElementById("q"),
    sort: document.getElementById("sort")
  });

  function setStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.classList.toggle("err", !!isError);
  }

  function pull(tabId, from) {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, { type: "YLR_LIBRARY_PULL", from, count: CHUNK }, (res) => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error(err.message));
        if (!res) return reject(new Error("no response from the page"));
        if (res.error) return reject(new Error(res.error));
        resolve(res);
      });
    });
  }

  // One tab per origin is enough, and the most recently used one is likeliest
  // to have a live content script.
  async function sourceTabs() {
    const tabs = await chrome.tabs.query({ url: SITES });
    const byHost = new Map();
    for (const t of tabs) {
      if (!t.id || !t.url) continue;
      let host;
      try {
        host = new URL(t.url).hostname;
      } catch (e) {
        continue;
      }
      const prev = byHost.get(host);
      if (!prev || (t.lastAccessed || 0) > (prev.lastAccessed || 0)) byHost.set(host, t);
    }
    return [...byHost.values()];
  }

  async function loadFrom(tab) {
    let from = 0;
    let total = null;
    let host = tab.url;
    try {
      host = new URL(tab.url).hostname;
    } catch (e) {}
    while (total === null || from < total) {
      const res = await pull(tab.id, from);
      total = res.total;
      if (res.clips && res.clips.length) view.add(res.clips);
      from += CHUNK;
      if (!res.clips || !res.clips.length) break;
      setStatus("Loading from " + host + "… " + Math.min(from, total) + " of " + total);
    }
    return total || 0;
  }

  async function load() {
    let tabs;
    try {
      tabs = await sourceTabs();
    } catch (e) {
      setStatus("Couldn't look for tabs: " + e.message, true);
      return;
    }
    if (!tabs.length) {
      setStatus(
        "Open a YouTube or Netflix tab, then reload this page — your clips are stored under that site's origin.",
        true
      );
      return;
    }
    const problems = [];
    for (const tab of tabs) {
      try {
        await loadFrom(tab);
      } catch (e) {
        problems.push((tab.url || "tab") + ": " + e.message);
      }
    }
    const n = view.count();
    if (problems.length && !n) {
      setStatus(
        "Couldn't read saved clips. Try reloading the YouTube/Netflix tab first. (" +
          problems.join("; ") +
          ")",
        true
      );
      return;
    }
    setStatus(
      n + (n === 1 ? " clip" : " clips") +
        (problems.length ? " · some tabs failed: " + problems.join("; ") : "")
    );
  }

  load();
})();
