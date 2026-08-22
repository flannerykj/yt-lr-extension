// Netflix MAIN world. Netflix delivers subtitle track URLs inside its player
// manifest, which the page fetches and parses. We hook JSON.parse to grab that
// manifest, extract the WebVTT tracks, and post them to the content script. Also
// handles seeking through Netflix's player API.
(function () {
  console.log("[YLR] netflix-inject loaded");
  const origParse = JSON.parse;
  const originalFetch = window.fetch;
  // Netflix prefetches the NEXT episode's manifest a few minutes before the
  // current one ends, so manifests are kept per movieId and only the one for the
  // video actually on screen is published. A single last-write-wins cache would
  // swap the sidebar over to the next episode's subtitles mid-scene.
  const manifests = new Map(); // movieId -> { tracks, audio, mediaId, title }
  let latest = null;
  let currentMovieId = "";

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

  // The same manifest lists the audio streams. Netflix ships audio unencrypted
  // alongside Widevine video, so these are fetchable and decodable directly —
  // no tab capture, no replay.
  function collectAudio(m) {
    const list = m.audio_tracks || m.audioTracks;
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const t of list) {
      const streams = [];
      for (const s of t.streams || t.downloadables || []) {
        const url = urlFrom(s.urls || s.downloadUrls || s.downloadUrl || s.url);
        if (!url) continue;
        streams.push({
          url,
          profile: s.content_profile || s.contentProfile || "",
          bitrate: s.bitrate || 0,
          size: s.size || 0
        });
      }
      if (!streams.length) continue;
      out.push({
        language: t.language,
        name: t.languageDescription || t.language,
        trackType: t.trackType || t.rawTrackType || "",
        channels: t.channels || "",
        streams
      });
    }
    return out;
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
    const audio = collectAudio(m);
    console.log(
      "[YLR] Netflix audio tracks:",
      audio.map((a) => a.language + "/" + a.streams.length + " streams").join(", ") || "(none)"
    );
    const id = String(m.movieId);
    const entry = { tracks, audio, mediaId: id, title: bestTitle(m.movieId) };
    manifests.set(id, entry);
    latest = entry;
    console.log(
      "[YLR] Netflix manifest for",
      id,
      currentMovieId && id !== currentMovieId ? "(NOT the video playing — held back)" : "",
      "title",
      JSON.stringify(entry.title),
      "| tracks:",
      tracks.map((t) => t.languageCode + (t.isForced ? "(forced)" : "")).join(", ")
    );
    refineTitle(m.movieId, 0);
    post();
  }

  // document.title on the player page is just "Netflix", so the show, season and
  // episode have to come from the player's own metadata — which only the MAIN
  // world can reach.
  function pad(n) {
    return String(Number(n)).padStart(2, "0");
  }

  let metadataLogged = false;

  function videoMetadata(movieId) {
    try {
      const app = window.netflix.appContext.state.playerApp;
      const state = app.getState ? app.getState() : app.getAPI().getState();
      const all = state && state.videoPlayer && state.videoPlayer.videoMetadata;
      if (!all) {
        if (!metadataLogged) {
          metadataLogged = true;
          console.log(
            "[YLR] no videoPlayer.videoMetadata; playerApp state keys:",
            state ? Object.keys(state).join(",") : "(no state)",
            "| videoPlayer keys:",
            state && state.videoPlayer ? Object.keys(state.videoPlayer).join(",") : "-"
          );
        }
        return null;
      }
      const entry = all[String(movieId)] || all[Object.keys(all)[0]];
      const video = (entry && entry._metadata && entry._metadata.video) || null;
      if (!video && !metadataLogged) {
        metadataLogged = true;
        console.log(
          "[YLR] videoMetadata has no _metadata.video; ids:",
          Object.keys(all).join(","),
          "| entry keys:",
          entry ? Object.keys(entry).join(",") : "-"
        );
      }
      return video;
    } catch (e) {
      if (!metadataLogged) {
        metadataLogged = true;
        console.log("[YLR] videoMetadata unreachable:", e.message);
      }
      return null;
    }
  }

  function titleFromMetadata(movieId) {
    const video = videoMetadata(movieId);
    if (!video) return "";
    const show = video.title || "";
    if (!Array.isArray(video.seasons) || video.currentEpisode == null) return show;
    for (const season of video.seasons) {
      for (const episode of season.episodes || []) {
        if (String(episode.id) !== String(video.currentEpisode)) continue;
        const parts = [show];
        if (episode.seq != null)
          parts.push(
            (season.seq != null ? "S" + pad(season.seq) : "") + "E" + pad(episode.seq)
          );
        if (episode.title && episode.title !== show) parts.push(episode.title);
        return parts.filter(Boolean).join(" - ");
      }
    }
    return show;
  }

  function bestTitle(movieId) {
    return titleFromMetadata(movieId) || document.title.replace(/ - Netflix$/, "").trim();
  }

  const HAS_EPISODE = /\bS\d+\s*[:x·-]?\s*E\d+\b/i;

  // The manifest often lands before the player has its metadata, so keep looking
  // for a little while and re-post once the real name shows up.
  // videoMetadata is empty when the manifest lands — Netflix fills it in once the
  // player is up, which can take a while — so keep looking for a minute rather
  // than giving up after a few seconds.
  function refineTitle(movieId, attempt) {
    const entry = manifests.get(String(movieId));
    if (!entry || attempt > 40 || HAS_EPISODE.test(entry.title)) return;
    setTimeout(() => {
      const better = bestTitle(movieId);
      if (better && better !== entry.title && better !== "Netflix") {
        entry.title = better;
        console.log("[YLR] Netflix title:", JSON.stringify(better));
        post();
      }
      refineTitle(movieId, attempt + 1);
    }, 1500);
  }

  // Which movie is on screen, straight from the player when it will say.
  function playingMovieId() {
    try {
      const api = window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
      const ids = api.getAllPlayerSessionIds();
      const sid = ids.find((i) => String(i).indexOf("watch") !== -1) || ids[0];
      const player = api.getVideoPlayerBySessionId(sid);
      const id = player && player.getMovieId && player.getMovieId();
      return id ? String(id) : "";
    } catch (e) {
      return "";
    }
  }

  // Backup for the same question: the playback heartbeat names the movie it is
  // reporting progress for.
  function noteHeartbeat(id) {
    if (!id || id === currentMovieId) return;
    currentMovieId = id;
    console.log(
      "[YLR] now playing movieId",
      id,
      manifests.has(id) ? "(manifest known)" : "(waiting for its manifest)"
    );
    post();
  }

  function post() {
    const playing = playingMovieId() || currentMovieId;
    if (playing) currentMovieId = playing;
    let entry;
    if (playing && manifests.has(playing)) entry = manifests.get(playing);
    else if (!playing) entry = latest; // nothing has told us yet; best guess
    if (!entry) return;
    window.postMessage(Object.assign({ source: "YLR", type: "NF_TRACKS" }, entry), "*");
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
      // A playback heartbeat: movieId plus a position and a session. This is
      // the video on screen, as opposed to one being prefetched.
      if (node.position != null && (node.sessionId || node.xid)) {
        noteHeartbeat(String(node.movieId));
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
    try {
      scanDeep(origParse(text), 0);
    } catch (e) {
      console.log("[YLR] manifest parse failed:", e);
    }
  }

  JSON.parse = function (text) {
    const data = origParse.apply(this, arguments);
    try {
      // Netflix parses a playback heartbeat every few seconds, and each one looks
      // manifest-shaped. Scan them (that's how we learn what's playing) but stay
      // quiet — scanDeep speaks up when it actually finds something.
      if (looksLikeManifest(text)) scanDeep(data, 0);
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
    else if (d.type === "NF_REFRESH_TITLE") {
      const id = playingMovieId() || currentMovieId;
      const entry = id && manifests.get(id);
      if (!entry) return;
      const better = bestTitle(id);
      if (better && better !== entry.title && better !== "Netflix") {
        entry.title = better;
        console.log("[YLR] Netflix title:", JSON.stringify(better));
      }
      post();
    }
    else if (d.type === "NF_SEEK") seek(d.seconds);
  });
})();
