# Architecture

How the pieces fit together: which code runs where, what the adapter contract is,
and every message that crosses a boundary. For *why* the audio side is shaped the
way it is, see [audio-extraction/](audio-extraction/).

## The shape of it

One site-agnostic core drives a per-site adapter. `core.js` owns the sidebar, all
the state, playback sync, starring and the Saved tab, and knows nothing about any
particular site. Everything site-specific — finding subtitle tracks, seeking,
sourcing audio — sits behind `NS.adapter`.

There is no dispatch anywhere in `core.js`. No `if (site === "netflix")`. The
manifest decides which adapter file is injected, and that is the whole mechanism.

```
                    ┌──────────── MAIN world (the page's own realm) ───────────┐
                    │  inject.js  /  netflix-inject.js  /  prime-inject.js     │
                    │  hooks JSON.parse, fetch, XHR · reaches the player API   │
                    └──────────────────────────┬──────────────────────────────┘
                                    window.postMessage
                    ┌──────────────────────────┴──────────────────────────────┐
                    │            ISOLATED world (the content scripts)          │
                    │                                                          │
                    │   youtube.js / netflix.js / prime.js   →  NS.adapter     │
                    │                      ▲                                   │
                    │                      │ the contract                      │
                    │                   core.js                                │
                    │                                                          │
                    │   shared: db · settings · captions · audio · mp4 ·       │
                    │           clip-extractor · library                       │
                    └──────────────────────────┬──────────────────────────────┘
                                  chrome.runtime.sendMessage
                    ┌──────────────────────────┴──────────────────────────────┐
                    │            background.js (service worker)                │
                    │  tabCapture gesture · cross-origin fetches               │
                    └──────────────────────────────────────────────────────────┘
```

## The two worlds

Chrome runs content scripts in an **isolated world**: a separate JavaScript realm
that shares the DOM with the page but has its own globals. This matters constantly.

|  | MAIN world | ISOLATED world |
|---|---|---|
| Sees the page's JS globals (`window.netflix`) | yes | no |
| Can hook the page's `JSON.parse` / `fetch` | yes | no |
| Can call `chrome.runtime`, `chrome.storage` | no | yes |
| Shares the DOM | yes | yes |
| Shares `window.YLR` | no — its own | no — its own |

So each site needs *two* scripts: an injector in the page's realm to intercept
the manifest and reach the player API, and an adapter in the isolated world that
can use extension APIs. They talk only by `postMessage`.

## The namespace

Every isolated-world file opens with:

```js
const NS = (window.YLR = window.YLR || {});
```

`NS` is a local alias for one shared object on `window` — the poor man's `import`,
since content scripts are classic scripts with no module system. Each file wraps
itself in an IIFE and publishes only what it means to:

| File | Publishes |
|---|---|
| `db.js` | `NS.db` — IndexedDB for saved clips |
| `settings.js` | `NS.settings` — `chrome.storage.local` preferences |
| `captions.js` | `NS.isCJK`, `NS.parseJson3`, `NS.parseJson3Cues`, `NS.parseWebVTT`, `NS.parseTTML` |
| `audio.js` | `NS.AudioCapture`, `NS.encodeWav`, `NS.CLIP_PAD` |
| `mp4.js` | `NS.mp4` — fragmented-MP4 index and ADTS remux |
| `clip-extractor.js` | `NS.ClipExtractor` |
| `library.js` | `NS.buildLibraryHtml` |
| `youtube.js` / `netflix.js` / `prime.js` | **`NS.adapter`** |
| `core.js` | nothing — it only consumes |

The MAIN-world injectors use no `NS` at all. They cannot: their `window.YLR`
would be a different object.

`library-view.js` uses a separate namespace, `window.YLRView`, because it also
runs inside the exported standalone HTML file where no `NS` exists.

## Load order

Classic scripts run in manifest order, so the list is a hand-sorted dependency
graph. `core.js` is always last; the adapter always immediately before it.

```
netflix:   db, settings, captions, audio, library, mp4, clip-extractor, netflix.js, core.js
youtube:   db, settings, captions, audio, library, clip-extractor, youtube.js, core.js
prime:     db, settings, captions, audio, library, prime.js, core.js
```

Prime omits `mp4.js` and `clip-extractor.js` — it cannot fetch its audio, so that
machinery would be dead weight. `core.js` copes by feature-detecting, never by
checking the site:

```js
function ensureExtractor() {
  if (!NS.ClipExtractor) return null;               // not loaded here
  if (!adapter.audioSegments && !adapter.audioSource) return null;
  ...
}
```

`core.js` opens with `const adapter = NS.adapter; if (!adapter) return;` — if the
adapter failed to load, the sidebar does nothing rather than half-initialising.

## The adapter contract

Everything below is read off `NS.adapter` by `core.js`.

### Required

| Member | Signature | Contract |
|---|---|---|
| `name` | string | `"youtube"` / `"netflix"` / `"prime"`, for logging and one YouTube-only branch |
| `isWatchPage()` | → bool | **Is the player up right now?** Drives the whole enter/exit lifecycle. Not "is this a video URL" — on Prime the player opens over the detail page without changing the URL, so it checks for a `<video>` with a real duration |
| `currentMediaId()` | → string | Stable id for the thing playing; a change means a different title |
| `getVideo()` | → `HTMLVideoElement` | The feature video, not a trailer or preview |
| `seek(seconds)` | | Seconds are **player time**, already offset-corrected |
| `defaultTrack(tracks)` | → track | Which subtitle track to open with |
| `trackLabel(track)` | → string | Text for the language dropdown |
| `clipUrl(range)` | → string | Deep link stored on a saved clip |
| `onNavigate(cb)` | | Call `cb` whenever the player might have opened or closed |
| `init(handlers)` | | Wire up; see handlers below |
| `requestTracks()` | | Ask the injector to (re-)publish its tracks |
| `loadTrack(track)` | → `Promise<segment[]>` | Fetch and parse a track. A segment is `{start, end, text, words?}` in seconds |
| `setupAudio(capture)` | → `Promise` | Attach an `AudioCapture` to this site's audio source, or throw with a message the user can act on |

### Optional — presence is the feature flag

| Member | Meaning if present |
|---|---|
| `audioSegments(start, end)` | Can fetch and decode audio directly. Returns `{buffer, t0, fallbackBuffer?, playbackOnly?, mime?, describe?}`. **Enables the fetch route and suppresses the tab-capture banner** |
| `audioSource()` / `audioBytes()` | An audio-only stream URL / its bytes, for the replay extractor (YouTube) |
| `audioEnabled()` | → bool. This site uses tab capture, and this is whether it has been granted |
| `resetAudio()` | Drop a dead capture stream |
| `replayable` | `true` = may seek the user's player to re-record a range |
| `syncable` | `true` = the timeline drifts (ads) and needs caption-anchored correction |
| `playerRoot()` | The player container: narrowed by push mode, and scanned for the caption overlay |
| `currentTitle()` | Freshest title, asked for at download time |
| `translationLabel()` | Name of the translation track, for the header |
| `directAudioStatus()` | `{probed, ok, reason}` — surfaced in the banner |

### As implemented

| member | kind | youtube | netflix | prime |
|---|---|---|---|---|
| `audioBytes` | fn | yes | — | — |
| `audioEnabled` | fn | — | yes | yes |
| `audioSegments` | fn | yes | yes | — |
| `audioSource` | fn | yes | — | — |
| `clipUrl` | fn | yes | yes | yes |
| `currentMediaId` | fn | yes | yes | yes |
| `currentTitle` | fn | — | yes | — |
| `defaultTrack` | fn | yes | yes | yes |
| `directAudioStatus` | fn | — | yes | — |
| `getVideo` | fn | yes | yes | yes |
| `init` | fn | yes | yes | yes |
| `isWatchPage` | fn | yes | yes | yes |
| `loadTrack` | fn | yes | yes | yes |
| `name` | string | yes | yes | yes |
| `onNavigate` | fn | yes | yes | yes |
| `playerRoot` | fn | — | yes | yes |
| `replayable` | boolean | — | yes | yes |
| `requestTracks` | fn | yes | yes | yes |
| `resetAudio` | fn | — | yes | yes |
| `seek` | fn | yes | yes | yes |
| `setupAudio` | fn | yes | yes | yes |
| `syncable` | boolean | — | — | yes |
| `trackLabel` | fn | yes | yes | yes |
| `translationLabel` | fn | — | — | yes |

### Handlers — the callbacks core hands back

`adapter.init({ onTracks, onTranslation, onCaptureStream })`

| Handler | Payload | When |
|---|---|---|
| `onTracks` | `{tracks, mediaId, title}` | The injector found subtitle tracks. Creates the sidebar if the player is up, and selects a track when the media is new |
| `onTranslation` | `{mediaId, lang, cues, targetLang?, targetName?}` | The translation track parsed. `lang` is the **source** language, for staleness checks |
| `onCaptureStream` | `MediaStream` | tabCapture was granted; start filling the ring buffer |

## Message types

### MAIN ↔ ISOLATED (`window.postMessage`)

Both realms can see these, so every message is tagged. **`source: "YLR"`** means
injector → adapter; **`source: "YLR-CS"`** means adapter → injector. Receivers
also check `ev.source !== window`.

| Type | Direction | Payload |
|---|---|---|
| `REQUEST_TRACKS` | CS → page | — (YouTube) |
| `TRACKS` | page → CS | `{tracks, videoId, title}` |
| `SELECT_TRACK` | CS → page | `{languageCode, kind}` — makes YouTube's player load a track so it fetches with a valid token |
| `CAPTIONS` | page → CS | `{lang, kind, text}` — raw json3 |
| `TRANSLATION` | page → CS | `{lang, videoId, text}` — json3 with `&tlang=en` |
| `REQUEST_AUDIO_SEGMENTS` / `AUDIO_SEGMENTS` | both | `{start, end}` → `{ok, buffer, t0}` |
| `REQUEST_AUDIO_SOURCE` / `AUDIO_SOURCE` | both | → `{ok, url, mime, from}` |
| `REQUEST_AUDIO_BYTES` / `AUDIO_BYTES` | both | → `{ok, buffer, mime}` |
| `NF_REQUEST_TRACKS` | CS → page | — |
| `NF_TRACKS` | page → CS | `{tracks, audio, mediaId, title, audioTrackId}` |
| `NF_SEEK` | CS → page | `{seconds}` — Netflix needs its player API; setting `currentTime` throws it into an error page |
| `NF_REFRESH_TITLE` | CS → page | Re-read the title now the player has settled |
| `PV_REQUEST_TRACKS` | CS → page | — |
| `PV_TRACKS` | page → CS | `{tracks, manifests, mediaId, title}` |
| `PV_SEEK` | CS → page | `{seconds}` — fallback only; the adapter sets `currentTime` first |

### Content script ↔ service worker (`chrome.runtime`)

| Type | Direction | Purpose |
|---|---|---|
| `ENABLE_CAPTURE` | worker → CS | `{streamId}` or `{error}` after the toolbar click |
| `YLR_FETCH_TEXT` | CS → worker | `{url}` → `{ok, text}`. Subtitle files when the CDN refuses the page origin |
| `YLR_FETCH_BYTES` | CS → worker | `{url, from, to}` → `{ok, body}` base64. Audio ranges, same reason |
| `YLR_LIBRARY_PULL` | library page → CS | `{from, count}` → clips. IndexedDB is per-origin, so the extension page has to ask a content script for them |

The worker also owns the `chrome.action.onClicked` gesture: on a site that needs
tab capture it calls `chrome.tabCapture.getMediaStreamId` and sends the id to the
tab; everywhere else it opens the saved-clips library.

## Lifecycle

`checkLocation()` is the single entry point, called on boot and from
`adapter.onNavigate`:

```
adapter.isWatchPage() false  →  exitPlayer()   sidebar closes, handle hides,
                                               all per-title state dropped
                      true   →  enterPlayer()  sidebar opens, state reset if the
                                               media changed, tracks requested
```

Leaving drops everything — tracks, cues, translation, filter, sync anchor — so
returning re-fetches rather than showing the last title's lines with a stale
subtitle URL.

## Time bases

The pipeline crosses four coordinate systems, and most bugs have been a
conversion between two of them:

| Base | Where |
|---|---|
| **subtitle time** | what the cue file says |
| **player time** | `video.currentTime`; differs by `syncOffset` where ads are stitched in |
| **buffer time** | seconds within a fetched audio range, offset by `t0` |
| **samples** | `(seconds − t0) × sampleRate` |

`core.js` converts subtitle → player at exactly two places (`seekTo` and
`clipFor`); everything below them is player time.

## Adding a site

1. `<site>-inject.js` in the MAIN world: intercept the manifest, `postMessage`
   the tracks out with `source: "YLR"`.
2. `<site>.js` in the isolated world: implement the adapter contract, set
   `NS.adapter`.
3. Add both to `manifest.json` with the shared files, adapter second-to-last and
   `core.js` last; add host permissions and the `web_accessible_resources` match
   (without it `pcm-worklet.js` will not load and audio capture dies).

No change to `core.js` should be needed. If one is, it probably wants to be a new
optional adapter member instead.
