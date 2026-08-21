// Prime Video adapter. Tracks come from prime-inject.js (playback-resources
// interception); subtitles are plain TTML/WebVTT files on Amazon's CDN, so the
// adapter just fetches and parses them. Audio, like Netflix, is DRM'd and has
// to come from chrome.tabCapture.
(function () {
  const NS = (window.YLR = window.YLR || {});
  let handlers = null;
  let tracks = [];
  let mediaId = null;
  let captureStream = null;
  let translationTrack = null;

  // Cached because core polls this every animation frame; Prime only swaps the
  // element on a nav, which detaching catches.
  let cachedVideo = null;
  function getVideo() {
    if (cachedVideo && cachedVideo.isConnected && cachedVideo.duration > 1)
      return cachedVideo;
    const vids = Array.prototype.slice.call(document.querySelectorAll("video"));
    if (!vids.length) return null;
    // Prime keeps trailer/preview elements around; the one that is actually
    // playing (or the longest) is the feature.
    cachedVideo =
      vids.find((v) => !v.paused && v.duration > 1) ||
      vids.sort((a, b) => (b.duration || 0) - (a.duration || 0))[0];
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

  function onMessage(ev) {
    if (ev.source !== window || !ev.data || ev.data.source !== "YLR") return;
    if (ev.data.type !== "PV_TRACKS") return;
    tracks = ev.data.tracks || [];
    mediaId = ev.data.mediaId;
    handlers.onTracks({ tracks, mediaId, title: ev.data.title });
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
    }, 1500);
  }

  function setupCaptureBridge() {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || msg.type !== "ENABLE_CAPTURE") return;
      if (!msg.streamId) {
        alert("Audio capture couldn't start: " + (msg.error || "unknown error"));
        return;
      }
      navigator.mediaDevices
        .getUserMedia({
          audio: {
            mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: msg.streamId }
          },
          video: false
        })
        .then((stream) => {
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
    name: "prime",
    isWatchPage() {
      return !!getVideo() || /\/(detail|watch)\//i.test(location.pathname);
    },
    currentMediaId,
    getVideo,
    seek(seconds) {
      const v = getVideo();
      if (v) {
        try {
          v.currentTime = seconds;
          v.play().catch(() => {});
          return;
        } catch (e) {}
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
    clipUrl() {
      return location.origin + location.pathname;
    },
    onNavigate(cb) {
      watchNavigation(cb);
    },
    init(h) {
      handlers = h;
      window.addEventListener("message", onMessage);
      setupCaptureBridge();
    },
    requestTracks() {
      window.postMessage({ source: "YLR-CS", type: "PV_REQUEST_TRACKS" }, "*");
    },
    async loadTrack(track) {
      const segments = await cuesFor(track);
      loadTranslation(track);
      return segments;
    },
    async setupAudio(capture) {
      if (captureStream) {
        const t = captureStream.getAudioTracks()[0];
        if (!t || t.readyState === "ended") captureStream = null;
      }
      if (!captureStream)
        throw new Error(
          "Audio capture isn't on. Click this extension's icon in the Chrome toolbar " +
            "once to enable it for this tab, then star again."
        );
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
