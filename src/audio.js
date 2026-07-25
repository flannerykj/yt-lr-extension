// Rolling PCM ring buffer over the YouTube <video>, plus WAV export of any
// past time range. Each PCM batch from the worklet is tagged with the video's
// currentTime at receipt, so a starred phrase is sliced by matching video-time
// tags rather than wall-clock — correct across pauses and (approximately)
// playback-rate changes.
(function () {
  const NS = (window.YLR = window.YLR || {});

  function encodeWav(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const writeStr = (off, s) => {
      for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
    };
    writeStr(0, "RIFF");
    view.setUint32(4, 36 + samples.length * 2, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, samples.length * 2, true);
    let off = 44;
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
    return new Blob([view], { type: "audio/wav" });
  }

  class AudioCapture {
    constructor(video, { bufferSeconds = 90, liveTime = null } = {}) {
      this.video = video;
      this.bufferSeconds = bufferSeconds;
      this.liveTime = liveTime; // current time of the live element, for staleness checks
      this.chunks = []; // { time, data: Float32Array }
      this.samples = 0;
      this.ctx = null;
      this.node = null;
      this.ready = false;
      this.sampleRate = 48000;
      this._pending = [];
    }

    async _init(existingCtx) {
      this.ctx = existingCtx || new (window.AudioContext || window.webkitAudioContext)();
      this.sampleRate = this.ctx.sampleRate;
      await this.ctx.audioWorklet.addModule(
        chrome.runtime.getURL("src/pcm-worklet.js")
      );
      this.node = new AudioWorkletNode(this.ctx, "ylr-pcm");
      this.node.port.onmessage = (e) => this._onChunk(e.data);
    }

    // YouTube: tap the <video> element directly. The worklet passes audio
    // through to the speakers, so we must route it to the destination.
    ensureFromElement({ silent = false } = {}) {
      if (this.ready) return Promise.resolve();
      if (this._ensuring) return this._ensuring;
      this._ensuring = (async () => {
        // An element can only ever be passed to createMediaElementSource once, so
        // the node (and its context) is cached on the element and reused if this
        // capture is rebuilt — a second call would throw and kill the tab's audio.
        const cached = this.video.__ylrTap;
        let source;
        if (cached) {
          await this._init(cached.ctx);
          source = cached.source;
          source.disconnect();
        } else {
          await this._init();
          try {
            source = this.ctx.createMediaElementSource(this.video);
          } catch (e) {
            throw new Error(
              "Could not tap the video's audio (another extension may already be capturing it)."
            );
          }
          this.video.__ylrTap = { ctx: this.ctx, source };
        }
        source.connect(this.node);
        // The worklet passes audio through, so the live tap must reach the
        // speakers. A silent tap (clip extraction from a hidden element) must
        // not — the worklet still needs a sink to keep pulling, hence gain 0.
        if (silent) {
          const mute = this.ctx.createGain();
          mute.gain.value = 0;
          this.node.connect(mute);
          mute.connect(this.ctx.destination);
        } else {
          this.node.connect(this.ctx.destination);
        }
        this.ready = true;
        console.log(
          "[YLR] element tap connected" + (silent ? " (silent)" : "") + "; ctx state:",
          this.ctx.state
        );
      })();
      return this._ensuring;
    }

    // Netflix: DRM blocks the element tap, so we record the tab's rendered
    // output (a MediaStream from tabCapture). The tab is already audible, so the
    // worklet's passthrough is routed through a muted gain to avoid doubling it.
    ensureFromStream(stream) {
      if (this.ready) return Promise.resolve();
      if (this._ensuring) return this._ensuring;
      this._ensuring = (async () => {
        this.captureStream = stream; // keep a ref so it isn't garbage-collected
        await this._init();
        const source = this.ctx.createMediaStreamSource(stream);
        const mute = this.ctx.createGain();
        mute.gain.value = 0;
        source.connect(this.node);
        this.node.connect(mute);
        mute.connect(this.ctx.destination);
        this.ready = true;
        console.log("[YLR] stream tap connected; ctx state:", this.ctx.state);
      })();
      return this._ensuring;
    }

    reset() {
      this.chunks = [];
      this.samples = 0;
    }

    resume() {
      if (this.ctx && this.ctx.state === "suspended") {
        this.ctx.resume().then(
          () => console.log("[YLR] audio ctx resumed:", this.ctx.state),
          (e) => console.log("[YLR] audio ctx resume failed:", e.message)
        );
      }
    }

    _onChunk(data) {
      const time = this.video.currentTime;
      this.chunks.push({ time, data });
      this.samples += data.length;
      // Periodic peak so we can tell whether the captured stream has any sound.
      this._dbg = (this._dbg || 0) + 1;
      if (this._dbg % 40 === 0) {
        let peak = 0;
        for (let i = 0; i < data.length; i += 16) {
          const a = Math.abs(data[i]);
          if (a > peak) peak = a;
        }
        console.log("[YLR] audio in: peak", peak.toFixed(4), "@ t=", time.toFixed(2));
      }
      const cutoff = time - this.bufferSeconds;
      while (this.chunks.length && this.chunks[0].time < cutoff) {
        this.samples -= this.chunks.shift().data.length;
      }
      // Time-tag eviction does nothing if the tags stop advancing (a dead or
      // stale element tap), so cap the raw sample count too — otherwise the
      // buffer grows without bound and drags the whole page down.
      const maxSamples = this.bufferSeconds * this.sampleRate * 1.5;
      while (this.chunks.length > 1 && this.samples > maxSamples) {
        this.samples -= this.chunks.shift().data.length;
      }
      this._resolvePending();
    }

    // Oldest/newest video-time tags currently in the ring buffer.
    _bufferRange() {
      if (!this.chunks.length) return null;
      let first = Infinity;
      let last = -Infinity;
      for (const c of this.chunks) {
        if (c.time < first) first = c.time;
        if (c.time > last) last = c.time;
      }
      return { first, last };
    }

    _covered(start, end) {
      let min = Infinity;
      let max = -Infinity;
      for (const c of this.chunks) {
        if (c.time >= start - 0.4 && c.time <= end + 0.4) {
          if (c.time < min) min = c.time;
          if (c.time > max) max = c.time;
        }
      }
      if (min === Infinity) return false;
      return min <= start + 0.4 && max >= end - 0.4;
    }

    _slice(start, end) {
      const selected = this.chunks.filter((c) => c.time >= start && c.time <= end);
      if (!selected.length) {
        const times = this.chunks.map((c) => c.time);
        console.log(
          "[YLR] slice empty for [" + start.toFixed(2) + "," + end.toFixed(2) + "]; buffer covers",
          times.length ? times[0].toFixed(2) + "→" + times[times.length - 1].toFixed(2) : "(empty)"
        );
        return null;
      }
      let total = 0;
      for (const c of selected) total += c.data.length;
      const merged = new Float32Array(total);
      let o = 0;
      for (const c of selected) {
        merged.set(c.data, o);
        o += c.data.length;
      }
      let peak = 0;
      for (let i = 0; i < merged.length; i += 16) {
        const a = Math.abs(merged[i]);
        if (a > peak) peak = a;
      }
      console.log(
        "[YLR] slice",
        selected.length,
        "chunks, dur",
        (merged.length / this.sampleRate).toFixed(2) + "s, peak",
        peak.toFixed(4)
      );
      return encodeWav(merged, this.sampleRate);
    }

    // Resolves with a WAV Blob for [start,end]. If not yet buffered (a segment
    // ahead of playback), the promise stays pending and is fulfilled once the
    // buffer fills — the caller is expected to seek/play to make that happen.
    capture(start, end, { pad = 0.15, waitForPlayback = false, immediate = false } = {}) {
      const s = Math.max(0, start - pad);
      const e = end + pad;
      return new Promise((resolve, reject) => {
        if (this._covered(s, e)) {
          const wav = this._slice(s, e);
          if (wav) return resolve(wav);
        }
        // The clip extractor drives its own element into the range on purpose, so
        // "not buffered yet" is the expected state there — just wait.
        if (waitForPlayback) return this._wait(s, e, resolve, reject);
        // Waiting only helps if playback is still heading into this range. Every
        // other case is diagnosable right now, so fail immediately with the
        // reason rather than stalling for the deadline.
        const range = this._bufferRange();
        const live = this.liveTime ? this.liveTime() : this.video.currentTime;
        console.log(
          "[YLR] capture miss: want",
          s.toFixed(2) + "→" + e.toFixed(2),
          "| buffer",
          range ? range.first.toFixed(2) + "→" + range.last.toFixed(2) : "(empty)",
          "| tagged from t=",
          this.video.currentTime.toFixed(2),
          "| live t=",
          Number(live).toFixed(2),
          "| paused",
          this.video.paused,
          "| ctx",
          this.ctx && this.ctx.state,
          "| chunks",
          this.chunks.length
        );
        if (range) {
          // Tags come from this.video; if the element that is actually playing has
          // moved on without us, the tap is on a dead element and will never
          // cover anything. Message says "tap" so the caller rebuilds.
          if (isFinite(live) && live - this.video.currentTime > 1.5) {
            return reject(
              new Error("the audio tap is on a stale video element — starring again should re-tap it.")
            );
          }
          if (range.last >= e - 0.4) {
            return reject(
              new Error("that line isn't in the audio buffer — replay it, then star it.")
            );
          }
          if (this.video.paused) {
            return reject(
              new Error("audio is recorded as it plays — play that line, then star it.")
            );
          }
          // Far enough ahead of playback that waiting would just stall.
          if (e > this.video.currentTime + 3) {
            return reject(
              new Error("that line hasn't played yet — play it, then star it.")
            );
          }
        }
        // Caller has a better source for anything not already buffered, so don't
        // sit here waiting for playback to reach the line.
        if (immediate) return reject(new Error("not in the live buffer yet"));
        this._wait(s, e, resolve, reject);
      });
    }

    _wait(s, e, resolve, reject) {
      this._pending.push({
        start: s,
        end: e,
        resolve,
        reject,
        deadline: performance.now() + (e - s) * 1000 + 15000
      });
      // Evaluate the deadline even if no audio chunks arrive (a silent/dead
      // tap would otherwise leave the promise hanging forever).
      setTimeout(() => this._resolvePending(), (e - s) * 1000 + 15500);
    }

    _resolvePending() {
      if (!this._pending.length) return;
      const now = performance.now();
      this._pending = this._pending.filter((p) => {
        if (this._covered(p.start, p.end)) {
          const wav = this._slice(p.start, p.end);
          if (wav) {
            p.resolve(wav);
            return false;
          }
        }
        if (now > p.deadline) {
          const wav = this._slice(p.start, p.end);
          if (wav) p.resolve(wav);
          else
            p.reject(
              new Error(
                this.chunks.length
                  ? "timed out capturing audio — try playing the segment first."
                  : "no audio is reaching the recorder."
              )
            );
          return false;
        }
        return true;
      });
    }
  }

  NS.AudioCapture = AudioCapture;
  NS.encodeWav = encodeWav;
})();
