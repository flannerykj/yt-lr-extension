// A still frame from the video, to go on the card beside the audio.
//
// Whether this works is decided by the same thing that decides the audio: on an
// unprotected stream (YouTube) the frame draws straight onto a canvas, while a
// DRM-protected one taints the canvas and reading it back throws. Rather than
// assume which sites fall where, this tries and reports what happened — a clip
// without a picture is still a clip.
(function () {
  const NS = (window.YLR = window.YLR || {});

  const MAX_WIDTH = 480; // wider than the sidebar, sharp on a retina screen
  const QUALITY = 0.72;

  function blobFrom(canvas) {
    return new Promise((resolve, reject) => {
      // toBlob reports a tainted canvas by throwing; some builds pass null.
      try {
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error("the frame came back empty"))),
          "image/jpeg",
          QUALITY
        );
      } catch (e) {
        reject(e);
      }
    });
  }

  // A protected stream does not always announce itself. Chrome sometimes taints
  // the canvas — reading it back then throws — but sometimes it simply composits
  // black, with no error at all. So the pixels have to be looked at: a frame with
  // no light in it anywhere is not a picture of anything.
  function inspect(ctx, w, h) {
    const data = ctx.getImageData(0, 0, w, h).data;
    let max = 0;
    // Every 89th pixel — a prime stride, so it can't land in step with a
    // repeating pattern and sample the same column every row.
    for (let i = 0; i < data.length; i += 4 * 89) {
      const lum = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
      if (lum > max) max = lum;
    }
    return { max };
  }

  // Resolves with { blob } or { reason } — never rejects, because a missing
  // picture must not stop the clip being saved.
  async function captureFrame(video) {
    if (!video) return { reason: "no video element" };
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return { reason: "no frame decoded yet" };

    const scale = Math.min(1, MAX_WIDTH / w);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext("2d");
    try {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    } catch (e) {
      return { reason: describe(e) };
    }

    let seen;
    try {
      seen = inspect(ctx, canvas.width, canvas.height);
    } catch (e) {
      // getImageData on a tainted canvas throws — the clearest DRM signal there
      // is, and worth catching here rather than letting a black JPEG through.
      return { reason: describe(e) };
    }
    // Darkness only. A flat frame is legitimate content — a title card, a solid
    // background — and rejecting it would lose real pictures.
    if (seen.max < 8)
      return {
        reason:
          "the frame came back black (peak luma " +
          seen.max.toFixed(0) +
          ") — either the video is DRM-protected, which composits black rather " +
          "than refusing, or the picture really was black just then"
      };

    try {
      const blob = await blobFrom(canvas);
      return { blob, width: canvas.width, height: canvas.height };
    } catch (e) {
      return { reason: describe(e) };
    }
  }

  function describe(e) {
    const drm = e && (e.name === "SecurityError" || /tainted|insecure/i.test(e.message || ""));
    return drm ? "the video is DRM-protected, so its frames can't be read" : e.message;
  }

  NS.captureFrame = captureFrame;
})();
