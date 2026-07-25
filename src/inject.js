// Runs in the page's MAIN world. Gets json3 subtitles for the video actually
// playing. We don't read caption info from /youtubei/v1/player responses —
// YouTube prefetches those for recommended videos, so they belong to the wrong
// clip. Instead the track list comes from the player's own captions module, and
// the subtitle data comes from intercepting the /api/timedtext request YouTube
// makes (it carries the required proof-of-origin token).
(function () {
  const originalFetch = window.fetch;
  const recentlyHandled = new Map(); // dedupe key -> timestamp
  const capturedUrls = new Map(); // lang -> authenticated json3 URL
  const capturedText = new Map(); // lang -> json3 text (served on request)

  function currentVideoId() {
    try {
      const u = new URL(location.href);
      if (u.searchParams.get("v")) return u.searchParams.get("v");
      const m = location.pathname.match(/\/(shorts|embed)\/([^/?#]+)/);
      if (m) return m[2];
    } catch (e) {}
    return null;
  }

  function player() {
    const mp = document.getElementById("movie_player");
    return mp && typeof mp.getOption === "function" ? mp : null;
  }

  function tracklist() {
    const mp = player();
    if (!mp) return null;
    try {
      mp.loadModule("captions");
    } catch (e) {}
    try {
      return (
        mp.getOption("captions", "tracklist", { includeAsr: true }) ||
        mp.getOption("captions", "tracklist") ||
        []
      );
    } catch (e) {
      return null;
    }
  }

  function pushTracks() {
    const list = tracklist();
    if (!list || !list.length) return false;
    const tracks = list.map((t) => ({
      languageCode: t.languageCode,
      name: t.displayName || t.languageName || t.languageCode,
      kind: t.kind || ""
    }));
    window.postMessage(
      {
        source: "YLR",
        type: "TRACKS",
        tracks,
        videoId: currentVideoId(),
        title: document.title.replace(/ - YouTube$/, "")
      },
      "*"
    );
    return true;
  }

  async function deliver(lang, kind, url, videoId, bodyMaybe) {
    const key = "deliver|" + videoId + "|" + lang;
    const now = Date.now();
    if (recentlyHandled.get(key) > now - 2000) return;
    recentlyHandled.set(key, now);
    try {
      let text = bodyMaybe;
      let status = "(cached body)";
      if (!text || text.trimStart()[0] !== "{") {
        const res = await originalFetch(url, { credentials: "include" });
        status = res.status;
        text = await res.text();
      }
      if (text.trimStart()[0] === "{") {
        capturedText.set(lang, text);
        window.postMessage(
          { source: "YLR", type: "CAPTIONS", lang, kind, videoId, text },
          "*"
        );
        fetchTranslation(lang, videoId, url);
      } else {
        console.log("[YLR] response was not json3 (status " + status + "):", text.slice(0, 120));
      }
    } catch (e) {
      console.log("[YLR] deliver failed:", e);
    }
  }

  // YouTube can auto-translate any track: the same authenticated URL with
  // &tlang=en returns English on the same timeline (tlang isn't part of the
  // signed params, so adding it doesn't invalidate the token).
  async function fetchTranslation(lang, videoId, sourceUrl) {
    if (!lang || lang.toLowerCase().startsWith("en")) return;
    const key = "tr|" + videoId + "|" + lang;
    const now = Date.now();
    if (recentlyHandled.get(key) > now - 2000) return;
    recentlyHandled.set(key, now);
    try {
      const u = new URL(sourceUrl);
      u.searchParams.set("tlang", "en");
      u.searchParams.set("fmt", "json3");
      const res = await originalFetch(u.toString(), { credentials: "include" });
      const text = await res.text();
      if (text.trimStart()[0] === "{") {
        window.postMessage(
          { source: "YLR", type: "TRANSLATION", lang, videoId, text },
          "*"
        );
      }
    } catch (e) {
      console.log("[YLR] translation fetch failed:", e);
    }
  }

  function handleTimedText(rawUrl, bodyMaybe) {
    let u;
    try {
      u = new URL(rawUrl, location.origin);
    } catch (e) {
      return;
    }
    const v = u.searchParams.get("v");
    if (v && v !== currentVideoId()) return; // captions for some other video
    const lang = u.searchParams.get("lang") || "";
    const kind = u.searchParams.get("kind") || "";
    const wasJson3 = u.searchParams.get("fmt") === "json3";
    u.searchParams.set("fmt", "json3");
    capturedUrls.set(lang, u.toString());
    deliver(lang, kind, u.toString(), v, wasJson3 ? bodyMaybe : null);
  }

  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
      if (url && url.includes("/api/timedtext")) {
        response.clone().text().then((t) => handleTimedText(url, t)).catch(() => {});
      }
    } catch (e) {}
    return response;
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
        if (this.__ylrUrl && String(this.__ylrUrl).includes("/api/timedtext")) {
          handleTimedText(this.__ylrUrl, this.responseText);
        }
      } catch (e) {}
    });
    return xhrSend.apply(this, arguments);
  };

  // Force YouTube to (re)fetch a track — toggle off then on so it fires even if
  // the track is already active (otherwise setOption is a no-op).
  function forceLoad(languageCode, kind) {
    const mp = player();
    if (!mp) {
      const btn = document.querySelector(".ytp-subtitles-button");
      if (btn && btn.getAttribute("aria-pressed") !== "true") btn.click();
      return false;
    }
    const list = tracklist() || [];
    if (!list.length) return false;
    const track =
      list.find((x) => x.languageCode === languageCode && (kind ? (x.kind || "") === kind : true)) ||
      list.find((x) => x.languageCode === languageCode);
    if (!track) return false;
    try {
      mp.setOption("captions", "track", {});
      setTimeout(() => {
        try {
          mp.setOption("captions", "track", track);
        } catch (e) {
          console.log("[YLR] setOption(on) error:", e);
        }
      }, 150);
      return true;
    } catch (e) {
      console.log("[YLR] setOption(off) error:", e);
      return false;
    }
  }

  window.addEventListener("message", (ev) => {
    if (ev.source !== window || ev.data?.source !== "YLR-CS") return;
    const d = ev.data;
    if (d.type === "REQUEST_TRACKS") {
      pushTracks();
    } else if (d.type === "SELECT_TRACK") {
      const { languageCode, kind } = d;
      console.log("[YLR] SELECT_TRACK requested:", languageCode, kind);
      // Serve the already-intercepted json3 text if we have it. We never
      // re-fetch the timedtext URL: YouTube's URLs return empty on a second
      // fetch, so we rely on the body captured when the player first loaded it.
      const serve = () => {
        if (!capturedText.has(languageCode)) return false;
        window.postMessage(
          {
            source: "YLR",
            type: "CAPTIONS",
            lang: languageCode,
            kind: kind || "",
            videoId: currentVideoId(),
            text: capturedText.get(languageCode)
          },
          "*"
        );
        fetchTranslation(languageCode, currentVideoId(), capturedUrls.get(languageCode) || "");
        return true;
      };
      if (serve()) return;
      let tries = 0;
      const attempt = () => {
        if (serve()) return;
        if (forceLoad(languageCode, kind)) return;
        if (tries++ < 25) setTimeout(attempt, 300);
        else console.log("[YLR] gave up forcing caption load for", languageCode);
      };
      attempt();
    }
  });

  // The player and its caption module aren't ready immediately; poll until the
  // track list is available, then hand it to the sidebar.
  function pollTracks() {
    let n = 0;
    const iv = setInterval(() => {
      if (pushTracks() || n++ > 40) clearInterval(iv);
    }, 300);
  }
  pollTracks();
  document.addEventListener("yt-navigate-finish", () => {
    capturedUrls.clear();
    pollTracks();
  });
})();
