// Renders saved clips. Pure DOM, no chrome APIs and no storage access, so the
// same code serves both consumers: the extension's library page (which pulls
// clips over messaging) and the exported standalone HTML file (which reads them
// from an inline JSON block). Loaded as text and inlined by library.js for the
// export, so it must stay self-contained.
(function () {
  const V = (window.YLRView = {});

  V.CSS = `
:root { color-scheme: dark light; }
* { box-sizing: border-box; }
body {
  margin: 0;
  font: 15px/1.5 Roboto, -apple-system, "Segoe UI", Arial, sans-serif;
  background: #101114;
  color: #f1f1f1;
}
header {
  position: sticky;
  top: 0;
  z-index: 2;
  background: #17181c;
  border-bottom: 1px solid #2a2c33;
  padding: 18px 24px;
}
h1 { margin: 0 0 4px; font-size: 20px; letter-spacing: -0.01em; }
.sub { color: #9aa0a6; font-size: 13px; }
.controls { display: flex; gap: 10px; margin-top: 14px; flex-wrap: wrap; }
input[type="search"], select {
  background: #0f1013;
  color: #f1f1f1;
  border: 1px solid #34363d;
  border-radius: 8px;
  padding: 8px 11px;
  font: inherit;
  font-size: 14px;
}
input[type="search"] { flex: 1; min-width: 220px; }
main { padding: 20px 24px 64px; max-width: 900px; margin: 0 auto; }
.group-title {
  font-size: 13px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #8c93a0;
  margin: 26px 0 10px;
}
.group-title:first-child { margin-top: 0; }
.clip {
  background: #191b1f;
  border: 1px solid #262931;
  border-radius: 12px;
  padding: 14px 16px;
  margin-bottom: 12px;
}
.text { font-size: 17px; line-height: 1.6; margin-bottom: 6px; }
.text mark {
  background: #ffca28;
  color: #14110a;
  border-radius: 3px;
  padding: 1px 4px;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
}
.tr { color: #c8d2df; font-size: 14px; margin-bottom: 8px; }
.meta { color: #83899a; font-size: 12px; margin-bottom: 10px; }
audio { width: 100%; height: 34px; display: block; margin-bottom: 10px; }
.links { display: flex; gap: 16px; font-size: 13px; }
a { color: #64b5f6; text-decoration: none; }
a:hover { text-decoration: underline; }
.empty { color: #83899a; padding: 40px 0; text-align: center; }
.err { color: #ff8a80; }
@media (prefers-color-scheme: light) {
  body { background: #f7f8fa; color: #16181d; }
  header { background: #fff; border-bottom-color: #e2e5ea; }
  input[type="search"], select { background: #fff; color: #16181d; border-color: #d3d7de; }
  .clip { background: #fff; border-color: #e2e5ea; }
  .sub, .meta, .group-title, .empty { color: #5f6672; }
  .tr { color: #38414f; }
}
`;

  function fmt(s) {
    if (typeof s !== "number" || !isFinite(s)) return "?";
    return Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
  }

  function safeName(text) {
    const base = String(text || "clip")
      .slice(0, 40)
      .replace(/[^\p{L}\p{N} _-]/gu, "")
      .trim();
    return (base || "clip") + ".wav";
  }

  function card(clip, showTitle) {
    const el = document.createElement("div");
    el.className = "clip";

    const text = document.createElement("div");
    text.className = "text";
    const mark = document.createElement("mark");
    mark.textContent = clip.text || "";
    text.appendChild(mark);
    el.appendChild(text);

    if (clip.translation) {
      const tr = document.createElement("div");
      tr.className = "tr";
      tr.textContent = clip.translation;
      el.appendChild(tr);
    }

    const meta = document.createElement("div");
    meta.className = "meta";
    const bits = [];
    if (showTitle) bits.push(clip.videoTitle || "Unknown video");
    bits.push(fmt(clip.start) + "–" + fmt(clip.end));
    if (clip.createdAt) bits.push("saved " + new Date(clip.createdAt).toLocaleDateString());
    meta.textContent = bits.join(" · ");
    el.appendChild(meta);

    if (clip.audio) {
      const audio = document.createElement("audio");
      audio.controls = true;
      audio.preload = "none";
      audio.src = clip.audio;
      el.appendChild(audio);
    }

    const links = document.createElement("div");
    links.className = "links";
    if (clip.audio) {
      const dl = document.createElement("a");
      dl.href = clip.audio;
      dl.download = safeName(clip.text);
      dl.textContent = "Download audio";
      links.appendChild(dl);
    }
    if (clip.url) {
      const open = document.createElement("a");
      open.href = clip.url;
      open.target = "_blank";
      open.rel = "noreferrer";
      open.textContent = "Open in video";
      links.appendChild(open);
    }
    el.appendChild(links);
    return el;
  }

  V.render = function (list, clips, opts) {
    const o = opts || {};
    const term = String(o.term || "").trim().toLowerCase();
    const sort = o.sort || "newest";
    let shown = clips.filter(
      (c) =>
        !term ||
        String(c.text || "").toLowerCase().indexOf(term) >= 0 ||
        String(c.translation || "").toLowerCase().indexOf(term) >= 0 ||
        String(c.videoTitle || "").toLowerCase().indexOf(term) >= 0
    );
    if (sort === "oldest") shown = shown.slice().sort((a, b) => a.createdAt - b.createdAt);
    else if (sort === "video")
      shown = shown.slice().sort((a, b) => {
        const t = String(a.videoTitle || "").localeCompare(String(b.videoTitle || ""));
        return t !== 0 ? t : a.start - b.start;
      });
    else shown = shown.slice().sort((a, b) => b.createdAt - a.createdAt);

    list.textContent = "";
    if (!shown.length) {
      const p = document.createElement("div");
      p.className = "empty";
      p.textContent = term ? "Nothing matches that search." : "No clips saved yet.";
      list.appendChild(p);
      return;
    }
    const byVideo = sort === "video";
    let lastGroup = null;
    for (const c of shown) {
      if (byVideo) {
        const group = c.videoTitle || "Unknown video";
        if (group !== lastGroup) {
          const h = document.createElement("div");
          h.className = "group-title";
          h.textContent = group;
          list.appendChild(h);
          lastGroup = group;
        }
      }
      list.appendChild(card(c, !byVideo));
    }
  };

  // Wires the search box and sort control once; callers push clips in as they
  // arrive (the extension page streams them) or all at once (the export).
  V.mount = function (opts) {
    let all = [];
    const paint = () =>
      V.render(opts.list, all, {
        term: opts.search ? opts.search.value : "",
        sort: opts.sort ? opts.sort.value : "newest"
      });
    if (opts.search) opts.search.addEventListener("input", paint);
    if (opts.sort) opts.sort.addEventListener("change", paint);
    paint();
    return {
      set(clips) {
        all = clips.slice();
        paint();
      },
      add(clips) {
        all = all.concat(clips);
        paint();
      },
      count() {
        return all.length;
      }
    };
  };
})();
