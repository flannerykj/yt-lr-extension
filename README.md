# Language Sidebar (YouTube + Prime Video + Netflix)

A Language-Reactor-style subtitle sidebar for **YouTube, Prime Video and
Netflix**. Shows subtitles chunked into short lines with precise timings, click a
line to jump to it, hover a line to see the English translation, **download the
whole subtitle track (source + translation) as TXT / SRT / JSON**, and **star a
line to save its text *and* a real audio clip of that exact time range** —
including on the DRM sites, which Language Reactor itself only saves text for.

## Install (unpacked)

1. Go to `chrome://extensions`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder.
4. Open a YouTube video, or a Prime Video / Netflix title with subtitles. A
   sidebar appears on the right; the `字A` button toggles it.

### Filtering the list
The search box at the top of the **Subtitles** tab filters the list to the lines
containing what you type, and marks the matching words. Matching ignores case
*and* accents, so `como` finds `¿Cómo estás?`; `Esc` clears the box. Filtering is
display-only — the playing line, starring, and the whole-track download all still
see the complete track.

### Settings
The **Settings** tab holds a **Highlight the word being spoken** toggle, off by
default. With it off the line being spoken is still shaded, but the word-by-word
karaoke highlight is not painted. The preference lives in `chrome.storage.local`,
so it is shared between YouTube and Prime Video and takes effect immediately in
sidebars already open in other tabs.

### Downloading a whole subtitle track
With the **Subtitles** tab open, the bar under the header shows the line count and
the language pair, plus **TXT / SRT / JSON** buttons. Each downloads *every* line
of the current track with its translation underneath — TXT for reading, SRT as a
bilingual subtitle file, JSON (with `start`/`end` seconds per cue) for feeding
something else. Works on all three sites.

### Prime Video ad breaks and sync
Ad-supported Prime streams stitch ad breaks into the same timeline the `<video>`
element reports, but the subtitle file only covers the feature — so after the
first break the stream's clock runs ahead of the subtitles' clock and the
highlight drifts. The sidebar corrects for this by reading the line the
**player's own caption overlay** is showing, finding it in the loaded track, and
taking the difference. It re-measures on every caption change, so each ad break
is absorbed on the first line after it.

For that to work, **turn Prime's own subtitles on in the same language** as the
sidebar's track. The sync row under the header says what it's doing (`Sync: auto
+210.0s`). If the player's captions are off, use the manual controls in that row
instead: **⌖ Set** then click the line being spoken right now, `−`/`+` to nudge
by 0.25s, **Auto** to hand control back. Manual and automatic sync both also
shift seeking and audio-clip capture, so clicking ▶ still lands on the right
moment.

### Netflix audio: nothing to enable
Netflix ships its **audio unencrypted** alongside Widevine-protected video, so
clips are fetched and decoded straight from the CDN — no permission, no
recording, no interruption to playback. This is how Language Reactor does it, and
it means starring works on any line, including ones you haven't played yet.

The player manifest we already intercept lists the audio streams. `mp4.js` reads
the fragmented-MP4 segment index (`sidx`) out of the first 64 KB, which maps a
time range onto a byte range; that range is fetched, **remuxed to ADTS AAC**,
decoded with `decodeAudioData` and cut. A six-second clip costs about 100 KB, and
the index is fetched once per episode.

The remux matters: `decodeAudioData` refuses a fragmented MP4, because the `moov`
carries no sample tables — the samples are described by the `trun` in each `moof`.
So `mp4.js` reads the sample sizes from the fragments, pulls the raw AAC frames
out of the `mdat`s, and gives each one an ADTS header, using the codec settings
from the `esds` AudioSpecificConfig (unwrapping HE-AAC's SBR layer to its AAC-LC
core). The original container is kept as a fallback in case a stream turns up
that this can't remux.

If the audio ever comes back encrypted (an `enca`/`sinf` box), the sidebar says
so and falls back to the tab-capture path below.

### Prime Video audio: one extra step
Prime encrypts audio and video together, so it can't be tapped from the video
element like YouTube, nor fetched like Netflix. Instead we record the **tab's
audio output** via `chrome.tabCapture`.
To turn that on: **click the extension's toolbar icon once** while on that tab
(this is the gesture Chrome requires — nothing inside the page can grant it). A
banner in the sidebar says so until you do; the 🎙 pill shows the state after
that. Subtitles, seeking, translation and the whole-track download need no click.

Once it's on, starring behaves like YouTube's: a line you have just heard is
already in the rolling buffer and saves instantly. A line that hasn't played, or
one that has scrolled out of the ~90-second buffer, is **replayed** — the player
jumps back, records the line as it goes past, and returns the playhead. You hear
that happen; there is no way around it, because the only readable copy of DRM'd
audio is the one coming out of the speakers.

## How it works

**Architecture**: a shared, site-agnostic `core.js` (sidebar UI, state, starring,
Saved tab) driven by a per-site **adapter** (`youtube.js` / `netflix.js`) that
supplies tracks, captions, seeking, and the audio source.

- **YouTube subtitles**: `inject.js` (MAIN world) makes YouTube's own player load
  a track (so it fetches with the required proof-of-origin token), intercepts the
  `/api/timedtext` request, and re-requests it as **`json3`** (per-word timing).
  `captions.js` re-segments the word stream into short chunks by pause/length.
- **Prime Video subtitles**: `prime-inject.js` (MAIN world) hooks `fetch`, `XHR`
  and `JSON.parse` and deep-scans anything carrying `subtitleUrls` /
  `forcedNarratives` — Prime's *playback resources* document, which lists plain
  TTML/DFXP subtitle files (not DRM'd) per language. The adapter fetches and
  parses them; if Amazon's CDN refuses the page origin, the fetch is retried from
  the service worker, which has host permissions. Cues are used as-is.
- **Netflix subtitles**: `netflix-inject.js` (MAIN world) hooks `JSON.parse` to
  grab Netflix's player manifest, extracts the **WebVTT** track URLs (subtitles
  aren't encrypted), and the adapter fetches + parses them. Cues are used as-is.
- **Translation on hover**: YouTube uses its auto-translate (`&tlang=en`); Netflix
  and Prime use their own real English subtitle track. All align to the source by
  timeline.
- **Seeking**: YouTube and Prime set `video.currentTime`; Netflix uses its player
  API.
- **Player lifecycle**: leaving the player closes the sidebar, hides its handle
  and drops every bit of per-title state (tracks, cues, translation, filter, sync
  anchor); coming back re-requests and re-parses from scratch, so a stale or
  expired subtitle URL can't survive the round trip. On Prime the player opens
  over the detail page without necessarily changing the URL, so "the player is
  up" means a `<video>` with a real duration, not a URL pattern. The audio tap is
  deliberately left running — a `MediaElementSource` can't be created twice for
  the same element.
- **Drift correction** (`adapter.syncable`, Prime only): core keeps a `syncOffset`
  = player time − subtitle time. It finds the player's caption overlay by *what it
  says* rather than by a class name — the one node under the player whose text is
  a line of the track we loaded — then watches it with a `MutationObserver`. A
  line that occurs exactly once in the track re-anchors immediately; a repeated
  line needs a second, agreeing reading. Highlighting, seeking and clip capture
  all go through the offset.
- **Clip audio, in order of preference**: fetch and decode directly (YouTube's own
  segments; Netflix's unencrypted audio streams via `mp4.js`) → slice out of the
  live ring buffer if the tap is already running → play the range again and record
  it (`replayable`, Prime only). Sites in the first group never need tab capture.
- **Audio clips**: `pcm-worklet.js` streams PCM into a ~90-second rolling ring
  buffer (`audio.js`). On YouTube the source is the `<video>` element; on Netflix
  and Prime Video it's the tabCapture stream. Starring slices `[start,end]` out of
  the buffer and encodes a WAV — no re-download. Ranges the buffer doesn't hold
  fall back per site: YouTube decodes the player's own audio segments
  (`clip-extractor.js`), while a `replayable` adapter (Prime) plays the range
  again and records it live, then restores the playhead and the paused state.
  Buffer slices are taken in *player* time, so the ad-drift offset is applied
  there too.
- **Storage**: clips (text, WAV, timings, source URL) go into IndexedDB; the
  **Saved** tab lists them with a player, download, and delete. Audio is optional:
  if every capture route fails the line is still saved with its text, translation
  and timings, and the record keeps the reason in `audioError` so the Saved tab
  and the exported library can show "text only" instead of a broken player.

## Known limitations / caveats

- **Prime Video and Netflix require the one-time toolbar-icon click** to enable
  audio capture (per browser session / tab). Until then, starring shows a hint.
- **Prime Video subtitle tracks are cue-level** (no per-word timings), so the
  karaoke highlight splits each cue evenly across its words, as on Netflix.
- **Automatic ad-drift correction needs the player's own subtitles switched on**
  in the same language as the sidebar's track. Without them the sidebar falls back
  to the manual sync controls, which have to be re-set after each ad break.
- **Prime Video saves audio clips, not video clips** — the WAV path works via
  tabCapture; there is no video-clip export.
- **Replay capture is audible and runs at 1x.** Starring a line far from the
  playhead costs roughly the length of that line, and you hear it play.
- **Playback rate**: clips capture what actually played, so starring at 1.5×
  gives a 1.5× clip. Star at normal speed for natural audio.
- **IndexedDB is under the site origin** (content scripts share the host page's
  DB), so clearing site data clears saved clips. YouTube and Netflix clips live in
  separate origins.
- Subtitles require the video/title to actually have caption tracks.
- **Netflix has no ad-drift correction** (`syncable`), so its ads tier will drift
  the way Prime did before that was added.
- **Netflix prefetches the next episode's manifest** a few minutes before the
  current one ends. `netflix-inject.js` keeps manifests keyed by `movieId` and
  publishes only the one for the video actually on screen — asking the player for
  its current `movieId`, and falling back to the `movieId` in the playback
  heartbeat. Without that, the sidebar silently swapped to the next episode's
  subtitles at the same point in every episode.
- **Netflix clip audio depends on the streams staying unencrypted.** If Netflix
  starts shipping `enca` audio, clips fall back to tab capture and the toolbar
  click comes back. The console names the box it found.
- On Prime, the tracks arrive when the player asks for its playback resources, so
  the sidebar fills in a moment after playback starts (not on the detail page
  alone), and closing the player is noticed within about a second.
- Netflix titles come from the player's own metadata
  (`playerApp` → `videoPlayer.videoMetadata`), matching `currentEpisode` against
  the season/episode lists to build `Series - S02E03 - Episode title`.
  `document.title` is just "Netflix" on the player page, so it's only the last
  resort; the player's title bar (`[data-uia="video-title"]`) sits in between.
- Prime episode titles are assembled as `Series - S01E03 - Episode title` from the
  response's catalog metadata, falling back to the player's own heading and then
  to `document.title` (which names only the season). The console logs the title it
  settled on and the catalog fields it had to work with.
- Not yet tested end-to-end in a live browser in this environment. Parsers are
  verified against real data and all files pass syntax checks; the most likely
  spots to need a tweak on first run are Netflix's manifest field names, the
  tabCapture `getUserMedia` step, and the Netflix seek API.

## Files

| File | World | Role |
|------|-------|------|
| `src/core.js` | isolated | shared sidebar UI, seek, star, Saved tab |
| `src/youtube.js` | isolated | YouTube adapter (json3 via inject, element audio) |
| `src/netflix.js` | isolated | Netflix adapter (WebVTT, tabCapture audio) |
| `src/prime.js` | isolated | Prime Video adapter (TTML/DFXP, tabCapture audio) |
| `src/inject.js` | MAIN | YouTube: drive player, intercept `json3` timedtext |
| `src/netflix-inject.js` | MAIN | Netflix: manifest `JSON.parse` hook, seek API |
| `src/prime-inject.js` | MAIN | Prime: playback-resources hook, seek |
| `src/captions.js` | isolated | `json3` → sentences; WebVTT → cues |
| `src/audio.js` | isolated | ring buffer + WAV; element or stream source |
| `src/pcm-worklet.js` | audio thread | passthrough + PCM tap |
| `src/db.js` | isolated | IndexedDB for saved clips |
| `src/settings.js` | isolated | preferences in `chrome.storage.local` |
| `src/mp4.js` | isolated | fragmented-MP4 index: time range → byte range |
| `src/background.js` | service worker | toolbar click → tabCapture streamId |
