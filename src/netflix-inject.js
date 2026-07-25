// Netflix MAIN world. Netflix delivers subtitle track URLs inside its player
// manifest, which the page fetches and parses. We hook JSON.parse to grab that
// manifest, extract the WebVTT tracks, and post them to the content script. Also
// handles seeking through Netflix's player API.
(function () {
  console.log("[YLR] netflix-inject loaded");
  const origParse = JSON.parse;
  const originalFetch = window.fetch;
  let cached = null; // { tracks, mediaId, title }

  function urlFrom(urls) {
    if (!urls) return null;
    if (typeof urls === "string") return urls;
    if (Array.isArray(urls)) {
      for (const u of urls) {
        if (typeof u === "string") return u;
        if (u && u.url) return u.url;
      }
      return null;
    }
    if (typeof urls === "object") {
      const v = Object.values(urls).find((x) => typeof x === "string" || (x && x.url));
      return v ? (typeof v === "string" ? v : v.url) : null;
    }
    return null;
  }

  function extractTrackUrl(t) {
    // Legacy manifest: ttDownloadables keyed by content profile.
    if (t.ttDownloadables) {
      const dl = t.ttDownloadables;
      const key = ["webvtt-lssdh-ios8", "webvtt", "dfxp-ls-sdh", "imsc1.1", "simplesdh"].find(
        (k) => dl[k]
      );
      if (key) {
        const url = urlFrom(dl[key].downloadUrls || dl[key].urls || dl[key]);
        if (url) return { url, format: /webvtt/i.test(key) ? "webvtt" : "ttml" };
      }
    }
    // Current manifest: downloadables is an object keyed by content profile
    // (e.g. "webvtt-lssdh-ios8", "imsc1.1", "dfxp-ls-sdh"), each with urls.
    if (t.downloadables && typeof t.downloadables === "object") {
      const keys = Object.keys(t.downloadables);
      const key =
        keys.find((k) => /webvtt/i.test(k)) ||
        keys.find((k) => /imsc|dfxp|ttml|sdh/i.test(k)) ||
        keys[0];
      if (key) {
        const entry = t.downloadables[key];
        const url = urlFrom(entry.urls || entry.downloadUrls || entry.downloadUrl || entry);
        if (url) return { url, format: /webvtt/i.test(key) ? "webvtt" : "ttml" };
      }
    }
    return null;
  }

  function handleManifest(m, trackKey) {
    const list = m[trackKey || "timedtexttracks"];
    if (!Array.isArray(list)) return;
    const sample = list.find(
      (t) => !t.isNoneTrack && (t.downloadables || t.ttDownloadables)
    );
    if (sample) {
      console.log(
        "[YLR] track dl sample:",
        JSON.stringify({
          language: sample.language,
          downloadables: sample.downloadables,
          ttDownloadables: sample.ttDownloadables
        }).slice(0, 800)
      );
    }
    const tracks = [];
    for (const t of list) {
      if (t.isNoneTrack) continue;
      const picked = extractTrackUrl(t);
      if (!picked) continue;
      tracks.push({
        languageCode: t.language,
        name: t.languageDescription || t.language,
        kind: t.rawTrackType || t.trackType || "",
        isForced: !!t.isForcedNarrative,
        url: picked.url,
        format: picked.format
      });
    }
    console.log("[YLR] extracted", tracks.length, "tracks of", list.length);
    if (!tracks.length) return;
    cached = {
      tracks,
      mediaId: String(m.movieId),
      title: document.title.replace(/ - Netflix$/, "")
    };
    console.log(
      "[YLR] Netflix manifest tracks:",
      tracks.map((t) => t.languageCode + (t.isForced ? "(forced)" : "")).join(", ")
    );
    post();
  }

  function post() {
    if (cached) window.postMessage(Object.assign({ source: "YLR", type: "NF_TRACKS" }, cached), "*");
  }

  let discoveryLogged = false;
  function scanDeep(node, depth) {
    if (!node || typeof node !== "object" || depth > 8) return false;
    if (node.movieId) {
      const trackKey = ["timedtexttracks", "textTracks", "timedtext", "timedTextTracks"].find(
        (k) => Array.isArray(node[k])
      );
      if (trackKey) {
        handleManifest(node, trackKey);
        return true;
      }
      if (!discoveryLogged) {
        discoveryLogged = true;
        console.log("[YLR] object with movieId, keys:", Object.keys(node));
      }
    }
    for (const k in node) {
      const v = node[k];
      if (v && typeof v === "object" && scanDeep(v, depth + 1)) return true;
    }
    return false;
  }

  function looksLikeManifest(text) {
    return (
      typeof text === "string" &&
      text.length > 2000 &&
      (text.indexOf("timedtexttracks") !== -1 || text.indexOf("movieId") !== -1)
    );
  }

  function scanText(text) {
    if (!looksLikeManifest(text)) return;
    console.log("[YLR] manifest-shaped response seen (len " + text.length + ")");
    try {
      scanDeep(origParse(text), 0);
    } catch (e) {
      console.log("[YLR] manifest parse failed:", e);
    }
  }

  JSON.parse = function (text) {
    const data = origParse.apply(this, arguments);
    try {
      if (looksLikeManifest(text)) {
        console.log("[YLR] manifest-shaped JSON.parse seen (len " + text.length + ")");
        scanDeep(data, 0);
      }
    } catch (e) {}
    return data;
  };

  // Netflix may parse its manifest with response.json() (native, not the hook
  // above), so also scan manifest-looking network responses.
  window.fetch = async function (...args) {
    const res = await originalFetch.apply(this, args);
    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
      if (url && /manifest|licensedManifest|\/msl|cadmium|playapi|pathEvaluator|\/nq\//i.test(url)) {
        res.clone().text().then(scanText).catch(() => {});
      }
    } catch (e) {}
    return res;
  };

  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ylrUrl = url;
    return xhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener("load", function () {
      try {
        if (this.__ylrUrl && /manifest|licensedManifest|\/msl|cadmium|playapi|pathEvaluator|\/nq\//i.test(String(this.__ylrUrl))) {
          scanText(this.responseText);
        }
      } catch (e) {}
    });
    return xhrSend.apply(this, arguments);
  };

  function seek(seconds) {
    try {
      const api = window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
      const ids = api.getAllPlayerSessionIds();
      const sid = ids.find((i) => String(i).includes("watch")) || ids[0];
      const player = api.getVideoPlayerBySessionId(sid);
      const before = player.getCurrentTime ? player.getCurrentTime() : "n/a";
      player.seek(Math.floor(seconds * 1000));
      console.log(
        "[YLR] NF_SEEK target",
        Math.floor(seconds * 1000),
        "ms | player.getCurrentTime before:",
        before,
        "| sessions:",
        JSON.stringify(ids),
        "sid:",
        sid
      );
    } catch (e) {
      console.log("[YLR] Netflix seek failed:", e);
    }
  }

  window.addEventListener("message", (ev) => {
    if (ev.source !== window || ev.data?.source !== "YLR-CS") return;
    const d = ev.data;
    if (d.type === "NF_REQUEST_TRACKS") post();
    else if (d.type === "NF_SEEK") seek(d.seconds);
  });
})();
