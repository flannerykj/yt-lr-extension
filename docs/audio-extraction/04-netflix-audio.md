# Netflix audio: the pipeline, and where it stands

The element tap is dead on Netflix (DRM), so clips have to come from fetching the
audio ourselves. Confirmed working against a live title; this is what it
involves, and what went wrong on the way.

## The premise, and why it holds

Netflix encrypts the video but, on many titles, ships the **audio unencrypted** —
video is what piracy cares about. That is what makes instant clips possible, and
it is presumably how Language Reactor does it.

**This has been verified for a real title, not assumed.** We successfully read the
audio file's segment index and its codec configuration, and pulled 199 audio
frames out of it. Had it been encrypted we would have hit an `enca` or `sinf` box
and gotten nothing. `ensureIndex()` in `netflix.js` checks for exactly that and
fails loudly if it finds one.

So the bytes are readable. Everything below is about turning them into PCM.

## The pipeline

| Step | Where | Status |
|---|---|---|
| 1. Read the manifest | `netflix-inject.js` — hooks `JSON.parse` | ✅ |
| 2. Pick the track and stream | `netflix.js` — `pickTrack`, `rankedStreams` | ✅ |
| 3. Read the segment index | `mp4.js` — `parseSidx` | ✅ |
| 4. Range-fetch the bytes | `netflix.js` — `fetchRange` | ✅ |
| 5. **Decode to PCM** | `mp4.js` / `clip-extractor.js` | ✅ two routes, see below |
| 6. Slice and encode WAV | `audio.js` — `encodeWav` | ✅ |

### 1. The manifest

`netflix-inject.js` runs in the MAIN world and hooks `JSON.parse`, `fetch` and
`XMLHttpRequest`. Netflix's player manifest carries `timedtexttracks` (the
subtitles) and `audio_tracks` — each with CDN URLs, a codec profile and a bitrate.

Two traps live here, both fixed:

- **Netflix prefetches the next episode's manifest** a few minutes before the
  current one ends, for seamless autoplay. A single last-write-wins cache
  therefore swapped the sidebar onto the next episode's subtitles at the same
  point in every episode. Manifests are now keyed by `movieId`, and only the one
  for the video actually on screen is published — identified from the player's
  `getMovieId()`, or the `movieId` in the playback heartbeat.
- **A title carries several audio tracks per language** (Castilian and Latin
  American Spanish, descriptive audio). Matching on language alone is a coin
  flip. The heartbeat carries an `audioTrackId` and the player answers
  `getAudioTrack()`, so the track is matched by id; language is only a fallback.

### 2. Picking the stream — codec before bitrate

Each track offers several encodings. The naive choice — lowest bitrate, smallest
download — is actively wrong, because Netflix's lowest-bitrate stream is usually
**xHE-AAC**, which is the one codec that does not work here (below).

`streamScore()` ranks plain AAC first, then unknowns, then Dolby, then xHE-AAC,
and only then sorts by bitrate. `ensureStream()` walks that ranking and checks
each candidate's actual codec config before committing.

### 3. The segment index

A fragmented MP4 begins `ftyp | moov | sidx | moof mdat | moof mdat | ...`. The
`sidx` box is a table of subsegments — byte length and duration for each — so a
time range maps onto a byte range.

`ensureIndex()` fetches the first 64 KB (enough for `ftyp`, `moov` and `sidx`
even on a feature-length track), parses the index once, and caches it per
episode. `mp4.js` handles both `sidx` versions, 32- and 64-bit.

### 4. Fetching

Byte ranges go out two ways because deliveries differ: Netflix's OCA URLs can
carry the range in the path (`/range/a-b`), others want a `Range:` header. It
tries the path form, then the header, then hands the request to the service
worker, which is not bound by the page's CORS rules.

A six-second clip costs roughly 100 KB; the index is fetched once per episode.

### 5. Decoding — where it gets hard

`decodeAudioData(bytes)` is the browser's "give me PCM from these bytes". Three
separate things went wrong with it.

**It refuses fragmented MP4.** A streaming file's `moov` contains no sample table
— that information is distributed through the file, in the `trun` box of each
fragment. `decodeAudioData` wants a self-contained file. So `mp4.js` remuxes:
pull the raw AAC frames out of the fragments and give each one an **ADTS** header
(a minimal wrapper that says "here is an AAC frame, this many bytes, this
sample rate"), built from the `esds` AudioSpecificConfig.

**Frames were sliced at the wrong offsets.** Each `trun` declares a `data_offset`
measured from the start of its `moof`; the code assumed samples always began
immediately after the `mdat` header. When they did not, every frame was cut at
the wrong boundary — valid-looking ADTS headers wrapped around garbage. Fixed in
`fragmentSamples()`, with a sequential-read fallback for offsets that point
outside the fetched range.

**The wall: xHE-AAC.** The diagnostic printed `AOT42` — the audio object type for
xHE-AAC, a newer low-bitrate codec. Two independent problems:

- ADTS **cannot express it**. The header describes the codec in a 2-bit field, so
  it can only name four old AAC variants. We were stamping "AAC-LC" onto xHE-AAC
  data.
- `decodeAudioData` will not take xHE-AAC in the container form either.

Codec ranking (step 2) exists to avoid it — but on the title under test, **all
four Spanish streams are xHE-AAC**. There is nothing else to pick.

### The fourth route: a hidden player

Since the bytes are not DRM-protected, they can be put in a Blob and handed to a
hidden `<audio>` element, which uses the **operating system's** decoder rather
than `decodeAudioData`. macOS has supported xHE-AAC since Catalina. The element's
output is tapped through the same worklet the live buffer uses, routed through a
muted gain node so nothing is audible.

Gated on `canPlayType('audio/mp4; codecs="mp4a.40.42"')`, and — because that only
reports what the browser *claims* — verified at runtime: `_firstTag()` waits for
audio to actually arrive and for the clock to advance, and the result is rejected
if it is pure silence.

It records at 1x, so a six-second line takes six seconds. The status bar says
"Capturing audio for this line…" so the wait is explained.

Two timeline bugs cost several rounds here, both worth remembering:

- **A Blob of fragments does not start at time zero.** Each fragment's `tfdt` box
  keeps its absolute presentation time, so the element's clock picks up wherever
  in the film the fragments came from. Asking for second 6 of a blob whose clock
  starts at 2416 produces a timeout, not an error.
- **`seekable` cannot be trusted** to say where that is; it is often still empty
  at `loadedmetadata`. Seeking to a time outside the media then stalls playback
  outright. So playback starts first, and the origin is taken from the first audio
  that actually arrives — one value that doubles as proof the codec is really
  being decoded.

## Where it stands

Steps 1–4 and 6 are working and verified. Step 5 depends on the title:

- **Title ships plain AAC** → remux to ADTS, decode, done. Instant, silent, no
  permission.
- **Title ships only xHE-AAC, and the OS can play it** → hidden-player route.
  Works, but 1x.
- **Title ships only xHE-AAC and the OS cannot play it** → route B is closed.
  Clips fall back to tab capture (one toolbar click, audible replay).

The console reports which of these applies at page load:

```
[YLR] audio stream chosen: heaac-2-dash 128kbps | AAC-LC freq4 2ch
[YLR] AUDIO OK — 412 subsegments, clips can be fetched directly
```

or

```
[YLR] audio stream unusable: xheaac-2-dash — xHE-AAC can't be decoded in the browser
[YLR] AUDIO UNAVAILABLE — no usable audio stream (...)
```

## Confirmed working

Netflix clips save with real audio, verified against a live title. The whole
chain holds: manifest interception, track and stream selection, `sidx` index,
range fetch, decode, WAV.

Which of the two decode routes a given title takes is named in the console at
page load — `audio stream chosen: ... | AAC-LC` for the direct path, or
`can't be remuxed, but this browser can play it` for the hidden player.

## Open questions

**What does Language Reactor do on an xHE-AAC-only title?** Still unresolved, but
now academic — ours works. Its startup logs show only auth and player-version
detection, nothing about audio. The decisive test, if ever wanted, is the Network
tab (see [01-streaming-video.md](01-streaming-video.md)): pause the video, clear
the log, save a clip in LR. Byte-range requests appearing means it is fetching,
and the `v=` parameter would reveal which stream it chose.

**Longevity.** Two things here are properties of Netflix's packaging today, not
guarantees: that audio ships unencrypted, and that a browser-playable codec is
offered. Both are checked at runtime and both fail loudly — `ensureIndex()` names
an `enca`/`sinf` box, `ensureStream()` names a codec it cannot use — and clips
fall back to tab capture rather than breaking.

## A note on method

Much of this was worked out by guessing at binary formats that could not be
observed from here, and several rounds were spent on wrong guesses — including an
early, confident, and wrong claim that DRM made Netflix audio impossible at all.

Two habits came out of that and are worth keeping:

- **Errors carry their evidence.** A decode failure reports
  `[mp4a AOT42/freq3/2ch, 199 frames, 35KB ADTS, fmp4 44KB]`, and a capture
  timeout reports which route failed and what range it actually recorded. Both of
  those messages diagnosed bugs on their own.
- **Build stamps.** `[YLR] netflix-inject loaded — build N` and
  `[YLR] core <version> on <site>`. An already-open tab keeps running the content
  scripts it was injected with, so a stale tab silently wastes a whole debugging
  round otherwise.
