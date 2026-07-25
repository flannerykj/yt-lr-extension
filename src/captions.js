// json3 -> sentence segments. Ported from the validated PassageCLI algorithm:
// json3 keeps per-word timing (tOffsetMs), so we flatten events into a word
// stream and re-split it on sentence punctuation / pauses. A word's end is
// taken from the next word's start (capped), never the event duration, because
// a caption's dDurationMs runs until it scrolls off screen.
(function () {
  const NS = (window.YLR = window.YLR || {});

  const TERMINATORS = new Set([".", "?", "!", "。", "？", "！", "…"]);
  // Auto-captions rarely have punctuation, so pauses and these caps do most of
  // the chunking. Lower = smaller chunks. Tune these to taste.
  const MAX_SEGMENT = 8; // seconds
  const MAX_CHARS = 100;
  const MAX_WORD = 1.0;
  const PAUSE = 0.45; // seconds of silence that starts a new chunk

  function isCJK(ch) {
    const o = ch.codePointAt(0);
    return (
      (o >= 0x3000 && o <= 0x303f) ||
      (o >= 0x3400 && o <= 0x4dbf) ||
      (o >= 0x4e00 && o <= 0x9fff) ||
      (o >= 0xf900 && o <= 0xfaff) ||
      (o >= 0xff00 && o <= 0xffef)
    );
  }

  function join(words) {
    let out = "";
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const needsSpace =
        i > 0 && out && !isCJK(out[out.length - 1]) && !isCJK(w[0]);
      out += (needsSpace ? " " : "") + w;
    }
    return out;
  }

  function parseJson3(text) {
    const doc = JSON.parse(text);
    const events = doc.events || [];

    const starts = [];
    for (const e of events) {
      if (e.tStartMs == null || !e.segs) continue;
      const base = e.tStartMs;
      const eventEnd = (base + (e.dDurationMs || 0)) / 1000;

      const items = [];
      for (const s of e.segs) {
        const t = s.utf8 || "";
        if (!t.trim()) continue;
        items.push([t, (base + (s.tOffsetMs || 0)) / 1000]);
      }
      for (let i = 0; i < items.length; i++) {
        const [segText, segStart] = items[i];
        const itemEnd = i + 1 < items.length ? items[i + 1][1] : eventEnd;
        const tokens = segText.split(/\s+/).filter(Boolean);
        if (!tokens.length) continue;
        const step = Math.max(itemEnd - segStart, 0) / tokens.length;
        for (let j = 0; j < tokens.length; j++) {
          starts.push([tokens[j], segStart + step * j]);
        }
      }
    }

    const words = [];
    for (let i = 0; i < starts.length; i++) {
      const start = Math.max(
        starts[i][1],
        words.length ? words[words.length - 1].end : 0
      );
      const next = i + 1 < starts.length ? starts[i + 1][1] : start + MAX_WORD;
      const end = Math.min(Math.max(next, start), start + MAX_WORD);
      words.push({ text: starts[i][0], start, end });
    }

    const segments = [];
    let current = [];
    const flush = () => {
      if (!current.length) return;
      segments.push({
        start: current[0].start,
        end: current[current.length - 1].end,
        text: join(current.map((w) => w.text))
      });
      current = [];
    };
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      current.push(w);
      const terminated = TERMINATORS.has(w.text[w.text.length - 1]);
      const pause = i + 1 < words.length ? words[i + 1].start - w.end : 0;
      const tooLong = w.end - current[0].start >= MAX_SEGMENT;
      const tooManyChars = join(current.map((x) => x.text)).length >= MAX_CHARS;
      if (terminated || pause >= PAUSE || tooLong || tooManyChars) flush();
    }
    flush();

    return segments;
  }

  // Cue-level parse (one entry per event), used for the translated track where
  // we only need text aligned to a time range, not sentence re-segmentation.
  function parseJson3Cues(text) {
    const doc = JSON.parse(text);
    const events = doc.events || [];
    const cues = [];
    for (const e of events) {
      if (e.tStartMs == null || !e.segs) continue;
      const t = e.segs
        .map((s) => s.utf8 || "")
        .join("")
        .replace(/\s+/g, " ")
        .trim();
      if (!t) continue;
      cues.push({
        start: e.tStartMs / 1000,
        end: (e.tStartMs + (e.dDurationMs || 0)) / 1000,
        text: t
      });
    }
    return cues;
  }

  // WebVTT (Netflix subtitles) -> cues. Netflix cues are already clean and
  // sentence-sized and carry no word-level timing, so we use them directly as
  // segments (and as translation cues) without re-segmentation.
  function vttTime(raw) {
    const parts = raw.trim().replace(",", ".").split(":");
    if (parts.length < 2) return null;
    let seconds = 0;
    for (const p of parts) {
      const v = parseFloat(p);
      if (Number.isNaN(v)) return null;
      seconds = seconds * 60 + v;
    }
    return seconds;
  }

  function parseWebVTT(text) {
    const blocks = text.replace(/\r\n/g, "\n").split("\n\n");
    const cues = [];
    for (const block of blocks) {
      const lines = block.split("\n").filter((l) => l.trim());
      const timingIndex = lines.findIndex((l) => l.includes("-->"));
      if (timingIndex < 0) continue;
      const bounds = lines[timingIndex].split("-->");
      if (bounds.length !== 2) continue;
      const start = vttTime(bounds[0]);
      const end = vttTime(bounds[1].trim().split(/\s+/)[0]);
      if (start == null || end == null) continue;
      const body = lines
        .slice(timingIndex + 1)
        .join(" ")
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (body) cues.push({ start, end, text: body });
    }
    return cues;
  }

  // TTML / IMSC (Netflix's imsc1.1 subtitle profile) -> cues. XML, so parsed
  // with DOMParser. Timings may be ticks ("...t" with a ttp:tickRate), seconds
  // ("...s"), or clock time (HH:MM:SS.mmm).
  function ttmlTime(raw, tickRate) {
    if (!raw) return null;
    raw = raw.trim();
    if (raw.endsWith("t")) {
      const ticks = parseFloat(raw.slice(0, -1));
      return tickRate ? ticks / tickRate : null;
    }
    if (raw.endsWith("ms")) return parseFloat(raw.slice(0, -2)) / 1000;
    if (raw.endsWith("s")) return parseFloat(raw.slice(0, -1));
    if (raw.indexOf(":") !== -1) {
      const parts = raw.split(":");
      if (parts.length >= 3) {
        return (
          parseFloat(parts[0]) * 3600 +
          parseFloat(parts[1]) * 60 +
          parseFloat(parts[2])
        );
      }
    }
    const n = parseFloat(raw);
    return Number.isNaN(n) ? null : n;
  }

  function parseTTML(text) {
    const doc = new DOMParser().parseFromString(text, "text/xml");
    if (doc.getElementsByTagName("parsererror").length) return [];
    const tt = doc.getElementsByTagName("tt")[0] || doc.documentElement;
    let tickRate = null;
    if (tt) {
      let tr = tt.getAttribute("ttp:tickRate");
      if (!tr) {
        for (const a of tt.attributes || []) {
          if (/tickRate$/i.test(a.name)) tr = a.value;
        }
      }
      if (tr) tickRate = parseFloat(tr);
    }
    let ps = doc.getElementsByTagNameNS("*", "p");
    if (!ps.length) ps = doc.getElementsByTagName("p");

    const cues = [];
    for (const p of ps) {
      const start = ttmlTime(p.getAttribute("begin"), tickRate);
      const end = ttmlTime(p.getAttribute("end"), tickRate);
      if (start == null || end == null) continue;
      let out = "";
      const walk = (node) => {
        for (const child of node.childNodes) {
          if (child.nodeType === 3) out += child.nodeValue;
          else if (child.nodeType === 1) {
            if (child.localName === "br") out += " ";
            else walk(child);
          }
        }
      };
      walk(p);
      out = out.replace(/\s+/g, " ").trim();
      if (out) cues.push({ start, end, text: out });
    }
    return cues;
  }

  NS.parseJson3 = parseJson3;
  NS.parseJson3Cues = parseJson3Cues;
  NS.parseWebVTT = parseWebVTT;
  NS.parseTTML = parseTTML;
})();
