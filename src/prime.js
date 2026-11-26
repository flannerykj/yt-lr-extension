// Prime Video adapter. Tracks come from prime-inject.js (playback-resources
// interception); subtitles are plain TTML/WebVTT files on Amazon's CDN, so the
// adapter just fetches and parses them.
//
// No audio: Prime encrypts audio together with video, so there is nothing to tap
// and nothing fetchable to decode. Starring a line here saves its text.
(function () {
  const NS = (window.YLR = window.YLR || {});
  let handlers = null;
  let tracks = [];
  let mediaId = null;
  let translationTrack = null;

  // Cached because core polls this every animation frame; Prime only swaps the
  // element on a nav, which detaching catches.
  let cachedVideo = null;
  function playable(v) {
    return !!v && v.isConnected && Number.isFinite(v.duration) && v.duration > 1;
  }

  function getVideo() {
    if (playable(cachedVideo)) return cachedVideo;
    // Only a loaded feature counts. Prime leaves preview and trailer elements
    // lying around, and an element with no duration means the player is gone —
    // which is how the sidebar knows to close.
    const vids = Array.prototype.slice.call(document.querySelectorAll("video")).filter(playable);
    cachedVideo =
      vids.find((v) => !v.paused) ||
      vids.sort((a, b) => b.duration - a.duration)[0] ||
      null;
    return cachedVideo;
  }

  function asinFromUrl() {
    const m = location.pathname.match(/\/(?:detail|watch|video\/detail)\/([A-Z0-9]{8,})/i);
    return m ? m[1] : null;
  }

  function currentMediaId() {
    return mediaId || asinFromUrl();
  }

  // The locale Prime is serving the page in ("/-/es/detail/..."), which is the
  // best guess at the language the user came here to study.
  function pageLocale() {
    const m = location.pathname.match(/^\/-\/([a-z]{2})\//i);
    return m ? m[1].toLowerCase() : null;
  }

  function isEnglish(t) {
    return (t.languageCode || "").toLowerCase().startsWith("en");
  }

  const EPISODE_MARK = /\bS?\d+\s*[·x-]?\s*E\d+\b|\bE(?:p|pisod(?:e|io))?\.?\s*\d+\b/i;

  // The player's own heading carries "S1 E3 - Episode title". It's a fallback
  // for responses whose metadata names only the season, and it isn't mounted
  // until the player UI paints, hence the retries.
  function domTitle() {
    const pick = (sel) => {
      const el = document.querySelector(sel);
      return el ? (el.textContent || "").replace(/\s+/g, " ").trim() : "";
    };
    const parts = [
      pick('[class*="atvwebplayersdk-title-text"]'),
      pick('[class*="atvwebplayersdk-subtitle-text"]')
    ].filter(Boolean);
    return parts.join(" - ");
  }

  function bestTitle(fromInjector) {
    if (EPISODE_MARK.test(fromInjector || "")) return fromInjector;
    const dom = domTitle();
    if (dom && EPISODE_MARK.test(dom)) return dom;
    return fromInjector || dom || document.title;
  }

  function announceTracks(payload, attempt) {
    const title = bestTitle(payload.title);
    handlers.onTracks({ tracks, mediaId, title });
    retryTitle(payload, title, attempt);
  }

  function retryTitle(payload, current, attempt) {
    if (EPISODE_MARK.test(current) || attempt >= 5) return;
    setTimeout(() => {
      if (mediaId !== payload.mediaId) return; // moved on to another title
      const better = bestTitle(payload.title);
      if (better !== current) announceTracks(payload, attempt + 1);
      else retryTitle(payload, current, attempt + 1);
    }, 1200);
  }

  function onMessage(ev) {
    if (ev.source !== window || !ev.data || ev.data.source !== "YLR") return;
    if (ev.data.type === "PV_MPD") {
      reportManifest(ev.data.body, ev.data.url);
      return;
    }
    if (ev.data.type !== "PV_TRACKS") return;
    tracks = ev.data.tracks || [];
    mediaId = ev.data.mediaId;
    announceTracks(ev.data, 0);
    // The media urls arrive in a later response than the subtitles, so the first
    // PV_TRACKS usually carries none and a second one carries them.
    probeAudio(ev.data.manifests || []);
  }

  // ---- can we fetch the audio directly? ----
  //
  // Netflix ships audio unencrypted alongside Widevine video, which is how
  // Language Reactor cuts Netflix clips without recording them. This reports
  // whether Prime does the same. If the audio adaptation set has no
  // ContentProtection, clips can be range-fetched and decoded instead of
  // replayed through the speakers.
  let probe = { probed: false, hasAudio: false, ok: false, reason: "" };

  // The injector caught the DASH manifest itself, which is the direct answer to
  // "can Prime audio be fetched and decoded like Netflix's?".
  // Several manifests arrive per title. A verdict is only final once one of
  // them actually contains audio — a video-only manifest must not end the
  // search, which is what a single `probed` latch used to do.
  const seenManifests = [];
  function reportManifest(body, url) {
    if (probe.probed && probe.hasAudio) return;
    if (seenManifests.indexOf(url) !== -1) return;
    seenManifests.push(url);
    probe.probed = true;
    console.log(
      "[YLR] PV_MPD " + seenManifests.length + " received:",
      (body || "").length,
      "bytes",
      String(url).slice(0, 90)
    );
    let verdict;
    try {
      verdict = describeManifest(body, url);
    } catch (e) {
      probe.reason = "reading the manifest threw — " + e.message;
      console.log("[YLR] audio probe:", probe.reason);
      return;
    }
    if (!verdict) {
      const sets = describeSets(body);
      // Not final: another manifest may still carry the audio.
      if (!probe.hasAudio)
        probe = {
          probed: true,
          hasAudio: false,
          ok: false,
          reason:
            "no audio adaptation set in " +
            seenManifests.length +
            " manifest(s) so far — " +
            sets
        };
      console.log("[YLR] audio probe: no audio adaptation set —", sets);
      return;
    }
    probe.hasAudio = true;
    // Recorded, not just logged: the Settings tab shows this, because the
    // console is one filter setting away from hiding the isolated world.
    probe = {
      probed: true,
      hasAudio: true,
      ok: verdict.summary.indexOf("NOT possible") === -1,
      reason: verdict.summary
    };
    console.log("[YLR] audio probe:", verdict.summary);
    console.log("[YLR] audio probe detail:", verdict);
  }

  // When no audio set is found, say what the manifest did contain: separate
  // audio and video manifests would explain it.
  function describeSets(body) {
    try {
      const doc = new DOMParser().parseFromString(body, "text/xml");
      if (doc.getElementsByTagName("parsererror").length) return "not parseable as XML";
      const sets = Array.prototype.slice.call(
        doc.getElementsByTagNameNS("*", "AdaptationSet")
      );
      if (!sets.length) return "no AdaptationSet elements at all";
      return (
        sets.length +
        " set(s): " +
        sets
          .map(
            (a) =>
              (a.getAttribute("contentType") || a.getAttribute("mimeType") || "?") +
              "/" +
              (a.getAttribute("lang") || "-")
          )
          .join(", ")
      );
    } catch (e) {
      return "unreadable (" + e.message + ")";
    }
  }

  async function probeAudio(manifests) {
    if (probe.probed || !manifests.length) return;
    probe.probed = true;
    console.log("[YLR] probing", manifests.length, "media manifest(s) for fetchable audio");
    const tried = [];
    for (const url of manifests) {
      try {
        const body = await fetchText(url);
        const verdict = describeManifest(body, url);
        if (verdict) {
          probe.ok = verdict.summary.indexOf("NOT possible") === -1;
          probe.reason = verdict.summary;
          console.log("[YLR] audio probe:", verdict.summary);
          console.log("[YLR] audio probe detail:", verdict);
          return;
        }
        tried.push("no audio set in " + url.slice(0, 60));
      } catch (e) {
        tried.push(e.message);
        console.log("[YLR] audio probe: could not read", url.slice(0, 80), "-", e.message);
      }
    }
    probe.reason =
      "no readable DASH manifest among " + manifests.length + " url(s) — " + tried.join("; ");
    console.log("[YLR] audio probe:", probe.reason);
  }

  function describeManifest(body, url) {
    const doc = new DOMParser().parseFromString(body, "text/xml");
    if (doc.getElementsByTagName("parsererror").length) return null;
    const sets = Array.prototype.slice.call(doc.getElementsByTagNameNS("*", "AdaptationSet"));
    const audio = sets.filter((a) => {
      const type = (a.getAttribute("contentType") || a.getAttribute("mimeType") || "").toLowerCase();
      if (type.indexOf("audio") !== -1) return true;
      const rep = a.getElementsByTagNameNS("*", "Representation")[0];
      return !!rep && (rep.getAttribute("mimeType") || "").toLowerCase().indexOf("audio") !== -1;
    });
    if (!audio.length) return null;
    const protectedSets = audio.filter(
      (a) => a.getElementsByTagNameNS("*", "ContentProtection").length > 0
    );
    const first = audio[0];
    const rep = first.getElementsByTagNameNS("*", "Representation")[0];
    const template = first.getElementsByTagNameNS("*", "SegmentTemplate")[0];
    return {
      summary:
        audio.length +
        " audio adaptation set(s), " +
        protectedSets.length +
        " encrypted → direct fetch " +
        (protectedSets.length ? "NOT possible" : "LOOKS POSSIBLE"),
      manifest: url,
      languages: audio.map((a) => a.getAttribute("lang")).join(","),
      codecs: rep ? rep.getAttribute("codecs") : null,
      addressing: template
        ? "SegmentTemplate"
        : first.getElementsByTagNameNS("*", "SegmentList").length
          ? "SegmentList"
          : first.getElementsByTagNameNS("*", "SegmentBase").length
            ? "SegmentBase"
            : "unknown",
      initialization: template ? template.getAttribute("initialization") : null,
      media: template ? template.getAttribute("media") : null
    };
  }

  // Amazon's subtitle CDN doesn't always send CORS headers for the page origin,
  // so fall back to fetching from the service worker, which has host access.
  async function fetchText(url) {
    try {
      const res = await fetch(url, { credentials: "omit" });
      if (res.ok) return await res.text();
      throw new Error("HTTP " + res.status);
    } catch (e) {
      const reply = await chrome.runtime.sendMessage({ type: "YLR_FETCH_TEXT", url });
      if (!reply || !reply.ok)
        throw new Error(
          "couldn't download the subtitle file (" +
            e.message +
            "; via background: " +
            ((reply && reply.error) || "no response") +
            ")"
        );
      return reply.text;
    }
  }

  function parseBody(body, format) {
    const head = body.slice(0, 200).trim();
    if (format === "webvtt" || /^WEBVTT/i.test(head)) return NS.parseWebVTT(body);
    if (format === "ttml" || head[0] === "<") return NS.parseTTML(body);
    return NS.parseWebVTT(body);
  }

  async function cuesFor(track) {
    return parseBody(await fetchText(track.url), track.format);
  }

  function pickTranslation(sourceTrack) {
    if (isEnglish(sourceTrack)) return null;
    return (
      tracks.find((t) => isEnglish(t) && !t.isForced && t.kind === "subtitle") ||
      tracks.find((t) => isEnglish(t) && !t.isForced) ||
      tracks.find(isEnglish) ||
      null
    );
  }

  async function loadTranslation(sourceTrack) {
    const en = pickTranslation(sourceTrack);
    translationTrack = en;
    if (!en) return;
    try {
      const cues = await cuesFor(en);
      handlers.onTranslation({
        mediaId,
        lang: sourceTrack.languageCode,
        targetLang: en.languageCode,
        targetName: en.name,
        cues
      });
    } catch (e) {
      console.log("[YLR] Prime translation track failed:", e.message);
    }
  }

  // Prime is a single-page app and starts playback without always changing the
  // URL, so watch for both.
  function watchNavigation(cb) {
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
    let lastHref = location.href;
    let hadVideo = !!getVideo();
    setInterval(() => {
      const video = !!getVideo();
      if (location.href === lastHref && video === hadVideo) return;
      lastHref = location.href;
      hadVideo = video;
      cb();
    }, 1000);
  }



  NS.adapter = {
    name: "prime",
    // Ad breaks are stitched into the timeline video.currentTime reports, so the
    // sidebar has to re-anchor itself against the player's own captions.
    syncable: true,
    playerRoot() {
      return (
        document.querySelector("#dv-web-player") ||
        document.querySelector('[class*="webPlayerSDKContainer"]') ||
        document.querySelector('[class*="webPlayerUIContainer"]') ||
        null
      );
    },
    // The player opens over the detail page without necessarily changing the
    // URL, so a loaded feature video is the only honest signal that it is up.
    isWatchPage() {
      return !!getVideo();
    },
    directAudioStatus() {
      return probe;
    },
    currentMediaId,
    getVideo,
    seek(seconds) {
      const v = getVideo();
      if (v) {
        try {
          v.currentTime = seconds;
          v.play().catch((err) => NS.warn("prime: play() after seek refused", err));
          return;
        } catch (e) {
          NS.warn("prime: currentTime seek rejected, using the player API", e);
        }
      }
      window.postMessage({ source: "YLR-CS", type: "PV_SEEK", seconds }, "*");
    },
    defaultTrack(ts) {
      const locale = pageLocale();
      const plain = ts.filter((t) => !t.isForced);
      return (
        (locale &&
          plain.find((t) => (t.languageCode || "").toLowerCase().startsWith(locale))) ||
        plain.find((t) => !isEnglish(t)) ||
        plain[0] ||
        ts[0]
      );
    },
    trackLabel(t) {
      return t.name + (t.isForced ? " (forced)" : "");
    },
    translationLabel() {
      return translationTrack ? translationTrack.name : "";
    },
    clipUrl(range) {
      const at = range && range.start != null ? Math.max(0, Math.floor(range.start)) : 0;
      return location.origin + location.pathname + "?t=" + at;
    },
    onNavigate(cb) {
      watchNavigation(cb);
    },
    init(h) {
      handlers = h;
      window.addEventListener("message", onMessage);
    },
    requestTracks() {
      window.postMessage({ source: "YLR-CS", type: "PV_REQUEST_TRACKS" }, "*");
    },
    async loadTrack(track) {
      const segments = await cuesFor(track);
      loadTranslation(track);
      return segments;
    },



  };
  console.log("[YLR] prime adapter ready");
})();
