# How streaming video actually loads

Background for everything else in this folder. If you know how a `<video>` tag
gets its bytes on YouTube or Netflix, skip to
[02-getting-audio.md](02-getting-audio.md).

## It is not a file download

The intuition from scripting is: `GET some.mp4`, get a file, decode it. Streaming
video does not work that way. A `<video>` element on Netflix or YouTube is never
given a URL at all.

Instead, JavaScript running on the page:

1. Fetches a **manifest** — a JSON or XML document listing every available track:
   video at half a dozen qualities, audio per language and per codec, subtitles
   per language. Each entry carries CDN URLs and a size.
2. Fetches **byte ranges** of those files, a few seconds of playback at a time —
   `Range: bytes=201456-213455`.
3. Pushes those bytes into a buffer attached to the video element, through
   **Media Source Extensions** (MSE). The element plays from that buffer.

This is why quality changes mid-playback without a reload: the page simply starts
requesting the next few seconds from a different track's URL. Closer to a chunked
download loop than to opening a file.

Two consequences matter for this extension:

- **The manifest is the map.** If you can read it, you know every track's URL.
  That is what `netflix-inject.js` and `prime-inject.js` are for.
- **Media is addressed by byte range.** To get six seconds of audio you do not
  download a 50 MB file; you work out which bytes cover those seconds and ask
  for exactly those. Working out *which* bytes is what `mp4.js` does.

## DRM

Netflix and Prime Video encrypt their streams using **EME** (Encrypted Media
Extensions) with Widevine. When content is encrypted, decryption and decoding
happen inside a protected path that page JavaScript cannot read.

The practical effect, and it is absolute: `createMediaElementSource(video)` on a
DRM-protected element returns **silence**. Not an error — silence. That is the
entire point of the mechanism, and there is no way around it from inside a page.

What is *not* absolute is which parts of a title are encrypted. Netflix encrypts
the video and, on many titles, ships the **audio in the clear** — video is what
piracy cares about. That single fact is what makes instant Netflix clips possible
at all. See [04-netflix-audio.md](04-netflix-audio.md).

## Spotting these requests in the Network tab

Useful when comparing against another extension, or checking whether our fetches
are firing.

On Netflix they go to Netflix's own CDN boxes, installed inside ISPs ("OCA" =
Open Connect Appliance):

```
https://ipv6-c003-sjc001-sonic-isp.1.oca.nflxvideo.net/?o=1&v=103&e=1787413...&t=...
```

Identifying marks:

- Host ends in **`.oca.nflxvideo.net`**; the name encodes a location (`sjc001`,
  `lax009`) and the ISP.
- The path is just `/` — everything is in the query string. `e=` is an expiry
  timestamp, `t=` a signed token, `v=` identifies the file.
- **Status 206 Partial Content**, not 200. That is the giveaway for a range
  request.
- Click one, then **Headers → Request Headers**, to see the `Range:` line.

Three different things share that hostname, separated by size and status:

| What | Size | Status | When |
|---|---|---|---|
| Subtitle file | 2 KB – 130 KB | 200 | once, at load |
| **Audio segment** | ~50–200 KB | **206** | every few seconds |
| Video segment | ~1–5 MB | **206** | every few seconds |

YouTube's equivalent goes to `https://rr3---sn-xxxx.googlevideo.com/videoplayback?...`,
though YouTube often passes the range as a `range=` query parameter rather than a
header.

### Isolating one extension's requests

Netflix fetches segments continuously during playback, so the log is a firehose.
To see what a single action causes:

1. Network tab, filter box: `nflxvideo`
2. **Pause the video** and wait a few seconds — the player fills its buffer and
   stops requesting.
3. Clear the log.
4. Perform the action (e.g. save a clip).
5. Anything that appears is attributable to it.

Note that a content script's fetches appear in the page's Network tab, but the
**service worker's** fetches do not — those have their own inspector, reachable
from `chrome://extensions` via the extension's "service worker" link. Several of
our fetches fall back to the worker when CORS blocks the page origin, so check
both.
