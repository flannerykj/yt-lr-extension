// Getting saved clips out, from a content script because IndexedDB lives under
// the site's origin:
//   - "Export" writes a CSV plus the WAV files, all into the download folder,
//     with an audio_file column tying the two together.
//   - The extension's library page pulls clips over messaging, a few at a time,
//     and renders them with src/library-view.js.
(function () {
  const NS = (window.YLR = window.YLR || {});

  function blobToDataUri(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error || new Error("could not read clip audio"));
      fr.readAsDataURL(blob);
    });
  }

  async function toPlain(clip) {
    return {
      text: clip.text || "",
      translation: clip.translation || "",
      videoTitle: clip.videoTitle || "",
      url: clip.url || "",
      start: clip.start,
      end: clip.end,
      createdAt: clip.createdAt,
      audio: clip.audio ? await blobToDataUri(clip.audio) : null,
      thumb: clip.thumb ? await blobToDataUri(clip.thumb) : null
    };
  }

  // ---- CSV + audio export ----
  //
  // One row per clip, plus the WAV files beside it. The audio_file column names
  // the file that lands next to the CSV, so a spreadsheet, an Anki import or a
  // script can line the two up.

  const COLUMNS = [
    "source_text",
    "translation",
    "audio_file",
    "source_image",
    "source_name",
    "date_added",
    "language",
    "url",
    "start",
    "end"
  ];

  // RFC 4180: quote anything containing a delimiter, a quote or a newline, and
  // double the quotes inside.
  function csvCell(value) {
    const text = value == null ? "" : String(value);
    return /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }

  function csvRow(cells) {
    return cells.map(csvCell).join(",");
  }

  function timecode(seconds) {
    const total = Math.max(0, Math.round(seconds || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return (
      String(h).padStart(2, "0") + "-" + String(m).padStart(2, "0") + "-" + String(s).padStart(2, "0")
    );
  }

  // Windows and macOS between them disallow / \ : * ? " < > | and control
  // characters; trailing dots and spaces also cause trouble on Windows.
  function safeFile(text, max) {
    return (
      String(text || "")
        .replace(/[\\/:*?"<>|]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max)
        .replace(/[. ]+$/, "") || "clip"
    );
  }

  // The audio and the still share a stem, so a row's two files sort together and
  // are obviously a pair.
  function clipStem(clip, used) {
    const base = safeFile(clip.text, 48) + " [" + timecode(clip.start) + "]";
    let stem = base;
    for (let n = 2; used.has(stem); n++) stem = base + " (" + n + ")";
    used.add(stem);
    return stem;
  }

  function buildCsv(clips, files) {
    const rows = [csvRow(COLUMNS)];
    clips.forEach((clip, i) => {
      rows.push(
        csvRow([
          clip.text || "",
          clip.translation || "",
          files[i].audio || "",
          files[i].image || "",
          clip.videoTitle || "",
          clip.createdAt ? new Date(clip.createdAt).toISOString() : "",
          clip.language || "",
          clip.url || "",
          (clip.start || 0).toFixed(2),
          (clip.end || 0).toFixed(2)
        ])
      );
    });
    // A byte order mark, so Excel reads it as UTF-8 rather than mangling accents.
    return "\ufeff" + rows.join("\r\n") + "\r\n";
  }

  function downloadBlob(name, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a); // detached anchors don't always download
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  // clips arrive newest-first (db.all sorts by createdAt desc)
  //
  // Everything goes into one .zip, flat: the CSV at the root with the WAVs
  // beside it, so the audio_file column resolves the moment it is unpacked. One
  // download rather than N+1 also avoids the browser throttling a burst and
  // Chrome asking whether the site may save multiple files.
  async function exportLibrary(clips, onProgress) {
    const used = new Set();
    const named = clips.map((clip) => {
      const stem = clipStem(clip, used);
      return {
        audio: clip.audio ? stem + ".wav" : "",
        image: clip.thumb ? stem + ".jpg" : ""
      };
    });
    const stamp = new Date().toISOString().slice(0, 10);
    const zipName = "passage-clips-" + stamp + ".zip";

    const files = [
      { name: "clips.csv", data: buildCsv(clips, named), date: Date.now() }
    ];
    clips.forEach((clip, i) => {
      if (clip.audio) files.push({ name: named[i].audio, data: clip.audio, date: clip.createdAt });
      if (clip.thumb) files.push({ name: named[i].image, data: clip.thumb, date: clip.createdAt });
    });

    const blob = await NS.zip(files, (done, total) => {
      if (onProgress) onProgress(done, total);
    });
    downloadBlob(zipName, blob);
    return {
      rows: clips.length,
      files: files.length - 1,
      audio: named.filter((n) => n.audio).length,
      images: named.filter((n) => n.image).length,
      name: zipName,
      size: blob.size
    };
  }

  // ---- serving the extension's library page ----

  let pullCache = null;

  async function servePull(msg, respond) {
    try {
      if (!msg.from || !pullCache) pullCache = await NS.db.all();
      const slice = pullCache.slice(msg.from || 0, (msg.from || 0) + (msg.count || 4));
      const clips = [];
      for (const c of slice) clips.push(await toPlain(c));
      respond({ total: pullCache.length, origin: location.hostname, clips });
    } catch (e) {
      console.log("[YLR] library pull failed:", e.message);
      respond({ error: e.message });
    }
  }

  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, respond) => {
      if (!msg || msg.type !== "YLR_LIBRARY_PULL") return;
      servePull(msg, respond);
      return true; // responding asynchronously
    });
  }

  NS.exportLibrary = exportLibrary;
})();
