# Docs

The [top-level README](../README.md) covers what the extension does and how to
install it. These are about *why the code looks like this*.

| | |
|---|---|
| [00-architecture.md](00-architecture.md) | How the pieces fit together: the two JavaScript worlds, the `NS` namespace and load order, the full adapter contract, every message type, the player lifecycle, and how to add a site. |
| [audio-extraction/](audio-extraction/) | Getting a few seconds of audio out of a page you don't control — streaming video and DRM, the three capture routes, the AudioWorklet ring buffer, and the Netflix fetch-and-decode pipeline. |

Start with **00** if you are reading the code. Start with **audio-extraction** if
you are trying to understand why getting audio is hard.
