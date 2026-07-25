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

  // ---- audio segments straight off MediaSource ----
  // The one delivery-agnostic tap: however YouTube fetches media (progressive,
  // DASH, SABR/UMP over POST), the player must hand plain fMP4/WebM audio to
  // appendBuffer. We keep a copy of the init segment plus every media segment,
  // tagged with the presentation range it added, so any line the player has
  // downloaded can be re-cut later — no stream URL, no signature, no throttling.
  const AUDIO_STORE_LIMIT = 64 * 1024 * 1024; // compressed audio: ~1 MB/minute
  const audioStore = { mime: "", init: null, segs: [], bytes: 0, videoId: null };
  const audioSBs = new WeakMap();

  function resetAudioStore() {
    audioStore.init = null;
    audioStore.segs = [];
    audioStore.bytes = 0;
    audioStore.videoId = currentVideoId();
  }

  function looksLikeInit(b) {
    if (b.length > 8 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70)
      return true; // ISO-BMFF 'ftyp'
    return b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3; // EBML
  }

  function bufferedRanges(sb) {
    const out = [];
    try {
      const b = sb.buffered;
      for (let i = 0; i < b.length; i++) out.push([b.start(i), b.end(i)]);
    } catch (e) {}
    return out;
  }

  // The presentation range an append added = whatever `buffered` gained.
  function addedRange(before, after) {
    let start = Infinity;
    let end = -Infinity;
    for (const [s, e] of after) {
      let pieces = [[s, e]];
      for (const [bs, be] of before) {
        const next = [];
        for (const [ps, pe] of pieces) {
          if (be <= ps || bs >= pe) {
            next.push([ps, pe]);
            continue;
          }
          if (bs > ps) next.push([ps, bs]);
          if (be < pe) next.push([be, pe]);
        }
        pieces = next;
      }
      for (const [ps, pe] of pieces) {
        if (pe - ps <= 0.01) continue;
        if (ps < start) start = ps;
        if (pe > end) end = pe;
      }
    }
    return start === Infinity ? null : { start, end };
  }

  function trimAudioStore() {
    while (audioStore.bytes > AUDIO_STORE_LIMIT && audioStore.segs.length > 1) {
      audioStore.bytes -= audioStore.segs.shift().bytes.length;
    }
  }

  function captureAppend(sb, data) {
    let bytes;
    try {
      bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data.slice(0))
          : new Uint8Array(
              data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
            );
    } catch (e) {
      return;
    }
    if (!bytes.length) return;
    if (looksLikeInit(bytes)) {
      audioStore.init = bytes;
      audioStore.mime = audioSBs.get(sb) || audioStore.mime;
      audioStore.videoId = currentVideoId();
      console.log("[YLR] audio init segment captured:", bytes.length, "bytes", audioStore.mime);
      return;
    }
    const before = bufferedRanges(sb);
    const onDone = () => {
      sb.removeEventListener("updateend", onDone);
      const r = addedRange(before, bufferedRanges(sb));
      if (!r) return;
      // Seeking makes the player re-append ranges it already sent; keep one copy
      // per position so a concatenated stream never repeats or overlaps itself.
      const dupe = audioStore.segs.findIndex((s) => Math.abs(s.start - r.start) < 0.05);
      if (dupe >= 0) {
        audioStore.bytes -= audioStore.segs[dupe].bytes.length;
        audioStore.segs.splice(dupe, 1);
      }
      audioStore.segs.push({ start: r.start, end: r.end, bytes });
      audioStore.bytes += bytes.length;
      audioStore.segs.sort((a, b) => a.start - b.start);
      trimAudioStore();
      if (audioStore.segs.length % 25 === 1)
        console.log(
          "[YLR] audio segments held:",
          audioStore.segs.length,
          "(" + (audioStore.bytes / 1048576).toFixed(1) + " MB) covering",
          audioStore.segs[0].start.toFixed(1) + "→" +
            audioStore.segs[audioStore.segs.length - 1].end.toFixed(1) + "s"
        );
    };
    sb.addEventListener("updateend", onDone);
  }

  if (window.MediaSource && window.SourceBuffer) {
    const addSourceBuffer = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function (mime) {
      const sb = addSourceBuffer.apply(this, arguments);
      if (String(mime).toLowerCase().startsWith("audio")) {
        audioSBs.set(sb, String(mime));
        // A fresh source buffer means a fresh stream — this, not the navigation
        // event, is the real boundary. The init segment is appended once per
        // source buffer, so anything that clears it later loses it for good.
        resetAudioStore();
        audioStore.mime = String(mime);
        console.log("[YLR] hooked audio source buffer:", mime);
      }
      return sb;
    };
    const appendBuffer = SourceBuffer.prototype.appendBuffer;
    SourceBuffer.prototype.appendBuffer = function (data) {
      if (audioSBs.has(this)) {
        try {
          captureAppend(this, data);
        } catch (e) {
          console.log("[YLR] segment capture failed:", e.message);
        }
      }
      return appendBuffer.apply(this, arguments);
    };
  }

  // Hands back init + every segment overlapping [start,end] as one buffer, plus
  // the presentation time the first included segment starts at.
  function sendAudioSegments(start, end) {
    const fail = (reason) =>
      window.postMessage(
        { source: "YLR", type: "AUDIO_SEGMENTS", ok: false, reason, videoId: currentVideoId() },
        "*"
      );
    if (!audioStore.init) return fail("no audio init segment seen yet — let the video play a moment");
    const overlap = audioStore.segs.filter((s) => s.end > start && s.start < end);
    // Only a gapless run can be concatenated — a hole would shift every sample
    // after it, so the clip would be cut from the wrong place.
    const hit = [];
    for (const s of overlap) {
      if (hit.length && s.start - hit[hit.length - 1].end > 0.2) break;
      hit.push(s);
    }
    if (!hit.length) {
      const have = audioStore.segs.length
        ? audioStore.segs[0].start.toFixed(1) +
          "→" +
          audioStore.segs[audioStore.segs.length - 1].end.toFixed(1) +
          "s"
        : "nothing";
      return fail(
        "that range hasn't been downloaded by the player (buffer holds " + have + ")"
      );
    }
    let total = audioStore.init.length;
    for (const s of hit) total += s.bytes.length;
    const out = new Uint8Array(total);
    out.set(audioStore.init, 0);
    let o = audioStore.init.length;
    for (const s of hit) {
      out.set(s.bytes, o);
      o += s.bytes.length;
    }
    console.log(
      "[YLR] serving",
      hit.length,
      "audio segments,",
      (total / 1024).toFixed(0) + " KB, t0",
      hit[0].start.toFixed(2)
    );
    window.postMessage(
      {
        source: "YLR",
        type: "AUDIO_SEGMENTS",
        ok: true,
        mime: audioStore.mime,
        t0: hit[0].start,
        buffer: out.buffer,
        videoId: currentVideoId()
      },
      "*",
      [out.buffer]
    );
  }

  // ---- audio-only stream, for extracting clips the ring buffer never heard ----

  let mediaUrl = null; // { url, mime, videoId, from }

  // The player's own DASH requests carry fully signed, un-throttled URLs, so a
  // captured one is the best source. Range/segment params are stripped so the
  // URL serves the whole track; ump/sabr would wrap the bytes in a container
  // protocol an <audio> element can't read.
  function noteMediaUrl(rawUrl) {
    if (!rawUrl || String(rawUrl).indexOf("videoplayback") === -1) return;
    const vid = currentVideoId();
    if (mediaUrl && mediaUrl.videoId === vid) return;
    let u;
    try {
      u = new URL(rawUrl, location.origin);
    } catch (e) {
      return;
    }
    const mime = decodeURIComponent(u.searchParams.get("mime") || "");
    if (!mime.startsWith("audio")) return;
    for (const p of ["range", "rn", "rbuf", "ump", "sabr", "alr", "srfvp"])
      u.searchParams.delete(p);
    mediaUrl = { url: u.toString(), mime, videoId: vid, from: "player request" };
    console.log("[YLR] captured audio stream:", mime, "itag", u.searchParams.get("itag"));
  }

  // Fallback: the player response lists adaptive formats. Only usable when the
  // entry has a plain `url` (a `signatureCipher` needs the player JS to solve).
  function mediaUrlFromPlayerResponse() {
    const mp = player();
    let resp = null;
    try {
      resp = mp && mp.getPlayerResponse ? mp.getPlayerResponse() : null;
    } catch (e) {}
    const formats = (resp && resp.streamingData && resp.streamingData.adaptiveFormats) || [];
    const audio = formats
      .filter((f) => (f.mimeType || "").startsWith("audio/") && f.url)
      .sort((a, b) => (a.bitrate || 0) - (b.bitrate || 0));
    if (!audio.length) return null;
    console.log("[YLR] audio stream from player response: itag", audio[0].itag);
    return {
      url: audio[0].url,
      mime: audio[0].mimeType,
      videoId: currentVideoId(),
      from: "player response"
    };
  }

  function currentMediaUrl() {
    const vid = currentVideoId();
    if (mediaUrl && mediaUrl.videoId === vid) return mediaUrl;
    return mediaUrlFromPlayerResponse();
  }

  function sendAudioSource() {
    const src = currentMediaUrl();
    if (!src) console.log("[YLR] no audio-only stream URL available yet");
    window.postMessage(
      {
        source: "YLR",
        type: "AUDIO_SOURCE",
        ok: !!src,
        url: src ? src.url : null,
        mime: src ? src.mime : null,
        from: src ? src.from : null,
        videoId: currentVideoId(),
        reason: src ? null : "no audio-only stream URL available for this video"
      },
      "*"
    );
  }

  // Same-origin-privileged fetch of the whole track, for when the <audio>
  // element can't load the URL itself (CORS). Bytes are transferred, not copied.
  async function sendAudioBytes() {
    const src = currentMediaUrl();
    const fail = (reason) =>
      window.postMessage(
        { source: "YLR", type: "AUDIO_BYTES", ok: false, reason, videoId: currentVideoId() },
        "*"
      );
    if (!src) return fail("no audio-only stream URL available for this video");
    try {
      // No credentials: googlevideo allows the origin but not credentialed CORS.
      const res = await originalFetch(src.url, { credentials: "omit" });
      if (!res.ok) return fail("audio stream fetch returned HTTP " + res.status);
      const buf = await res.arrayBuffer();
      console.log("[YLR] fetched audio track:", (buf.byteLength / 1048576).toFixed(1), "MB");
      window.postMessage(
        {
          source: "YLR",
          type: "AUDIO_BYTES",
          ok: true,
          mime: src.mime,
          buffer: buf,
          videoId: currentVideoId()
        },
        "*",
        [buf]
      );
    } catch (e) {
      fail("audio stream fetch failed: " + e.message);
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
      noteMediaUrl(url);
    } catch (e) {}
    return response;
  };

  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ylrUrl = url;
    noteMediaUrl(url);
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
    } else if (d.type === "REQUEST_AUDIO_SEGMENTS") {
      sendAudioSegments(d.start, d.end);
    } else if (d.type === "REQUEST_AUDIO_SOURCE") {
      sendAudioSource();
    } else if (d.type === "REQUEST_AUDIO_BYTES") {
      sendAudioBytes();
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
    mediaUrl = null;
    // Only drop captured audio if this really is a different video — the event
    // also fires for the page we are already on.
    if (audioStore.videoId && audioStore.videoId !== currentVideoId()) resetAudioStore();
    pollTracks();
  });
})();
