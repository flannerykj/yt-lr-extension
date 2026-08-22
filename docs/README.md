# Docs

How the audio side of this extension works, from first principles. Written for
someone comfortable with JavaScript but not with browser media APIs.

The [top-level README](../README.md) covers what the extension does and how to
install it; these are about *why the code looks like this*.

| | |
|---|---|
| [01-streaming-video.md](01-streaming-video.md) | How a `<video>` on Netflix or YouTube actually gets its bytes — manifests, byte ranges, MSE, DRM. Also how to identify those requests in the Network tab. |
| [02-getting-audio.md](02-getting-audio.md) | The three ways to capture audio, which site uses which, and how an adapter declares what it can do. |
| [03-ring-buffer.md](03-ring-buffer.md) | Why starring is instant on YouTube: AudioWorklet, the real-time audio thread, and the rolling PCM buffer. |
| [04-netflix-audio.md](04-netflix-audio.md) | Fetching and decoding Netflix audio directly — the pipeline, the codec wall, and what is still unresolved. |

## The one-paragraph version

Starring a subtitle line saves a WAV of exactly that time range. On YouTube that
is easy: no DRM, so the page can tap the `<video>` element's audio directly, and a
rolling 90-second buffer means the clip is already captured before you click. On
Netflix and Prime the stream is DRM-protected and that tap returns silence, so the
audio has to come from somewhere else — either fetched from the CDN and decoded
by hand (possible on Netflix, because it ships audio unencrypted, and the subject
of most of doc 04), or recorded from the tab's output, which works anywhere but
needs a permission click and runs in real time.
