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

## C. Record the tab

`chrome.tabCapture` hands back a `MediaStream` of whatever the tab is playing out
loud. Since it taps after decoding, DRM is irrelevant.

The costs are real: Chrome only grants it after a click on the extension's
toolbar icon (nothing inside the page can trigger that), it only captures what is
audible *now*, so a line that has not played must be seeked to and replayed
audibly, and it runs at 1x.

**Used by:** Prime Video, and Netflix as a last resort.

## Which site uses what, and why

| | YouTube | Netflix | Prime Video |
|---|---|---|---|
| DRM | no | yes | yes |
| A: element tap | ✅ primary | ✗ silence | ✗ silence |
| B: fetch + decode | ✅ fallback | ✅ primary | ✗ audio encrypted with video |
| C: tab capture | not needed | last resort | ✅ primary |
| Toolbar click needed | no | only for C | yes |

**YouTube** is the easy case and the reason the architecture looks like it does.
No DRM, so the tap works, and the ring buffer makes starring instant.

**Prime Video** encrypts audio and video together, so B is closed and C is the
only route. Hence the banner asking for the toolbar click, and `replayable: true`
on the adapter — starring a line outside the buffer seeks the player back, records
the line as it plays, and restores the playhead.

**Netflix** is the interesting one. The element tap is dead, but the audio ships
unencrypted, so B works — via one of two decode routes depending on the codec the
title uses. That has its own document, since getting there was most of the work.

## How the code chooses

`clipFor()` in `core.js` is the decision point, in preference order:

```js
// 1. Fetch and decode directly, if the adapter offers it and the live tap
//    is not already running with the range in hand.
// 2. Slice out of the live ring buffer.
// 3. Replay the range and record it.
```

The adapter declares its capabilities and core reacts to them, rather than core
knowing about sites:

| Adapter property | Meaning |
|---|---|
| `audioSegments(start, end)` | can fetch and decode — enables route B |
| `audioEnabled()` | uses tab capture, and reports whether it is granted |
| `replayable` | may seek the user's player to re-record a range |
| `syncable` | its timeline drifts (ads) and needs correcting |
| `playerRoot()` | the element to narrow for push mode, and to read captions from |

Adding a site means writing an adapter that answers those, not editing `core.js`.
