// Prime Video MAIN world. Prime hands its player a "playback resources"
// document (GetPlaybackResources) that carries plain, un-DRM'd subtitle URLs
// under `subtitleUrls` / `forcedNarratives`. We hook fetch, XHR and JSON.parse,
// deep-scan anything that looks like that document, and post the tracks to the
// content script. Also handles seeking.
(function () {
  console.log("[YLR] prime-inject loaded 0.4.1");

  // The isolated world's NS.warn isn't reachable from here, so a local copy.
  // These hooks sit on the page's own fetch/XHR/JSON.parse and must never throw
  // into the page — but a hook that fails invisibly is indistinguishable from
  // one that was never installed.
  const warned = new Set();
  function warn(where, err) {
    const message = (err && err.message) || String(err == null ? "" : err);
    if (warned.has(where + message)) return;
    warned.add(where + message);
    console.log("[YLR] " + where + (message ? " — " + message : ""));
  }

  const origParse = JSON.parse;
  const originalFetch = window.fetch;
  let cached = null; // { tracks, mediaId, title }

  const LISTS = [
    ["subtitleUrls", "subtitle"],
    ["captionUrls", "caption"],
    ["forcedNarratives", "forced"]
  ];

  function formatOf(entry) {
    const f = String(entry.format || entry.subtype || "").toLowerCase();
    if (f.indexOf("vtt") !== -1) return "webvtt";
    if (f.indexOf("ttml") !== -1 || f.indexOf("dfxp") !== -1 || f.indexOf("imsc") !== -1)
      return "ttml";
    return "";  // let the adapter sniff the body
  }

  function trackFrom(entry, fallbackKind) {
    if (!entry || typeof entry !== "object") return null;
    const url = entry.url || entry.URL || entry.downloadUrl;
    if (typeof url !== "string" || !/^https?:/.test(url)) return null;
    const lang = entry.languageCode || entry.language || entry.locale;
    if (!lang) return null;
    return {
      languageCode: String(lang).replace(/_/g, "-"),
      name: entry.displayName || entry.languageDescription || String(lang),
      kind: String(entry.type || fallbackKind || "subtitle"),
      isForced: fallbackKind === "forced" || !!entry.isForcedNarrative,
      url,
      format: formatOf(entry)
    };
  }

  function collectTracks(node) {
    const tracks = [];
    const seenUrl = new Set();
    const seenKey = new Set();
    for (const [key, fallbackKind] of LISTS) {
      const list = node[key];
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        const t = trackFrom(entry, fallbackKind);
        if (!t || seenUrl.has(t.url)) continue;
        seenUrl.add(t.url);
        // core keys tracks by languageCode|kind, so two Spanish "subtitle"
        // tracks (plain + SDH) have to end up with distinct kinds.
        const base = t.kind;
        for (let n = 2; seenKey.has(t.languageCode + "|" + t.kind); n++) t.kind = base + "#" + n;
        seenKey.add(t.languageCode + "|" + t.kind);
        tracks.push(t);
      }
    }
    return tracks;
  }

  function pad(n) {
    return (n < 10 ? "0" : "") + n;
  }

  // The numbers usually sit on the episode's own catalog entry, but on some
  // responses only its season/series ancestors carry them.
  function findNumbers(node, depth, out) {
    if (!node || typeof node !== "object" || depth > 6) return out;
    if (out.season == null && typeof node.seasonNumber === "number")
      out.season = node.seasonNumber;
    if (out.episode == null && typeof node.episodeNumber === "number")
      out.episode = node.episodeNumber;
    for (const k in node) {
      const v = node[k];
      if (v && typeof v === "object") findNumbers(v, depth + 1, out);
    }
    return out;
  }

  function findShow(node, depth) {
    if (!node || typeof node !== "object" || depth > 6) return "";
    const kind = String(node.entityType || node.type || "").toLowerCase();
    if (node.title && /show|series/.test(kind) && !/season/.test(kind)) return node.title;
    for (const k in node) {
      const v = node[k];
      if (v && typeof v === "object") {
        const found = findShow(v, depth + 1);
        if (found) return found;
      }
    }
    return "";
  }

  // "Series - S01E03 - Episode title", so a downloaded file names the episode it
  // came from rather than just the season it belongs to.
  function titleOf(node) {
    const cm = node.catalogMetadata;
    const pageTitle = document.title.replace(/^Prime Video:?\s*/i, "").trim();
    if (!cm) return pageTitle;
    const cat = cm.catalog || {};
    const nums = {
      season: typeof cat.seasonNumber === "number" ? cat.seasonNumber : null,
      episode: typeof cat.episodeNumber === "number" ? cat.episodeNumber : null
    };
    if (nums.season == null || nums.episode == null) findNumbers(cm, 0, nums);

    const show = findShow(cm, 0);
    const parts = [];
    if (show) parts.push(show);
    if (nums.episode != null)
      parts.push((nums.season != null ? "S" + pad(nums.season) : "") + "E" + pad(nums.episode));
    if (cat.title && cat.title !== show) parts.push(cat.title);
    const out = parts.join(" - ").trim();
    console.log(
      "[YLR] Prime title:",
      JSON.stringify(out),
      "| catalog keys:",
      Object.keys(cat).join(",")
    );
    return out || cat.title || pageTitle;
  }

  function idOf(node) {
    const cat = node.catalogMetadata && node.catalogMetadata.catalog;
    if (cat && cat.id) return String(cat.id);
    if (node.asin) return String(node.asin);
    const m = location.pathname.match(/\/(?:detail|watch)\/([A-Z0-9]{8,})/i);
    return m ? m[1] : location.pathname;
  }

  // Prime's playback resources point at the DASH manifests for the feature
  // itself. Whether the *audio* adaptation set inside them is encrypted decides
  // whether clips can be fetched and decoded directly, the way it is done on
  // Netflix — an open question, because nothing has read one yet.
  //
  // Prime asks for its resources in several calls with different
  // `desiredResources`, so the response carrying the subtitles is usually NOT the
  // one carrying the media. These are therefore collected from every response,
  // independently of the subtitle handling, and matched on the *key* they sit
  // under rather than on a file extension the URLs may not have.
  // Deliberately narrow. A looser match (playbackUrls, urlSets, streamingUrls)
  // also hits Prime's ad payloads, which then poison the cache and the real
  // manifest is never looked at.
  const MEDIA_KEYS = /audioVideoUrls|avCdnUrlSets|avUrlInfoList/i;
  const NOT_MEDIA = /getAds|\/ads\b|amazon\.dev|doubleclick|\.metrics\./i;
  let mediaUrls = [];
  let shapeLogged = false;

  function collectMediaUrls(root) {
    const urls = [];
    const seen = new Set();
    const walk = (n, depth, underMedia) => {
      if (!n || typeof n !== "object" || depth > 9 || urls.length >= 6) return;
      for (const k in n) {
        const v = n[k];
        const inMedia = underMedia || MEDIA_KEYS.test(k);
        if (typeof v === "string") {
          if (inMedia && /^https?:/.test(v) && !NOT_MEDIA.test(v) && !seen.has(v)) {
            seen.add(v);
            urls.push(v);
          }
        } else if (v && typeof v === "object") {
          walk(v, depth + 1, inMedia);
        }
      }
    };
    walk(root, 0, false);
    return urls;
  }

  function noteMedia(root) {
    if (mediaUrls.length) return;
    const found = collectMediaUrls(root);
    if (!found.length) return;
    mediaUrls = found;
    console.log("[YLR] Prime media urls:", found.length, "|", found[0].slice(0, 140));
    if (cached) {
      cached.manifests = found;
      post();
    }
  }

  function handleResources(node) {
    const tracks = collectTracks(node);
    if (!tracks.length) return false;
    if (!shapeLogged) {
      shapeLogged = true;
      // What else came back alongside the subtitles? Names the container that
      // would hold the media urls, if this response has one at all.
      console.log("[YLR] playback resources keys:", Object.keys(node).join(","));
    }
    cached = { tracks, manifests: mediaUrls, mediaId: idOf(node), title: titleOf(node) };
    console.log(
      "[YLR] Prime subtitle tracks:",
      tracks.map((t) => t.languageCode + "/" + t.kind).join(", "),
      "| id",
      cached.mediaId
    );
    post();
    return true;
  }

  function post() {
    if (cached)
      window.postMessage(Object.assign({ source: "YLR", type: "PV_TRACKS" }, cached), "*");
  }

  function scanDeep(node, depth) {
    if (!node || typeof node !== "object" || depth > 8) return false;
    for (const [key] of LISTS) {
      if (Array.isArray(node[key]) && node[key].length) {
        if (handleResources(node)) return true;
      }
    }
    for (const k in node) {
      const v = node[k];
      if (v && typeof v === "object" && scanDeep(v, depth + 1)) return true;
    }
    return false;
  }

  function looksLikeResources(text) {
    return (
      typeof text === "string" &&
      text.length > 200 &&
      (text.indexOf("subtitleUrls") !== -1 ||
        text.indexOf("forcedNarratives") !== -1 ||
        text.indexOf("captionUrls") !== -1 ||
        text.indexOf("audioVideoUrls") !== -1 ||
        text.indexOf("avCdnUrlSets") !== -1)
    );
  }

  function scanText(text) {
    if (!looksLikeResources(text)) return;
    try {
      const data = origParse(text);
      scanDeep(data, 0);
      noteMedia(data);
    } catch (e) {
      console.log("[YLR] Prime resources parse failed:", e && e.message);
    }
  }

  JSON.parse = function (text) {
    const data = origParse.apply(this, arguments);
    try {
      if (looksLikeResources(text)) {
        scanDeep(data, 0);
        noteMedia(data);
      }
    } catch (e) {
      warn("prime: JSON.parse hook failed", e);
    }
    return data;
  };

  const RESOURCE_URL = /GetPlaybackResources|playbackresources|\/cdp\/catalog\/|atv-ps|GetVodPlaybackResources/i;

  // The media manifest is a DASH .mpd — XML, not JSON — so no amount of digging
  // through parsed objects will find it. Recognise it by its body as it goes
  // past, and hand it straight over: the URLs are short-lived and signed, so the
  // bytes are worth more than the address.
  // Cached, not just posted: this runs at document_start and the player fetches
  // its manifest early, so the message can easily land before the isolated-world
  // adapter (document_idle) has a listener. It is re-sent on request.
  // Prime splits a title across several manifests — video in one, audio in
  // another. Keeping only the first meant a video-only manifest ended the
  // search for good and the audio one was never looked at, so keep them all.
  const MAX_MPDS = 8;
  const mpds = [];
  function noteMpd(url, text) {
    if (typeof text !== "string") return;
    if (text.length < 200 || text.indexOf("<MPD") === -1) return;
    const href = String(url);
    if (mpds.length >= MAX_MPDS || mpds.some((m) => m.url === href)) return;
    const entry = { url: href, body: text.slice(0, 2000000) };
    mpds.push(entry);
    console.log(
      "[YLR] Prime DASH manifest " + mpds.length + " seen (" + text.length + " bytes)",
      href.slice(0, 100),
      "| audio sets: " + countAudioSets(text)
    );
    postOne(entry);
  }

  // Read in the main world too, so the count shows up even when the console is
  // filtered to this context.
  function countAudioSets(text) {
    const sets = text.match(/<AdaptationSet\b[^>]*/g) || [];
    const audio = sets.filter((a) => /audio/i.test(a));
    if (!audio.length) return "0 of " + sets.length + " set(s)";
    return (
      audio.length +
      " of " +
      sets.length +
      " set(s), lang=" +
      audio.map((a) => (a.match(/lang="([^"]*)"/) || [, "?"])[1]).join(",")
    );
  }

  function postOne(entry) {
    window.postMessage(Object.assign({ source: "YLR", type: "PV_MPD" }, entry), "*");
  }

  function postMpd() {
    for (const entry of mpds) postOne(entry);
  }

  function looksXml(res) {
    try {
      const type = res.headers.get("content-type") || "";
      return /xml|dash/i.test(type);
    } catch (e) {
      return false;
    }
  }

  window.fetch = async function (...args) {
    const res = await originalFetch.apply(this, args);
    try {
      const url = typeof args[0] === "string" ? args[0] : args[0] && args[0].url;
      if (url && RESOURCE_URL.test(String(url)))
        res
          .clone()
          .text()
          .then(scanText)
          .catch((e) => warn("prime: could not read a resources response", e));
      if (url && (/\.mpd|manifest|dash/i.test(String(url)) || looksXml(res)))
        res
          .clone()
          .text()
          .then((t) => noteMpd(url, t))
          .catch((e) => warn("prime: could not read a manifest response", e));
    } catch (e) {
      warn("prime: fetch hook failed", e);
    }
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
        if (this.__ylrUrl && RESOURCE_URL.test(String(this.__ylrUrl)))
          scanText(this.responseText);
        if (this.__ylrUrl) noteMpd(this.__ylrUrl, this.responseText);
      } catch (e) {
        warn("prime: XHR hook failed", e);
      }
    });
    return xhrSend.apply(this, arguments);
  };

  // Prime's <video> is a normal MSE element and accepts currentTime, but the
  // player's own UI only notices when its SDK does the seek, so try that first.
  function seek(seconds) {
    try {
      const sdk = window.PlayerSDK || (window.playerSDK && window.playerSDK.default);
      const players =
        sdk && sdk.getPlayers ? sdk.getPlayers() : window.__ylrPlayers || null;
      if (players && players.length && players[0].seekTo) {
        players[0].seekTo(seconds * 1000);
        return;
      }
    } catch (e) {
      warn("prime: player SDK seek unavailable", e);
    }
    const v = document.querySelector("video");
    if (v) {
      try {
        v.currentTime = seconds;
      } catch (e) {
        console.log("[YLR] Prime seek failed:", e && e.message);
      }
    }
  }

  window.addEventListener("message", (ev) => {
    if (ev.source !== window || !ev.data || ev.data.source !== "YLR-CS") return;
    if (ev.data.type === "PV_REQUEST_TRACKS") {
      post();
      postMpd();
    }
    else if (ev.data.type === "PV_SEEK") seek(ev.data.seconds);
  });
})();
