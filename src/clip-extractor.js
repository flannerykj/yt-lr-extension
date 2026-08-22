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
    async extractFromSegments(start, end) {
      const pad = NS.CLIP_PAD;
      const from0 = Math.max(0, start - pad.lead);
      const res = await this.adapter.audioSegments(from0, end + pad.tail);
      const detail = res.describe ? " [" + res.describe + "]" : "";
      // Some codecs (xHE-AAC) decodeAudioData refuses outright but a media
      // element will still play. Those go straight to the playback tap.
      if (res.playbackOnly) return await this.playFromBytes(res, from0, end + pad.tail);
      const ctx = this._decodeCtx || (this._decodeCtx = new AudioContext());
      let audio;
      try {
        audio = await ctx.decodeAudioData(res.buffer);
      } catch (e) {
        if (!res.fallbackBuffer) throw new Error(e.message + detail);
        console.log("[YLR] primary decode failed (" + e.message + "); trying the raw container");
        try {
          audio = await ctx.decodeAudioData(res.fallbackBuffer);
        } catch (e2) {
          throw new Error(e.message + " (container form too)" + detail);
        }
      }
      const rate = audio.sampleRate;
      const from = Math.max(0, Math.round((from0 - res.t0) * rate));
      const to = Math.min(audio.length, Math.round((end + pad.tail - res.t0) * rate));
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

    // The bytes came from a plain fetch, so nothing here is DRM-protected: a
    // hidden element can play them and the graph can be tapped. Costs real time
    // (it plays at 1x) but it is silent and never touches the user's player.
    async playFromBytes(res, start, end) {
      const url = URL.createObjectURL(
        new Blob([res.buffer], { type: String(res.mime || "audio/mp4").split(";")[0] })
      );
      const el = new Audio();
      el.preload = "auto";
      el.src = url;
      let cap = null;
      try {
        await this._load(el);
        cap = new NS.AudioCapture(el, { bufferSeconds: 120 });
        await cap.ensureFromElement({ silent: true });
        cap.resume();
        // A blob of fragments does NOT start at zero — each fragment's tfdt keeps
        // its absolute presentation time, so the element's clock picks up wherever
        // in the title the fragments came from. `seekable` can't be trusted to say
        // where that is (it is often still empty at loadedmetadata), and seeking
        // to a time outside the media stalls playback outright. So: play first,
        // and take the origin from the first audio that actually arrives.
        await el.play();
        const base = await this._firstTag(cap, el, 5000);
        const pad = NS.CLIP_PAD;
        const from = base + Math.max(0, start - res.t0);
        const to = Math.max(from + 0.2, base + (end - res.t0));
        // Now that the clock's origin is known, skipping ahead is safe.
        if (from - base > 2.5) el.currentTime = from - 1.5;
        console.log(
          "[YLR] recording from a hidden player:",
          from.toFixed(2) + "→" + to.toFixed(2),
          "| clock starts at",
          base.toFixed(2),
          "| fragments start at",
          res.t0.toFixed(2)
        );
        // capture() applies its own lead-in and tail, so hand it a range that
        // comes back out as exactly [from, to].
        const wav = await cap.capture(from + pad.lead, to - pad.tail, {
          waitForPlayback: true,
          timeoutMs: (to - from) * 1000 + 10000,
          label: "the hidden player"
        });
        // A player that reports progress but emits nothing hasn't really decoded
        // the codec; saving that would be a clip of silence presented as a win.
        if (cap.maxPeak < 0.0005)
          throw new Error("the hidden player produced only silence for this codec");
        return wav;
      } finally {
        el.pause();
        el.removeAttribute("src");
        if (cap && cap.ctx) cap.ctx.close().catch(() => {});
        URL.revokeObjectURL(url);
      }
    }

    // Resolves with the time the first audio was tagged at, once the clock has
    // demonstrably moved. That single value is both the origin of the element's
    // timeline and proof that the codec is really being decoded — canPlayType
    // only reports what the browser claims.
    _firstTag(cap, el, ms) {
      return new Promise((resolve, reject) => {
        const deadline = Date.now() + ms;
        const tick = () => {
          if (cap.chunks.length) {
            const first = cap.chunks[0].time;
            if (cap.chunks[cap.chunks.length - 1].time > first + 0.05) return resolve(first);
          }
          if (el.error)
            return reject(
              new Error("the hidden player rejected these bytes (media error " + el.error.code + ")")
            );
          if (Date.now() > deadline)
            return reject(
              new Error(
                cap.chunks.length
                  ? "the hidden player accepted this codec but its clock never advanced"
                  : "the hidden player produced no audio at all"
              )
            );
          setTimeout(tick, 60);
        };
        tick();
      });
    }

    async extract(mediaId, start, end) {
      let segErr = null;
      if (this.adapter.audioSegments) {
        try {
          return await this.extractFromSegments(start, end);
        } catch (e) {
          segErr = e;
          console.log("[YLR] segment extraction failed:", e.message);
        }
      }
      if (!this.adapter.audioSource) throw segErr || new Error("no audio source");
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
      this.el.currentTime = Math.max(0, start - NS.CLIP_PAD.lead - 0.4);
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
        return await this.cap.capture(start, end, {
          waitForPlayback: true,
          label: "the audio-stream replay"
        });
      } finally {
        this.el.pause();
        if (this.cap.ctx && this.cap.ctx.state === "running")
          this.cap.ctx.suspend().catch(() => {});
      }
    }
  }

  NS.ClipExtractor = ClipExtractor;
})();
