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

### Downloading a whole subtitle track
With the **Subtitles** tab open, the bar under the header shows the line count and
the language pair, plus **TXT / SRT / JSON** buttons. Each downloads *every* line
of the current track with its translation underneath — TXT for reading, SRT as a
bilingual subtitle file, JSON (with `start`/`end` seconds per cue) for feeding
something else. Works on all three sites.

### Prime Video / Netflix audio: one extra step
Their audio is DRM-protected, so it can't be tapped from the video element like
YouTube. Instead we record the **tab's audio output** via `chrome.tabCapture`.
To turn that on: **click the extension's toolbar icon once** while on that tab
(this is the gesture Chrome requires). After that, starring saves audio.
Subtitles, seeking, translation and the whole-track download need no click.

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
- **Audio clips**: `pcm-worklet.js` streams PCM into a ~90-second rolling ring
  buffer (`audio.js`). On YouTube the source is the `<video>` element; on Netflix
  it's the tabCapture stream. Starring slices `[start,end]` out of the buffer and
  encodes a WAV — no re-download.
- **Storage**: clips (text, WAV, timings, source URL) go into IndexedDB; the
  **Saved** tab lists them with a player, download, and delete.

## Known limitations / caveats

- **Prime Video and Netflix require the one-time toolbar-icon click** to enable
  audio capture (per browser session / tab). Until then, starring shows a hint.
- **Prime Video subtitle tracks are cue-level** (no per-word timings), so the
  karaoke highlight splits each cue evenly across its words, as on Netflix.
- **Prime Video clips are not implemented** — subtitles, translation, seeking and
  the whole-track download work; video-clip export does not.
- **Playback rate**: clips capture what actually played, so starring at 1.5×
  gives a 1.5× clip. Star at normal speed for natural audio.
- **IndexedDB is under the site origin** (content scripts share the host page's
  DB), so clearing site data clears saved clips. YouTube and Netflix clips live in
  separate origins.
- Subtitles require the video/title to actually have caption tracks.
- On Prime, the tracks arrive when the player asks for its playback resources, so
  the sidebar fills in a moment after playback starts (not on the detail page
  alone).
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
| `src/background.js` | service worker | toolbar click → tabCapture streamId |
