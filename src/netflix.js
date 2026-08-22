// Netflix adapter. Tracks come from netflix-inject.js (manifest interception);
// subtitles are fetched directly (WebVTT, not DRM'd); audio is captured from the
// tab's output via chrome.tabCapture (DRM blocks the element tap).
(function () {
  const NS = (window.YLR = window.YLR || {});
  let handlers = null;
  let tracks = [];
  let mediaId = null;
  let captureStream = null;
  let audioTracks = [];
  let selectedLang = "";
  const indexCache = new Map(); // stream url -> { init, entries }

  function getVideo() {
    return document.querySelector("video");
  }

  function idFromUrl() {
    const m = location.pathname.match(/\/watch\/(\d+)/);
    return m ? m[1] : null;
  }

  const EPISODE_MARK = /\bS\d+\s*[:x\u00b7-]?\s*E\d+\b/i;

  // "S1:E3" and "S01E03" both land on "S01E03" — padding to a width, not
  // prepending a zero, so an already-padded title isn't padded again.
  function pad(n) {
    return String(Number(n)).padStart(2, "0");
  }

  function normalizeEpisode(text) {
    return text.replace(
      /\bS(\d+)\s*[:x\u00b7-]?\s*E(\d+)\b/i,
      (m, se, ep) => "S" + pad(se) + "E" + pad(ep)
    );
  }

  // The player's title bar reads "Series / S1:E3 / Episode title" — a fallback
  // for when the player metadata isn't reachable, and it isn't mounted until the
  // player UI paints, hence the retries.
  function domTitle() {
    const box = document.querySelector(
      '[data-uia="video-title"], .video-title, .watch-video--title-bar, [class*="title-card-title"]'
    );
    if (!box) return "";
    const head = box.querySelector("h4");
    const rest = Array.prototype.slice
      .call(box.querySelectorAll("span"))
      .map((el) => (el.textContent || "").trim());
    const parts = [head ? (head.textContent || "").trim() : ""]
      .concat(rest)
      .filter(Boolean);
    return normalizeEpisode(parts.join(" - "));
  }

  function bestTitle(fromInjector) {
    const given = normalizeEpisode((fromInjector || "").trim());
    if (EPISODE_MARK.test(given)) return given;
    const dom = domTitle();
    if (dom && EPISODE_MARK.test(dom)) return dom;
    if (given && given !== "Netflix") return given;
    return dom || given || document.title;
  }

  function announceTracks(payload, attempt) {
    const title = bestTitle(payload.title);
    handlers.onTracks({ tracks, mediaId, title });
    retryTitle(payload, title, attempt);
  }

  function retryTitle(payload, current, attempt) {
    if (EPISODE_MARK.test(current) || attempt >= 40) return;
    setTimeout(() => {
      if (mediaId !== payload.mediaId) return; // moved on to another title
      const better = bestTitle(payload.title);
      if (better !== current) announceTracks(payload, attempt + 1);
      else retryTitle(payload, current, attempt + 1);
    }, 1200);
  }

  function onMessage(ev) {
    if (ev.source !== window || ev.data?.source !== "YLR") return;
    if (ev.data.type === "NF_TRACKS") {
      tracks = ev.data.tracks || [];
      if (ev.data.mediaId !== mediaId) indexCache.clear();
      audioTracks = ev.data.audio || [];
      mediaId = ev.data.mediaId;
      announceTracks(ev.data, 0);
    }
  }

  async function fetchTranslation(sourceTrack) {
    const src = (sourceTrack.languageCode || "").toLowerCase();
    if (src.startsWith("en")) return; // source already English
    const en =
      tracks.find((t) => (t.languageCode || "").toLowerCase().startsWith("en") && !t.isForced) ||
      tracks.find((t) => (t.languageCode || "").toLowerCase().startsWith("en"));
    if (!en) return;
    try {
      const res = await fetch(en.url);
      if (!res.ok) return;
      const body = await res.text();
      const cues = en.format === "ttml" ? NS.parseTTML(body) : NS.parseWebVTT(body);
      handlers.onTranslation({ mediaId, lang: sourceTrack.languageCode, cues });
    } catch (e) {}
  }

  // ---- direct audio fetch ----

  // Prefer the audio you're most likely studying (same language as the chosen
  // subtitles), then the original-language track. Within a track take the
  // lowest-bitrate AAC: the smallest download, and the codec decodeAudioData
  // handles most reliably.
  function pickStream() {
    if (!audioTracks.length)
      throw new Error("the player manifest listed no audio streams");
    const want = (selectedLang || "").toLowerCase().slice(0, 2);
    const track =
      (want && audioTracks.find((t) => (t.language || "").toLowerCase().startsWith(want))) ||
      audioTracks.find((t) => /primary/i.test(t.trackType)) ||
      audioTracks[0];
    const aac = track.streams.filter((s) => /aac|mp4a/i.test(s.profile));
    const pool = aac.length ? aac : track.streams;
    const stream = pool.slice().sort((a, b) => (a.bitrate || 1e9) - (b.bitrate || 1e9))[0];
    console.log(
      "[YLR] audio stream:",
      track.language,
      stream.profile || "(profile unknown)",
      (stream.bitrate || "?") + "kbps"
    );
    if (!aac.length)
      console.log(
        "[YLR] note: no AAC stream for this track — " +
          (stream.profile || "unknown codec") +
          " may not decode in the browser"
      );
    return stream;
  }

  function base64ToBuffer(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  // Netflix's OCA URLs carry the byte range in the path; other deliveries want a
  // Range header. Try both, then hand it to the service worker, which isn't
  // bound by the page's CORS rules.
  async function fetchRange(url, from, to) {
    const path = url.replace(/\/range\/\d+-\d+/, "/range/" + from + "-" + to);
    if (path !== url) {
      try {
        const res = await fetch(path);
        if (res.ok) return await res.arrayBuffer();
      } catch (e) {}
    }
    try {
      const res = await fetch(url, { headers: { Range: "bytes=" + from + "-" + to } });
      // A 200 here means the range was ignored and the whole file is coming.
      if (res.status === 206) return await res.arrayBuffer();
    } catch (e) {}
    const reply = await chrome.runtime.sendMessage({
      type: "YLR_FETCH_BYTES",
      url,
      from,
      to
    });
    if (reply && reply.ok) return base64ToBuffer(reply.body);
    throw new Error(
      "could not fetch audio bytes " + from + "-" + to + ": " + ((reply && reply.error) || "no response")
    );
  }

  async function ensureIndex(stream) {
    if (indexCache.has(stream.url)) return indexCache.get(stream.url);
    let head = await fetchRange(stream.url, 0, 65535);
    let list = NS.mp4.boxes(head);
    let sidx = NS.mp4.findBox(list, "sidx");
    if (sidx && sidx.truncated) {
      head = await fetchRange(stream.url, 0, sidx.end + 65536);
      list = NS.mp4.boxes(head);
      sidx = NS.mp4.findBox(list, "sidx");
    }
    if (!sidx || sidx.truncated) {
      // Not the fragmented layout we expect. Name what did come back — a plain
      // (non-fragmented) MP4 shows stbl/stco instead, and needs a different index.
      const shape = list.map((b) => b.type + (b.truncated ? "…" : "")).join(" ") || "(no boxes)";
      console.log("[YLR] audio head is not fragmented; boxes:", shape, "| first bytes:",
        Array.from(new Uint8Array(head.slice(0, 16))).map((b) => b.toString(16).padStart(2, "0")).join(" "));
      throw new Error("no segment index (sidx) in the audio stream — saw: " + shape);
    }
    const initLength = NS.mp4.initLength(list);
    const encrypted = NS.mp4.looksEncrypted(head.slice(0, initLength || head.byteLength));
    if (encrypted)
      throw new Error("this audio track is encrypted (" + encrypted + " box present)");
    const entries = NS.mp4.parseSidx(head, sidx);
    if (!entries) throw new Error("could not read the audio segment index");
    const index = { init: head.slice(0, initLength), entries };
    console.log(
      "[YLR] audio index:",
      entries.length,
      "subsegments covering",
      entries[entries.length - 1].end.toFixed(0) + "s | init",
      initLength,
      "bytes"
    );
    indexCache.set(stream.url, index);
    return index;
  }

  // core's ClipExtractor contract: the bytes for [start,end] plus the
  // presentation time the returned buffer actually begins at.
  async function audioSegments(start, end) {
    const stream = pickStream();
    const index = await ensureIndex(stream);
    const range = NS.mp4.rangeFor(index.entries, start, end);
    if (!range)
      throw new Error("no audio segments cover " + start.toFixed(1) + "-" + end.toFixed(1) + "s");
    const bytes = await fetchRange(stream.url, range.byteStart, range.byteEnd);

    // If the CDN served something other than the fragments we asked for, say so
    // here rather than letting it surface as "unable to decode audio data".
    const head = NS.mp4.boxes(bytes)[0];
    if (!head || (head.type !== "moof" && head.type !== "mdat"))
      throw new Error(
        "audio byte range came back as " +
          (head ? "a '" + head.type + "' box" : "unrecognised data") +
          " — expected a fragment"
      );

    const fmp4 = NS.mp4.concat(index.init, bytes);
    // decodeAudioData rejects fragmented MP4, so hand it plain ADTS AAC and keep
    // the original as a fallback for anything this remux can't handle.
    const adts = NS.mp4.toADTS(index.init, bytes);
    console.log(
      "[YLR] clip bytes:",
      bytes.byteLength,
      "| codec",
      adts.codec || "unknown",
      adts.buffer
        ? "| " + adts.frames + " AAC frames -> " + adts.buffer.byteLength + " bytes ADTS"
        : "| no remux (" + adts.reason + "), sending fragmented MP4"
    );
    return {
      buffer: adts.buffer || fmp4,
      fallbackBuffer: adts.buffer ? fmp4 : null,
      t0: range.t0
    };
  }

  // Netflix is a single-page app; watch for URL changes.
  function patchHistory(cb) {
    const fire = () => setTimeout(cb, 0);
    for (const m of ["pushState", "replaceState"]) {
      const orig = history[m];
      history[m] = function () {
        const r = orig.apply(this, arguments);
        fire();
        return r;
      };
    }
    window.addEventListener("popstate", fire);
  }

  // The background worker sends a tabCapture streamId after the toolbar-icon
  // click; turn it into a MediaStream and hand it to core to start recording.
  function setupCaptureBridge() {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || msg.type !== "ENABLE_CAPTURE") return;
      if (!msg.streamId) {
        console.log("[YLR] ENABLE_CAPTURE error:", msg.error);
        alert("Audio capture couldn't start: " + (msg.error || "unknown error"));
        return;
      }
      console.log("[YLR] ENABLE_CAPTURE received (streamId len " + String(msg.streamId).length + "); calling getUserMedia…");
      navigator.mediaDevices
        .getUserMedia({
          audio: {
            mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: msg.streamId }
          },
          video: false
        })
        .then((stream) => {
          const at = stream.getAudioTracks()[0];
          console.log(
            "[YLR] getUserMedia(tab) OK — track:",
            at && JSON.stringify(at.label),
            "| muted:",
            at && at.muted,
            "| state:",
            at && at.readyState
          );
          captureStream = stream;
          if (handlers && handlers.onCaptureStream) handlers.onCaptureStream(stream);
        })
        .catch((e) => {
          console.log("[YLR] getUserMedia(tab) FAILED:", e.name, "-", e.message);
          alert("Audio capture failed (" + e.name + "): " + e.message);
        });
    });
  }

  NS.adapter = {
    name: "netflix",
    isWatchPage() {
      return location.pathname.startsWith("/watch/");
    },
    currentMediaId: idFromUrl,
    getVideo,
    seek(seconds) {
      const v = getVideo();
      console.log(
        "[YLR] seek→",
        seconds.toFixed(2),
        "s | video.currentTime now",
        v ? v.currentTime.toFixed(2) : "?"
      );
      // Only via the player API — setting video.currentTime directly on
      // Netflix's DRM/MSE element throws it into an error page.
      window.postMessage({ source: "YLR-CS", type: "NF_SEEK", seconds }, "*");
    },
    defaultTrack(ts) {
      return ts.find((t) => !t.isForced) || ts[0];
    },
    trackLabel(t) {
      return t.name + (t.isForced ? " (forced)" : "");
    },
    clipUrl() {
      return "https://www.netflix.com/watch/" + (idFromUrl() || "");
    },
    onNavigate(cb) {
      patchHistory(cb);
    },
    init(h) {
      handlers = h;
      window.addEventListener("message", onMessage);
      setupCaptureBridge();
    },
    requestTracks() {
      window.postMessage({ source: "YLR-CS", type: "NF_REQUEST_TRACKS" }, "*");
    },
    audioSegments,
    // Asked for at download time: by then the player has been running long
    // enough that the metadata and the title bar are both there.
    currentTitle() {
      window.postMessage({ source: "YLR-CS", type: "NF_REFRESH_TITLE" }, "*");
      return domTitle();
    },
    async loadTrack(track) {
      selectedLang = track.languageCode || "";
      const res = await fetch(track.url);
      if (!res.ok) throw new Error("subtitle fetch HTTP " + res.status);
      const body = await res.text();
      const segments =
        track.format === "ttml" ? NS.parseTTML(body) : NS.parseWebVTT(body);
      fetchTranslation(track);
      return segments;
    },
    async setupAudio(capture) {
      // Drop a dead stream from a previous attempt.
      if (captureStream) {
        const t = captureStream.getAudioTracks()[0];
        if (!t || t.readyState === "ended") captureStream = null;
      }
      if (!captureStream) {
        throw new Error(
          "Audio capture isn't on. Click this extension's icon in the Chrome toolbar " +
            "once to enable it for this tab, then star again."
        );
      }
      await capture.ensureFromStream(captureStream);
    },
    audioEnabled() {
      const t = captureStream && captureStream.getAudioTracks()[0];
      return !!(t && t.readyState === "live");
    },
    resetAudio() {
      if (captureStream) captureStream.getTracks().forEach((t) => t.stop());
      captureStream = null;
    }
  };
})();
