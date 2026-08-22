# Three ways to get audio out of a page

Starring a subtitle line saves a WAV of exactly that time range. Getting those
samples is the hard part, and there is no single method that works everywhere.

## A. Tap the media element

The Web Audio API lets you insert yourself into a media element's audio path:

```js
const source = ctx.createMediaElementSource(videoEl);
source.connect(workletNode);
workletNode.connect(ctx.destination);
```

You now receive the decoded PCM samples as they play — plain `Float32Array`s.
`audio.js` keeps the last ~90 seconds of them, so starring a line you have just
heard is a filter over an array in memory. Instant, no network, no permission.

**Requires:** no DRM. On an encrypted stream this yields silence.

**Used by:** YouTube.

## B. Fetch the media yourself and decode it

Read the manifest, find the audio track's CDN URL, fetch the byte range covering
the seconds you want, decode it to PCM, slice, encode a WAV.

Instant, needs no permission, does not disturb playback, and works for lines that
have not played yet. It is what Language Reactor does on Netflix.

**Requires:** the audio bytes to be unencrypted *and* in a form the browser will
decode. Both halves turn out to be load-bearing, and the second needed two
different decode paths — see [04-netflix-audio.md](04-netflix-audio.md).

**Used by:** YouTube (as a secondary path, decoding the segments the player
already downloaded), Netflix (the primary attempt).

## C. Record the tab *(removed)*

`chrome.tabCapture` can hand back a `MediaStream` of whatever the tab is playing
out loud, which sidesteps DRM entirely. It was implemented and then taken out: it
needs a click on the extension's toolbar icon before every session, only captures
what is audible *now* — so a line that has not played must be seeked to and
replayed audibly — and it runs at 1x. Too much friction for what it bought.

Its removal is why Prime Video saves text only.

## Which site uses what, and why

| | YouTube | Netflix | Prime Video |
|---|---|---|---|
| DRM | no | yes | yes |
| A: element tap | ✅ primary | ✗ silence | ✗ silence |
| B: fetch + decode | ✅ fallback | ✅ primary | ❓ untested — see below |
| Audio clips | yes | yes | **no — text only** |

**YouTube** is the easy case and the reason the architecture looks like it does.
No DRM, so the tap works, and the ring buffer makes starring instant.

**Prime Video** currently saves text only. The element tap is dead (DRM), and
route B has **never actually been tested** — the assumption that Amazon encrypts
audio together with video is just that, an assumption. `prime-inject.js` already
collects the DASH manifest URLs out of the playback resources and `prime.js`
probes one at load, logging whether the audio adaptation set carries a
`ContentProtection` element:

```
[YLR] audio probe: 1 audio adaptation set(s), 0 encrypted → direct fetch LOOKS POSSIBLE
```

Nobody has read that line yet. If it says possible, Prime clips are reachable —
see below for what would still need building.

Two things differ from Netflix even then. Netflix's manifest hands over a
**complete audio file per language** with a `sidx` index, so a time range maps to
a byte range in one step. Prime hands over a **DASH `.mpd`**, so the manifest has
to be parsed for the audio adaptation set, its `BaseURL`/`SegmentTemplate` and its
segment timeline before any of `mp4.js` becomes useful. More work, but ordinary
work — the decode half (`sidx`/`stbl` → ADTS → `decodeAudioData`) is already
written and site-agnostic.

**Netflix** is the interesting one. The element tap is dead, but the audio ships
unencrypted, so B works — via one of two decode routes depending on the codec the
title uses. That has its own document, since getting there was most of the work.

## How the code chooses

`clipFor()` in `core.js` is the decision point, in preference order:

```js
// 1. Fetch and decode directly, if the adapter offers it and the live tap
//    is not already running with the range in hand.
// 2. Slice out of the live ring buffer, where the element can be tapped.
// Neither → throw; saveClip stores the line's text and the reason.
```

The adapter declares its capabilities and core reacts to them, rather than core
knowing about sites:

| Adapter property | Meaning |
|---|---|
| `audioSegments(start, end)` | can fetch and decode — enables route B |
| `setupAudio(capture)` | can hand us a tappable media element |
| `syncable` | its timeline drifts (ads) and needs correcting |
| `playerRoot()` | the element to narrow for push mode, and to read captions from |

Adding a site means writing an adapter that answers those, not editing `core.js`.
