// Netflix adapter. Tracks come from netflix-inject.js (manifest interception);
// subtitles are fetched directly (WebVTT/TTML, not DRM'd), and so is the audio —
// Netflix ships that unencrypted, so clips are fetched and decoded rather than
// recorded.
(function () {
  const NS = (window.YLR = window.YLR || {});
  let handlers = null;
  let tracks = [];
  let mediaId = null;
  let audioTracks = [];
  let selectedLang = "";
  const indexCache = new Map(); // stream url -> { init, entries }
  let probe = { probed: false, ok: false, reason: "" };
  let chosen = null; // { stream, index, config } — the stream we can actually decode
  let audioTrackId = ""; // the dub the player says it is playing
  let lastTitleSources = null;

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
      '[data-uia="video-title"], .video-title, .watch-video--title-bar, ' +
        '[data-uia="player-title"], [class*="videoTitle"], [class*="title-card-title"]'
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

  const EPISODE_ONLY = /(^|[\s\-\u2013])E(\d+)\b/i;

  // "Show - E06 - Name" means the metadata knew the episode but not its season.
  // The player's title bar usually does, so borrow the number from there rather
  // than shipping a filename that can't be told apart from another season's.
  function withSeason(title) {
    if (EPISODE_MARK.test(title) || !EPISODE_ONLY.test(title)) return title;
    const season = domTitle().match(/\bS(?:eason|erie|eries|T|Temporada)?\s*[:.]?\s*(\d+)/i);
    if (!season) return title;
    return title.replace(
      EPISODE_ONLY,
      (all, before, ep) => before + "S" + pad(season[1]) + "E" + pad(ep)
    );
  }

  const JUNK_TITLE = /^(netflix|home|browse|my list|watch|new & popular|)$/i;

  function usable(title) {
    const t = String(title || "").replace(/ - Netflix$/, "").trim();
    return JUNK_TITLE.test(t) ? "" : t;
  }

  // Best available, and "" rather than a placeholder when there is nothing —
  // core keeps the last good title instead of overwriting it with page chrome.
  function bestTitle(fromInjector) {
    const given = usable(withSeason(normalizeEpisode(String(fromInjector || "").trim())));
    if (EPISODE_MARK.test(given)) return given;
    const dom = usable(domTitle());
    if (EPISODE_MARK.test(dom)) return dom;
    // Neither names an episode; prefer whichever says more.
    if (given && dom) return dom.length > given.length ? dom : given;
    return given || dom;
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
      if (ev.data.titleSources) lastTitleSources = ev.data.titleSources;
      if (ev.data.mediaId !== mediaId) {
        indexCache.clear();
        chosen = null;
        probe = { probed: false, ok: false, reason: "" };
      }
      const nextAudioId = ev.data.audioTrackId || "";
      if (nextAudioId !== audioTrackId) {
        audioTrackId = nextAudioId;
        // Switching dub mid-playback means the chosen stream is now the wrong
        // one, so let it be picked again.
        chosen = null;
        probe = { probed: false, ok: false, reason: "" };
      }
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
      if (!res.ok) throw new Error("HTTP " + res.status);
      const body = await res.text();
      const cues = en.format === "ttml" ? NS.parseTTML(body) : NS.parseWebVTT(body);
      if (!cues.length) throw new Error("parsed to zero cues");
      handlers.onTranslation({ mediaId, lang: sourceTrack.languageCode, cues });
    } catch (e) {
      NS.warn("netflix: no translation track — hover will show nothing", e);
    }
  }

  // ---- direct audio fetch ----

  // Prefer the audio you're most likely studying (same language as the chosen
  // subtitles), then the original-language track. Within a track take the
  // lowest-bitrate AAC: the smallest download, and the codec decodeAudioData
  // handles most reliably.
  // Netflix offers several codecs per language. xHE-AAC is usually the
  // lowest-bitrate one, which made it the naive first pick — but the browser
  // can't decode it here, so plain AAC has to win regardless of size.
  function streamScore(stream) {
    const p = (stream.profile || "").toLowerCase();
    if (/xhe/.test(p)) return 3; // must be tested before the heaac match below
    if (/ddplus|eac-?3|ac-?3|atmos|dts/.test(p)) return 2;
    if (/heaac|aac|mp4a/.test(p)) return 0;
    return 1;
  }

  // A title can carry several audio tracks for one language — a Castilian and a
  // Latin American dub, a descriptive-audio variant. Language alone would pick
  // whichever came first, which is a coin flip; the player tells us which one is
  // actually playing, so match on that when we have it.
  function pickTrack() {
    if (!audioTracks.length)
      throw new Error("the player manifest listed no audio streams");
    if (audioTrackId) {
      const exact = audioTracks.find(
        (t) => t.ids && t.ids.indexOf(audioTrackId) !== -1
      );
      if (exact) return { track: exact, why: "matched the playing audio track" };
      console.log(
        "[YLR] audio track",
        audioTrackId,
        "matched none of",
        audioTracks.map((t) => (t.ids || []).join("/") || "(no id)").join(", ")
      );
    }
    const want = (selectedLang || "").toLowerCase().slice(0, 2);
    const sameLang = audioTracks.filter((t) =>
      want ? (t.language || "").toLowerCase().startsWith(want) : false
    );
    if (sameLang.length > 1)
      console.log(
        "[YLR] several",
        want,
        "audio tracks and no id to choose between them:",
        sameLang.map((t) => t.name || t.language).join(", ")
      );
    const track =
      sameLang.find((t) => /primary/i.test(t.trackType)) ||
      sameLang[0] ||
      audioTracks.find((t) => /primary/i.test(t.trackType)) ||
      audioTracks[0];
    return { track, why: sameLang.length ? "matched the subtitle language" : "fell back to the primary track" };
  }

  function rankedStreams() {
    const { track, why } = pickTrack();
    const ranked = track.streams
      .slice()
      .sort((a, b) => streamScore(a) - streamScore(b) || (a.bitrate || 1e9) - (b.bitrate || 1e9));
    console.log(
      "[YLR] audio track:",
      (track.name || track.language) + " —",
      why + " |",
      ranked.map((s) => (s.profile || "?") + "@" + (s.bitrate || "?")).join(", ")
    );
    return ranked;
  }

  // Walk the ranked streams until one has an index and a codec we can decode.
  async function ensureStream() {
    if (chosen) return chosen;
    const tried = [];
    for (const stream of rankedStreams()) {
      const label = stream.profile || "?";
      try {
        const index = await ensureIndex(stream);
        const codec = NS.mp4.codecOf(index.init);
        if (codec !== "mp4a") throw new Error("codec " + (codec || "unknown"));
        const config = NS.mp4.audioConfig(index.init);
        if (!config) throw new Error("no readable audio config");
        // ADTS can't describe every codec, but the browser may still be able to
        // *play* one — and since we fetched these bytes ourselves they carry no
        // DRM, so a hidden element can be tapped directly.
        let mime = "";
        if (!config.adtsCapable) {
          mime = 'audio/mp4; codecs="mp4a.40.' + config.profile + '"';
          const can = typeof Audio !== "undefined" ? new Audio().canPlayType(mime) : "";
          if (!can)
            throw new Error(
              NS.mp4.aotName(config.profile) + " can be neither remuxed nor played here"
            );
          console.log(
            "[YLR]",
            NS.mp4.aotName(config.profile),
            "can't be remuxed, but this browser can play it (" + can + ") —",
            "clips will be recorded from a hidden player instead"
          );
        }
        chosen = { stream, index, config, playbackOnly: !config.adtsCapable, mime };
        console.log(
          "[YLR] audio stream chosen:",
          label,
          (stream.bitrate || "?") + "kbps |",
          NS.mp4.aotName(config.profile),
          "freq" + config.freqIndex,
          config.channels + "ch"
        );
        return chosen;
      } catch (e) {
        tried.push(label + " — " + e.message);
        console.log("[YLR] audio stream unusable:", label, "—", e.message);
      }
    }
    throw new Error("no usable audio stream (" + tried.join("; ") + ")");
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
  // Three ways in, tried in order. The first two failing is normal — which
  // delivery a URL wants isn't knowable up front — so they stay quiet, but each
  // reason is kept and reported if all three fail.
  async function fetchRange(url, from, to) {
    const tried = [];
    const path = url.replace(/\/range\/\d+-\d+/, "/range/" + from + "-" + to);
    if (path !== url) {
      try {
        const res = await fetch(path);
        if (res.ok) return await res.arrayBuffer();
        tried.push("path form: HTTP " + res.status);
      } catch (e) {
        tried.push("path form: " + e.message);
      }
    }
    try {
      const res = await fetch(url, { headers: { Range: "bytes=" + from + "-" + to } });
      // A 200 here means the range was ignored and the whole file is coming.
      if (res.status === 206) return await res.arrayBuffer();
      tried.push("Range header: HTTP " + res.status + (res.status === 200 ? " (range ignored)" : ""));
    } catch (e) {
      tried.push("Range header: " + e.message);
    }
    const reply = await chrome.runtime.sendMessage({
      type: "YLR_FETCH_BYTES",
      url,
      from,
      to
    });
    if (reply && reply.ok) return base64ToBuffer(reply.body);
    tried.push("service worker: " + ((reply && reply.error) || "no response"));
    throw new Error(
      "could not fetch audio bytes " + from + "-" + to + " — " + tried.join("; ")
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

  async function probeAudio() {
    if (probe.probed) return;
    probe.probed = true;
    try {
      const { index } = await ensureStream();
      probe.ok = true;
      console.log(
        "[YLR] AUDIO OK — " +
          index.entries.length +
          " subsegments, clips can be fetched directly"
      );
    } catch (e) {
      probe.ok = false;
      probe.reason = e.message;
      console.log("[YLR] AUDIO UNAVAILABLE — " + e.message);
    }
  }

  // core's ClipExtractor contract: the bytes for [start,end] plus the
  // presentation time the returned buffer actually begins at.
  async function audioSegments(start, end) {
    const { stream, index, playbackOnly, mime } = await ensureStream();
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
    // Carried into any decode failure, so the reason shown in the sidebar names
    // what was actually handed to the decoder.
    const describe =
      (adts.codec || "codec?") +
      (adts.config
        ? " AOT" + adts.config.profile + "/freq" + adts.config.freqIndex + "/" + adts.config.channels + "ch"
        : " no-config") +
      (adts.buffer
        ? ", " + adts.frames + " frames, " + Math.round(adts.buffer.byteLength / 1024) + "KB ADTS"
        : ", no remux: " + adts.reason) +
      (adts.skipped ? ", " + adts.skipped + " skipped" : "") +
      ", fmp4 " + Math.round(fmp4.byteLength / 1024) + "KB";
    console.log("[YLR] clip bytes:", bytes.byteLength, "|", describe);
    return {
      buffer: playbackOnly ? fmp4 : adts.buffer || fmp4,
      fallbackBuffer: playbackOnly || !adts.buffer ? null : fmp4,
      playbackOnly: !!playbackOnly,
      mime: mime || "audio/mp4",
      t0: range.t0,
      describe
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


  NS.adapter = {
    name: "netflix",
    // The watch page is a full-viewport fixed layout, so push mode has to narrow
    // this container directly rather than relying on the body's width.
    playerRoot() {
      return (
        document.querySelector(".watch-video, [data-uia='player']") ||
        (getVideo() && getVideo().parentElement) ||
        null
      );
    },
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
    // ?t= is a start offset in seconds, so a saved clip's link reopens the
    // title on the line it came from.
    clipUrl(range) {
      const at = range && range.start != null ? Math.max(0, Math.floor(range.start)) : 0;
      return "https://www.netflix.com/watch/" + (idFromUrl() || "") + "?t=" + at;
    },
    onNavigate(cb) {
      patchHistory(cb);
    },
    init(h) {
      handlers = h;
      window.addEventListener("message", onMessage);
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
    directAudioStatus() {
      return probe;
    },
    // Every candidate for the title, so a blank one can be diagnosed from the
    // sidebar rather than by guessing at which source failed.
    titleSources() {
      return Object.assign({ titleBar: domTitle() }, lastTitleSources);
    },
    async loadTrack(track) {
      selectedLang = track.languageCode || "";
      probeAudio();
      const res = await fetch(track.url);
      if (!res.ok) throw new Error("subtitle fetch HTTP " + res.status);
      const body = await res.text();
      const segments =
        track.format === "ttml" ? NS.parseTTML(body) : NS.parseWebVTT(body);
      fetchTranslation(track);
      return segments;
    },



  };
  console.log("[YLR] netflix adapter ready");
})();
