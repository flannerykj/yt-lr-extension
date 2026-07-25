# Language Sidebar (YouTube + Netflix)

A Language-Reactor-style subtitle sidebar for **YouTube and Netflix**. Shows
subtitles chunked into short lines with precise timings, click a line to jump to
it, hover a line to see the English translation, and **star a line to save its
text *and* a real audio clip of that exact time range** — including on Netflix,
which Language Reactor itself only saves text for.

## Install (unpacked)

1. Go to `chrome://extensions`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder.
4. Open a YouTube video or Netflix title with subtitles. A sidebar appears on the
   right; the `字A` button toggles it.

### Netflix audio: one extra step
Netflix audio is DRM-protected, so it can't be tapped from the video element like
YouTube. Instead we record the **tab's audio output** via `chrome.tabCapture`.
To turn that on: **click the extension's toolbar icon once** while on the Netflix
tab (this is the gesture Chrome requires). After that, starring saves audio.
Subtitles, seeking, and translation work with no click.

## How it works

**Architecture**: a shared, site-agnostic `core.js` (sidebar UI, state, starring,
Saved tab) driven by a per-site **adapter** (`youtube.js` / `netflix.js`) that
supplies tracks, captions, seeking, and the audio source.

- **YouTube subtitles**: `inject.js` (MAIN world) makes YouTube's own player load
  a track (so it fetches with the required proof-of-origin token), intercepts the
  `/api/timedtext` request, and re-requests it as **`json3`** (per-word timing).
  `captions.js` re-segments the word stream into short chunks by pause/length.
- **Netflix subtitles**: `netflix-inject.js` (MAIN world) hooks `JSON.parse` to
  grab Netflix's player manifest, extracts the **WebVTT** track URLs (subtitles
  aren't encrypted), and the adapter fetches + parses them. Cues are used as-is.
- **Translation on hover**: YouTube uses its auto-translate (`&tlang=en`); Netflix
  uses its own real English subtitle track. Both align to the source by timeline.
- **Seeking**: YouTube sets `video.currentTime`; Netflix uses its player API.
- **Audio clips**: `pcm-worklet.js` streams PCM into a ~90-second rolling ring
  buffer (`audio.js`). On YouTube the source is the `<video>` element; on Netflix
  it's the tabCapture stream. Starring slices `[start,end]` out of the buffer and
  encodes a WAV — no re-download.
- **Storage**: clips (text, WAV, timings, source URL) go into IndexedDB; the
  **Saved** tab lists them with a player, download, and delete.

## Known limitations / caveats

- **Netflix requires the one-time toolbar-icon click** to enable audio capture
  (per browser session / tab). Until then, starring a Netflix line shows a hint.
- **Playback rate**: clips capture what actually played, so starring at 1.5×
  gives a 1.5× clip. Star at normal speed for natural audio.
- **IndexedDB is under the site origin** (content scripts share the host page's
  DB), so clearing site data clears saved clips. YouTube and Netflix clips live in
  separate origins.
- Subtitles require the video/title to actually have caption tracks.
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
| `src/inject.js` | MAIN | YouTube: drive player, intercept `json3` timedtext |
| `src/netflix-inject.js` | MAIN | Netflix: manifest `JSON.parse` hook, seek API |
| `src/captions.js` | isolated | `json3` → sentences; WebVTT → cues |
| `src/audio.js` | isolated | ring buffer + WAV; element or stream source |
| `src/pcm-worklet.js` | audio thread | passthrough + PCM tap |
| `src/db.js` | isolated | IndexedDB for saved clips |
| `src/background.js` | service worker | toolbar click → tabCapture streamId |
