# The audio ring buffer, and the thread it runs on

How `src/pcm-worklet.js` and `src/audio.js` make starring instant.

## What a ring buffer is

A fixed-size store holding only the most recent N items; adding to a full one
discards the oldest. The classic implementation is an array with a write pointer
that wraps around to index 0 — hence "ring".

The point is **bounded memory over unbounded input**. Audio arrives for as long as
you watch, but only the last ~90 seconds is ever wanted. `collections.deque(maxlen=n)`
is the same idea.

Ours is a deque-style variant rather than a true circular array: a list of chunks
with old ones dropped off the front. Same behaviour, and far easier to slice by
timestamp.

## AudioWorklet: a real thread with a real deadline

Browsers run audio on a dedicated, high-priority thread, separate from the main
JavaScript thread. It exists because audio has a **hard deadline** — the sound
card asks for the next block of samples on a fixed schedule, and missing it
produces an audible click. The main thread cannot be trusted with that; it is
busy with layout, page scripts and garbage collection.

If you have used `sounddevice` or PortAudio, it is the same model: you register a
callback and something outside your control calls it on a clock you must keep up
with.

`AudioWorkletGlobalScope` is a **separate JavaScript realm** running on that
thread — its own global scope, with no `window`, no DOM, no `fetch`. When
`audio.js` does:

```js
await this.ctx.audioWorklet.addModule(chrome.runtime.getURL("src/pcm-worklet.js"));
this.node = new AudioWorkletNode(this.ctx, "ylr-pcm");
```

...the worklet file is loaded and evaluated *there*, not on the main thread.
`registerProcessor("ylr-pcm", YLRPCMProcessor)` at the bottom of that file
registers the class under a name; constructing the `AudioWorkletNode` on the main
thread instantiates the processor on the audio thread.

From then on the browser's audio renderer walks the graph once per block and
calls `process()` on every node. You never call it yourself.

### Why 128 samples

128 sample frames is the **render quantum** — the fixed block size the Web Audio
API processes in. Everything in the graph moves in those units. At 48 kHz:

```
128 / 48000 = 2.67 ms per block
48000 / 128 = 375 calls per second
```

So `process()` runs ~375 times a second and each call has under 2.67 ms to
finish. Small on purpose: it sets the graph's minimum latency.

```js
process(inputs, outputs)
// inputs[0]      = first input
// inputs[0][0]   = channel 0, a Float32Array of exactly 128 values
// inputs[0][1]   = channel 1
```

Returning `true` keeps the node alive; returning `false` lets it be collected.

### What the worklet does

```js
const mono = new Float32Array(n);
for (let i = 0; i < n; i++) mono[i] = ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i];

// pass the audio through, or the video goes silent
for (let c = 0; c < output.length; c++) { ... oc[i] = ic[i]; }

this._pending.push(mono);
this._count += n;
if (this._count >= this._target) {          // 4096
  this.port.postMessage(merged, [merged.buffer]);
}
```

Three things worth noticing.

**It downmixes to mono.** Halves the memory and is fine for speech.

**It copies input to output.** A worklet node sits *in* the audio path
(`source → worklet → destination`), not beside it. Skip the copy and you output
silence, muting the video. This is also why `ensureFromElement({ silent: true })`
exists: for the hidden-player route we route the worklet's output through a gain
node set to 0, because the clip should be recorded without the user hearing it.

**It batches to 4096 samples** — ~85 ms, so ~12 messages a second instead of 375.
That 85 ms granularity is why `_covered()` allows 0.4 s of slack when matching a
range; chunk boundaries never line up with subtitle timings.

The second argument to `postMessage` is a **transfer list**:

```js
this.port.postMessage(merged, [merged.buffer]);
```

Normally `postMessage` copies. Passing the `ArrayBuffer` in a transfer list moves
ownership to the receiving thread instead — zero-copy, and `merged` is unusable
afterwards on this side. On a thread with a 2.67 ms budget, not copying 16 KB per
message matters.

### The rules on that thread

No DOM, no `fetch`, no timers, no blocking. Ideally no allocation either, because
a GC pause blows the deadline.

Our worklet does allocate a `Float32Array` per call, which is technically a sin.
It gets away with it because they are small and short-lived and the work per call
is a downmix loop plus a copy. Real DSP would hoist that out.

## The buffer — `audio.js`, `_onChunk`

```js
_onChunk(data) {
  const time = this.video.currentTime;
  this.chunks.push({ time, data });
  this.samples += data.length;
```

**The first line is the important one.** Each batch is tagged with the video's
playback position when it arrived — not wall-clock time. Subtitle timings are in
video time, so finding the audio for `12.4s → 15.9s` becomes a filter over these
tags. It also survives pausing and seeking, which wall-clock stamps would not.

Then eviction, with two rules:

```js
  const cutoff = time - this.bufferSeconds;          // 90 seconds ago
  while (this.chunks.length && this.chunks[0].time < cutoff) {
    this.samples -= this.chunks.shift().data.length;
  }

  // Time-tag eviction does nothing if the tags stop advancing (a dead or
  // stale element tap), so cap the raw sample count too
  const maxSamples = this.bufferSeconds * this.sampleRate * 1.5;
  while (this.chunks.length > 1 && this.samples > maxSamples) {
    this.samples -= this.chunks.shift().data.length;
  }
```

The second rule exists because of a real failure. If the tap ends up on a
`<video>` element that has been detached — which both Netflix and Prime do on
navigation — `currentTime` freezes. The time-based rule then never fires and the
buffer grows without limit until the tab dies. The sample cap is the backstop.

At 48 kHz mono float32, 90 seconds is about **17 MB**.

## Starring a line

```js
_covered(start, end) {
  // do I hold chunks spanning this whole range?
  return min <= start + 0.4 && max >= end - 0.4;
}

_slice(start, end) {
  const selected = this.chunks.filter((c) => c.time >= start && c.time <= end);
  const merged = new Float32Array(total);
  for (const c of selected) { merged.set(c.data, o); o += c.data.length; }
  return encodeWav(merged, this.sampleRate);
}
```

That is the whole trick: **the audio was captured before you clicked**. Starring
is a filter over an array, which is why it is instant on YouTube — no fetch, no
seek, no wait.

One constant does more work than it looks:

```js
const PAD = { lead: 1.0, tail: 0.15 };
```

Subtitle start times land on the first syllable, so cutting at the exact
timestamp shaves the consonant off the front. A second of lead-in fixes it. Note
that `capture()` applies this padding *itself*, so callers that have already
padded a range have to compensate — `playFromBytes()` in `clip-extractor.js` does
exactly that.

## Why this does not rescue Netflix

The buffer only ever holds what came through the tap. On Netflix the element tap
yields silence, so unless tab capture is enabled the buffer is empty and there is
nothing to slice. That is the whole reason for the fetch-and-decode road.
