// Netflix adapter. Tracks come from netflix-inject.js (manifest interception);
// subtitles are fetched directly (WebVTT, not DRM'd); audio is captured from the
// tab's output via chrome.tabCapture (DRM blocks the element tap).
(function () {
  const NS = (window.YLR = window.YLR || {});
  let handlers = null;
  let tracks = [];
  let mediaId = null;
  let captureStream = null;

  function getVideo() {
    return document.querySelector("video");
  }

  function idFromUrl() {
    const m = location.pathname.match(/\/watch\/(\d+)/);
    return m ? m[1] : null;
  }

  function onMessage(ev) {
    if (ev.source !== window || ev.data?.source !== "YLR") return;
    if (ev.data.type === "NF_TRACKS") {
      tracks = ev.data.tracks || [];
      mediaId = ev.data.mediaId;
      handlers.onTracks({
        tracks,
        mediaId: ev.data.mediaId,
        title: ev.data.title
      });
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
  // click; turn it into a MediaStream for the ring buffer.
  function setupCaptureBridge() {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type !== "ENABLE_CAPTURE" || !msg.streamId) return;
      navigator.mediaDevices
        .getUserMedia({
          audio: {
            mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: msg.streamId }
          },
          video: false
        })
        .then((stream) => {
          captureStream = stream;
          console.log("[YLR] Netflix tab-audio capture enabled");
        })
        .catch((e) => console.log("[YLR] getUserMedia(tab) failed:", e));
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
      window.postMessage({ source: "YLR-CS", type: "NF_SEEK", seconds }, "*");
      const v = getVideo();
      if (v) {
        try {
          v.currentTime = seconds;
        } catch (e) {}
      }
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
    async loadTrack(track) {
      const res = await fetch(track.url);
      if (!res.ok) throw new Error("subtitle fetch HTTP " + res.status);
      const body = await res.text();
      const segments =
        track.format === "ttml" ? NS.parseTTML(body) : NS.parseWebVTT(body);
      fetchTranslation(track);
      return segments;
    },
    async setupAudio(capture) {
      if (captureStream) {
        await capture.ensureFromStream(captureStream);
        return;
      }
      throw new Error(
        "Click the extension icon in the toolbar to enable audio capture on this tab, then star again."
      );
    }
  };
})();
