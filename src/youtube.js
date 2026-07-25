// YouTube adapter. Talks to inject.js (MAIN world) over window.postMessage:
// tracks/captions come from intercepted json3; audio taps the <video> element.
(function () {
  const NS = (window.YLR = window.YLR || {});
  let handlers = null;
  const captionCache = new Map(); // "lang|kind" -> json3 text
  const pendingSelections = new Map(); // languageCode -> { resolve, reject }

  function getVideo() {
    return document.querySelector(
      "video.html5-main-video, video.video-stream, #movie_player video, video"
    );
  }

  function currentVideoId() {
    try {
      const u = new URL(location.href);
      if (u.searchParams.get("v")) return u.searchParams.get("v");
      const m = location.pathname.match(/\/(shorts|embed)\/([^/?#]+)/);
      if (m) return m[2];
    } catch (e) {}
    return null;
  }

  function requestCaptions(track) {
    const key = track.languageCode + "|" + (track.kind || "");
    if (captionCache.has(key)) return Promise.resolve(captionCache.get(key));
    return new Promise((resolve, reject) => {
      pendingSelections.set(track.languageCode, { resolve, reject });
      window.postMessage(
        {
          source: "YLR-CS",
          type: "SELECT_TRACK",
          languageCode: track.languageCode,
          kind: track.kind
        },
        "*"
      );
      setTimeout(() => {
        if (pendingSelections.get(track.languageCode)) {
          pendingSelections.delete(track.languageCode);
          reject(new Error("timed out — couldn't get YouTube to load this track's captions"));
        }
      }, 12000);
    });
  }

  function onMessage(ev) {
    if (ev.source !== window || ev.data?.source !== "YLR") return;
    const d = ev.data;
    if (d.type === "TRACKS") {
      handlers.onTracks({
        tracks: d.tracks,
        mediaId: d.videoId,
        title: (d.title || "").replace(/ - YouTube$/, "")
      });
    } else if (d.type === "CAPTIONS") {
      captionCache.set((d.lang || "") + "|" + (d.kind || ""), d.text);
      const p = pendingSelections.get(d.lang || "");
      if (p) {
        pendingSelections.delete(d.lang || "");
        p.resolve(d.text);
      }
    } else if (d.type === "TRANSLATION") {
      try {
        handlers.onTranslation({
          mediaId: d.videoId,
          lang: d.lang,
          cues: NS.parseJson3Cues(d.text)
        });
      } catch (e) {}
    }
  }

  NS.adapter = {
    name: "youtube",
    isWatchPage() {
      return location.pathname === "/watch" || location.pathname.startsWith("/shorts/");
    },
    currentMediaId: currentVideoId,
    getVideo,
    seek(seconds) {
      const v = getVideo();
      if (!v) return;
      v.currentTime = seconds;
      v.play().catch(() => {});
    },
    defaultTrack(tracks) {
      return tracks.find((t) => t.kind === "asr") || tracks[0];
    },
    trackLabel(t) {
      return t.name + (t.kind === "asr" ? " (auto)" : "");
    },
    clipUrl(seg) {
      return (
        "https://www.youtube.com/watch?v=" +
        currentVideoId() +
        "&t=" +
        Math.floor(seg.start) +
        "s"
      );
    },
    onNavigate(cb) {
      document.addEventListener("yt-navigate-finish", cb);
    },
    init(h) {
      handlers = h;
      window.addEventListener("message", onMessage);
    },
    requestTracks() {
      window.postMessage({ source: "YLR-CS", type: "REQUEST_TRACKS" }, "*");
    },
    loadTrack(track) {
      return requestCaptions(track).then((text) => NS.parseJson3(text));
    },
    async setupAudio(capture) {
      await capture.ensureFromElement();
    }
  };
})();
