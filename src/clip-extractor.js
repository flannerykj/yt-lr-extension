// Pulls a clip for ANY time range, whether or not it has played through the
// live tap.
//   1. Preferred: decode the player's own audio segments (kept by inject.js off
//      MediaSource) and cut the range out. Instant, playhead-independent.
//   2. Fallback: point a hidden <audio> element at an audio-only stream URL and
//      record it. Its own playhead means the user's video is untouched, but the
//      recording must run at 1x to stay faithful, so it costs real time.
(function () {
  const NS = (window.YLR = window.YLR || {});

  class ClipExtractor {
    constructor(adapter) {
      this.adapter = adapter;
      this.el = null;
      this.cap = null;
      this.mediaId = null;
      this.blobUrl = null;
      this._preparing = null;
    }

    _teardown() {
      if (this.el) {
        this.el.pause();
        this.el.removeAttribute("src");
      }
      if (this.cap && this.cap.ctx) this.cap.ctx.close().catch(() => {});
      if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
      this.el = null;
      this.cap = null;
      this.blobUrl = null;
      this.mediaId = null;
    }

    _load(el) {
      return new Promise((resolve, reject) => {
        if (el.readyState >= 1) return resolve();
        const done = (err) => {
          clearTimeout(timer);
          el.removeEventListener("loadedmetadata", ok);
          el.removeEventListener("error", bad);
          err ? reject(err) : resolve();
        };
        const ok = () => done(null);
        const bad = () =>
          done(
            new Error(
              el.error ? "media error " + el.error.code : "the stream would not load"
            )
          );
        const timer = setTimeout(
          () => done(new Error("timed out loading the audio stream")),
          20000
        );
        el.addEventListener("loadedmetadata", ok);
        el.addEventListener("error", bad);
        el.load();
      });
    }

    async _prepare(mediaId) {
      const src = await this.adapter.audioSource();
      console.log("[YLR] clip extractor: audio source from", src.from, src.mime);
      const el = new Audio();
      el.preload = "auto";
      el.crossOrigin = "anonymous"; // without CORS the graph would be silenced
      el.src = src.url;
      try {
        await this._load(el);
      } catch (e) {
        // Cross-origin refusal or an expired URL: have the page fetch the bytes
        // for us (it has the right origin) and play them from a local blob.
        console.log("[YLR] clip extractor: direct URL failed (" + e.message + "); fetching bytes");
        const res = await this.adapter.audioBytes();
        this.blobUrl = URL.createObjectURL(
          new Blob([res.buffer], { type: String(res.mime || "").split(";")[0] })
        );
        el.removeAttribute("crossorigin");
        el.src = this.blobUrl;
        await this._load(el);
      }
      this.el = el;
      this.cap = new NS.AudioCapture(el, { bufferSeconds: 45 });
      await this.cap.ensureFromElement({ silent: true });
      this.mediaId = mediaId;
      console.log("[YLR] clip extractor ready; duration", el.duration);
    }

    // Primary path: the player's own audio segments, decoded and cut. Instant,
    // and it doesn't care where the playhead is.
    async extractFromSegments(start, end, pad) {
      const res = await this.adapter.audioSegments(start - pad, end + pad);
      const ctx = this._decodeCtx || (this._decodeCtx = new AudioContext());
      const audio = await ctx.decodeAudioData(res.buffer);
      const rate = audio.sampleRate;
      const from = Math.max(0, Math.round((start - pad - res.t0) * rate));
      const to = Math.min(audio.length, Math.round((end + pad - res.t0) * rate));
      if (to - from < rate * 0.05)
        throw new Error("decoded audio didn't cover that line (t0 " + res.t0.toFixed(2) + ")");
      const mono = new Float32Array(to - from);
      for (let c = 0; c < audio.numberOfChannels; c++) {
        const src = audio.getChannelData(c);
        for (let i = from; i < to; i++) mono[i - from] += src[i] / audio.numberOfChannels;
      }
      let peak = 0;
      for (let i = 0; i < mono.length; i += 16) {
        const a = Math.abs(mono[i]);
        if (a > peak) peak = a;
      }
      console.log(
        "[YLR] decoded clip:",
        (mono.length / rate).toFixed(2) + "s, peak",
        peak.toFixed(4),
        "| segments started at",
        res.t0.toFixed(2)
      );
      return NS.encodeWav(mono, rate);
    }

    async extract(mediaId, start, end) {
      let segErr = null;
      if (this.adapter.audioSegments) {
        try {
          return await this.extractFromSegments(start, end, 0.15);
        } catch (e) {
          segErr = e;
          console.log("[YLR] segment extraction failed:", e.message);
        }
      }
      try {
        return await this.extractByReplay(mediaId, start, end);
      } catch (e) {
        console.log("[YLR] replay extraction failed:", e.message);
        throw segErr || e; // the segment reason is the actionable one
      }
    }

    async extractByReplay(mediaId, start, end) {
      if (this.mediaId && this.mediaId !== mediaId) this._teardown();
      if (!this._preparing || this.mediaId !== mediaId) {
        this._preparing = this._prepare(mediaId).catch((e) => {
          this._preparing = null;
          throw e;
        });
      }
      await this._preparing;
      this.cap.reset();
      this.cap.resume();
      this.el.currentTime = Math.max(0, start - 0.4);
      try {
        await this.el.play();
      } catch (e) {
        throw new Error("couldn't play the audio stream to record it: " + e.message);
      }
      console.log(
        "[YLR] clip extractor: recording",
        start.toFixed(2) + "→" + end.toFixed(2)
      );
      try {
        return await this.cap.capture(start, end, { waitForPlayback: true });
      } finally {
        this.el.pause();
        if (this.cap.ctx && this.cap.ctx.state === "running")
          this.cap.ctx.suspend().catch(() => {});
      }
    }
  }

  NS.ClipExtractor = ClipExtractor;
})();
