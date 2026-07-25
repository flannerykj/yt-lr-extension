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
