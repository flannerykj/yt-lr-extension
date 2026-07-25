// Two ways to see your saved clips, both fed from this content script because
// IndexedDB lives under the site's origin:
//   - "Export library" writes one self-contained HTML file (audio inlined as
//     data URIs) that opens off the disk with no extension and no server.
//   - The extension's library page pulls clips over messaging, a few at a time.
// Both render with src/library-view.js — inlined into the export, loaded as a
// script by the page.
(function () {
  const NS = (window.YLR = window.YLR || {});

  function blobToDataUri(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error || new Error("could not read clip audio"));
      fr.readAsDataURL(blob);
    });
  }

  async function toPlain(clip) {
    return {
      text: clip.text || "",
      translation: clip.translation || "",
      videoTitle: clip.videoTitle || "",
      url: clip.url || "",
      start: clip.start,
      end: clip.end,
      createdAt: clip.createdAt,
      audio: clip.audio ? await blobToDataUri(clip.audio) : null
    };
  }

  // Safe inside <script type="application/json">: base64 has no "<", but clip
  // text is arbitrary and could otherwise close the tag. Read back with
  // JSON.parse, so U+2028/9 need no escaping.
  function embedJson(value) {
    return JSON.stringify(value)
      .replace(/</g, "\\u003c")
      .replace(/>/g, "\\u003e")
      .replace(/&/g, "\\u0026");
  }

  const BOOTSTRAP = `
var style = document.createElement("style");
style.textContent = window.YLRView.CSS;
document.head.appendChild(style);
window.YLRView.mount({
  list: document.getElementById("list"),
  search: document.getElementById("q"),
  sort: document.getElementById("sort")
}).set(JSON.parse(document.getElementById("data").textContent));
`;

  async function viewSource() {
    const res = await fetch(chrome.runtime.getURL("src/library-view.js"));
    if (!res.ok) throw new Error("could not load the viewer (HTTP " + res.status + ")");
    return res.text();
  }

  // clips arrive newest-first (db.all sorts by createdAt desc)
  async function buildLibraryHtml(clips, onProgress) {
    const view = await viewSource();
    const out = [];
    for (let i = 0; i < clips.length; i++) {
      out.push(await toPlain(clips[i]));
      if (onProgress) onProgress(i + 1, clips.length);
    }
    const seconds = out.reduce((n, c) => n + Math.max(0, c.end - c.start || 0), 0);
    const close = "</" + "script>";
    return (
      '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      "<title>Saved clips</title>\n</head>\n<body>\n" +
      '<header>\n<h1>Saved clips</h1>\n<div class="sub">' +
      out.length +
      (out.length === 1 ? " clip" : " clips") +
      " · " +
      Math.round(seconds) +
      "s of audio · exported " +
      new Date().toLocaleString() +
      '</div>\n<div class="controls">\n' +
      '<input type="search" id="q" placeholder="Search text, translation or video">\n' +
      '<select id="sort"><option value="newest">Newest first</option>' +
      '<option value="oldest">Oldest first</option>' +
      '<option value="video">Group by video</option></select>\n' +
      '</div>\n</header>\n<main id="list"></main>\n' +
      '<script id="data" type="application/json">' +
      embedJson(out) +
      close +
      "\n<script>" +
      view +
      close +
      "\n<script>" +
      BOOTSTRAP +
      close +
      "\n</body></html>\n"
    );
  }

  // ---- serving the extension's library page ----

  let pullCache = null;

  async function servePull(msg, respond) {
    try {
      if (!msg.from || !pullCache) pullCache = await NS.db.all();
      const slice = pullCache.slice(msg.from || 0, (msg.from || 0) + (msg.count || 4));
      const clips = [];
      for (const c of slice) clips.push(await toPlain(c));
      respond({ total: pullCache.length, origin: location.hostname, clips });
    } catch (e) {
      console.log("[YLR] library pull failed:", e.message);
      respond({ error: e.message });
    }
  }

  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, respond) => {
      if (!msg || msg.type !== "YLR_LIBRARY_PULL") return;
      servePull(msg, respond);
      return true; // responding asynchronously
    });
  }

  NS.buildLibraryHtml = buildLibraryHtml;
})();
