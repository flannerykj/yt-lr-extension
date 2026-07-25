// Site-agnostic sidebar: UI, state, playback sync, starring, saved clips.
// Everything site-specific (fetching tracks/captions, seeking, audio source) is
// delegated to NS.adapter, set by youtube.js or netflix.js before this runs.
(function () {
  const NS = (window.YLR = window.YLR || {});
  const adapter = NS.adapter;
  if (!adapter) return;

  const state = {
    tracks: [],
    mediaId: null,
    title: "",
    segments: [],
    translation: [], // cue-level target language, for hover
    track: null,
    activeIndex: -1,
    starred: new Set()
  };

  let capture = null;
  let extractor = null;
  let audioReady = false;
  let els = null;
  let timeupdateBound = false;
  let autoFollow = true; // keep the playing line in view until the user scrolls away
  let activeTab = "subs";
  const scrollPos = { subs: 0, saved: 0 };
  let painted = { seg: -1, word: -1 };
  let interactUntil = 0;
  let followTimer = null;
  let menuRange = null;

  function video() {
    return adapter.getVideo();
  }

  function liveTime() {
    const v = video();
    return v ? v.currentTime : NaN;
  }

  function trackKey(t) {
    return t.languageCode + "|" + (t.kind || "");
  }

  // ---- handlers the adapter calls when data arrives ----

  function onTracks(payload) {
    if (!payload.tracks || !payload.tracks.length) return;
    const isNew = payload.mediaId !== state.mediaId;
    state.tracks = payload.tracks;
    state.mediaId = payload.mediaId;
    state.title = payload.title || document.title;
    ensureUI();
    populateLangSelect();
    bindTimeupdate();
    if (isNew || !state.track) selectTrack(adapter.defaultTrack(payload.tracks));
  }

  function onTranslation(payload) {
    if (payload.mediaId && payload.mediaId !== adapter.currentMediaId()) return;
    if (state.track && state.track.languageCode !== payload.lang) return;
    state.translation = payload.cues || [];
  }

  // Target-language text overlapping a segment's time range. Cues share the
  // source timeline, so match by each cue's start falling inside the span.
  function translationFor(seg) {
    if (!state.translation.length) return "";
    let parts = state.translation
      .filter((c) => c.start >= seg.start - 0.4 && c.start < seg.end)
      .map((c) => c.text);
    if (!parts.length) {
      let best = null;
      for (const c of state.translation) {
        if (c.start <= seg.start && c.end > seg.start) best = c;
      }
      if (best) parts = [best.text];
    }
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  async function selectTrack(track) {
    state.track = track;
    state.translation = [];
    if (els) {
      els.lang.value = trackKey(track);
      els.list.innerHTML = '<div class="ylr-note">Loading subtitles…</div>';
    }
    try {
      const segments = await adapter.loadTrack(track);
      if (state.track !== track) return; // a newer selection superseded this one
      state.segments = segments || [];
      state.activeIndex = -1;
      renderSegments();
    } catch (e) {
      if (els)
        els.list.innerHTML =
          '<div class="ylr-note">Failed to load subtitles: ' + e.message + "</div>";
    }
  }

  // ---- UI ----

  function ensureUI() {
    if (els) return;
    document.documentElement.classList.add("ylr-open");

    const root = document.createElement("div");
    root.id = "ylr-sidebar";
    root.innerHTML = `
      <div class="ylr-head">
        <div class="ylr-tabs">
          <button class="ylr-tab ylr-active" data-tab="subs">Subtitles</button>
          <button class="ylr-tab" data-tab="saved">Saved</button>
        </div>
        <div class="ylr-head-right">
          <button class="ylr-audio" title="Audio capture">🎙</button>
          <select class="ylr-lang" title="Subtitle language"></select>
          <button class="ylr-icon ylr-close" title="Hide">✕</button>
        </div>
      </div>
      <div class="ylr-body">
        <div class="ylr-list" data-panel="subs"></div>
        <div class="ylr-saved" data-panel="saved" hidden></div>
      </div>
      <button class="ylr-jump" hidden>↑ Now playing</button>`;
    document.body.appendChild(root);

    const toggle = document.createElement("button");
    toggle.id = "ylr-toggle";
    toggle.textContent = "字A";
    toggle.title = "Toggle language sidebar";
    document.body.appendChild(toggle);

    const tip = document.createElement("div");
    tip.id = "ylr-tip";
    tip.hidden = true;
    document.body.appendChild(tip);

    const menu = document.createElement("div");
    menu.id = "ylr-menu";
    menu.hidden = true;
    menu.innerHTML = `
      <div class="ylr-menu-sel"></div>
      <div class="ylr-menu-tr"></div>
      <div class="ylr-menu-actions">
        <button class="ylr-menu-save">★ Save audio</button>
        <button class="ylr-menu-close" title="Dismiss">✕</button>
      </div>`;
    document.body.appendChild(menu);

    els = {
      root,
      toggle,
      tip,
      audio: root.querySelector(".ylr-audio"),
      lang: root.querySelector(".ylr-lang"),
      body: root.querySelector(".ylr-body"),
      list: root.querySelector('[data-panel="subs"]'),
      saved: root.querySelector('[data-panel="saved"]'),
      jump: root.querySelector(".ylr-jump"),
      tabs: root.querySelectorAll(".ylr-tab"),
      menu,
      menuSel: menu.querySelector(".ylr-menu-sel"),
      menuTr: menu.querySelector(".ylr-menu-tr"),
      menuSave: menu.querySelector(".ylr-menu-save")
    };
    els.jump.addEventListener("click", jumpToActive);
    els.menuSave.addEventListener("click", onMenuSave);
    menu.querySelector(".ylr-menu-close").addEventListener("click", hideMenu);
    // On document so a drag that ends on the row padding still counts, but only
    // for gestures finishing inside the sidebar.
    document.addEventListener("mouseup", (e) => {
      if (els.menu.contains(e.target) || !els.root.contains(e.target)) return;
      onListMouseUp(e);
    });
    root.addEventListener("pointerdown", () => noteInteraction(2500));
    root.addEventListener("pointermove", () => noteInteraction(1500));
    root.addEventListener("wheel", () => noteInteraction(2000), { passive: true });
    requestAnimationFrame(paintWord);

    // The mic pill is only meaningful where audio needs enabling (Netflix); the
    // element tap on YouTube just works on first star.
    if (adapter.name !== "netflix") els.audio.style.display = "none";
    els.audio.addEventListener("click", () => {
      if (!audioReady)
        alert(
          "To save audio on Netflix, click this extension's icon in the Chrome " +
            "toolbar once — that enables tab-audio capture for this tab. Then star a line."
        );
    });
    updateAudioStatus();

    els.body.addEventListener("scroll", onBodyScroll);

    els.lang.addEventListener("change", () => {
      const t = state.tracks.find((x) => trackKey(x) === els.lang.value);
      if (t) selectTrack(t);
    });
    root.querySelector(".ylr-close").addEventListener("click", () => setOpen(false));
    toggle.addEventListener("click", () =>
      setOpen(!document.documentElement.classList.contains("ylr-open"))
    );
    els.tabs.forEach((tab) =>
      tab.addEventListener("click", () => switchTab(tab.dataset.tab))
    );
  }

  function setOpen(open) {
    document.documentElement.classList.toggle("ylr-open", open);
  }

  function switchTab(name) {
    if (name === activeTab) return;
    hideMenu();
    // Both panels share one scroll container, so hiding one collapses the
    // scroll height and clamps scrollTop — the position has to be stashed and
    // put back by hand.
    scrollPos[activeTab] = els.body.scrollTop;
    activeTab = name;
    els.tabs.forEach((t) => t.classList.toggle("ylr-active", t.dataset.tab === name));
    els.list.hidden = name !== "subs";
    els.saved.hidden = name !== "saved";
    if (name === "saved") {
      els.body.scrollTop = scrollPos.saved || 0;
      renderSaved()
        .then(() => {
          if (activeTab === "saved") els.body.scrollTop = scrollPos.saved || 0;
        })
        .catch(() => {});
    } else if (autoFollow && activeRow()) {
      // They never scrolled away, so being caught up is their place, not
      // whatever offset the line happened to be at when they left.
      jumpToActive();
    } else {
      els.body.scrollTop = scrollPos.subs || 0;
    }
    updateJumpButtons();
  }

  function populateLangSelect() {
    if (!els) return;
    els.lang.innerHTML = "";
    for (const t of state.tracks) {
      const opt = document.createElement("option");
      opt.value = trackKey(t);
      opt.textContent = adapter.trackLabel(t);
      els.lang.appendChild(opt);
    }
  }

  // Word timings come from json3's per-word offsets. Cue-level tracks (Netflix
  // VTT/TTML) have none, so they get an even split across the cue — good enough
  // to highlight and to cut a single word out of.
  function wordsOf(seg) {
    if (seg.words && seg.words.length) return seg.words;
    if (!seg._words) {
      const toks = seg.text.split(/\s+/).filter(Boolean);
      const step = toks.length ? (seg.end - seg.start) / toks.length : 0;
      seg._words = toks.map((t, i) => ({
        text: t,
        start: seg.start + step * i,
        end: seg.start + step * (i + 1)
      }));
    }
    return seg._words;
  }

  function spaceBetween(prev, next) {
    return !!prev && !!next && !NS.isCJK(prev[prev.length - 1]) && !NS.isCJK(next[0]);
  }

  function joinWords(words) {
    let out = "";
    for (const w of words) out += (spaceBetween(out, w.text) ? " " : "") + w.text;
    return out;
  }

  function renderSegments() {
    if (!els) return;
    autoFollow = true;
    els.jump.hidden = true;
    hideMenu();
    painted = { seg: -1, word: -1 };
    if (!state.segments.length) {
      els.list.innerHTML = '<div class="ylr-note">No subtitles found.</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    state.segments.forEach((seg, i) => {
      const row = document.createElement("div");
      row.className = "ylr-seg";
      row.dataset.index = i;

      const play = document.createElement("button");
      play.className = "ylr-play";
      play.textContent = "▶";
      play.title = "Play from here";
      play.addEventListener("click", (e) => {
        e.stopPropagation();
        adapter.seek(seg.start);
      });

      const text = document.createElement("div");
      text.className = "ylr-text";
      const words = wordsOf(seg);
      words.forEach((w, wi) => {
        if (wi && spaceBetween(words[wi - 1].text, w.text))
          text.appendChild(document.createTextNode(" "));
        const span = document.createElement("span");
        span.className = "ylr-w";
        span.textContent = w.text;
        span.dataset.seg = i;
        span.dataset.word = wi;
        text.appendChild(span);
      });

      const star = document.createElement("button");
      star.className = "ylr-star";
      star.textContent = "☆";
      star.title = "Save phrase + audio clip";
      if (state.starred.has(seg.start)) {
        star.classList.add("ylr-starred");
        star.textContent = "★";
      }
      star.addEventListener("click", (e) => {
        e.stopPropagation();
        onStar(seg, star);
      });

      row.addEventListener("mouseenter", () => showTip(row, translationFor(seg)));
      row.addEventListener("mouseleave", hideTip);

      row.appendChild(play);
      row.appendChild(text);
      row.appendChild(star);
      frag.appendChild(row);
    });
    els.list.innerHTML = "";
    els.list.appendChild(frag);
  }

  // ---- playback sync ----

  function bindTimeupdate() {
    if (timeupdateBound) return;
    timeupdateBound = true;
    const v = video();
    if (v) v.addEventListener("timeupdate", tick);
    // Poll as well: Netflix re-creates its <video> element, so a one-time
    // timeupdate binding goes stale. tick() re-queries the element each call.
    setInterval(tick, 250);
  }

  function tick() {
    const v = video();
    if (!v || !state.segments.length) return;
    const t = v.currentTime;
    let idx = -1;
    for (let i = 0; i < state.segments.length; i++) {
      if (state.segments[i].start <= t + 0.05) idx = i;
      else break;
    }
    if (idx !== state.activeIndex) setActive(idx);
  }

  // ---- karaoke ----

  // Driven by rAF rather than the 250ms tick: word highlighting needs to land
  // close to the audio or it reads as lag. Only touches the DOM when the word
  // actually changes.
  function paintWord() {
    requestAnimationFrame(paintWord);
    if (!els || activeTab !== "subs") return;
    const v = video();
    const seg = state.segments[state.activeIndex];
    if (!v || !seg) {
      if (painted.word >= 0) clearPaintedWord();
      return;
    }
    const t = v.currentTime;
    const words = wordsOf(seg);
    let idx = -1;
    for (let i = 0; i < words.length; i++) {
      if (words[i].start <= t + 0.02) idx = i;
      else break;
    }
    if (idx >= 0 && t > words[idx].end + 0.6) idx = -1; // trailing silence
    if (painted.seg === state.activeIndex && painted.word === idx) return;
    clearPaintedWord();
    if (idx < 0) return;
    const span = els.list.querySelector(
      `.ylr-w[data-seg="${state.activeIndex}"][data-word="${idx}"]`
    );
    if (span) span.classList.add("ylr-w-on");
    painted = { seg: state.activeIndex, word: idx };
  }

  function clearPaintedWord() {
    const prev = els.list.querySelector(".ylr-w-on");
    if (prev) prev.classList.remove("ylr-w-on");
    painted = { seg: -1, word: -1 };
  }

  // ---- interaction gating ----

  // Any use of the sidebar suspends auto-scroll, so the list never moves out
  // from under a click or a drag-selection. Following resumes once things go
  // quiet, but only if the playing line is still on screen.
  function noteInteraction(ms = 1500) {
    const until = performance.now() + ms;
    if (until - interactUntil < 250 && followTimer) return; // pointermove churn
    interactUntil = until;
    clearTimeout(followTimer);
    followTimer = setTimeout(settleFollow, ms + 50);
  }

  function interacting() {
    return performance.now() < interactUntil || menuOpen();
  }

  function settleFollow() {
    followTimer = null;
    if (interacting()) {
      const wait = Math.max(300, interactUntil - performance.now() + 50);
      followTimer = setTimeout(settleFollow, wait);
      return;
    }
    if (activeTab !== "subs") return;
    const vis = activeVisibility();
    autoFollow = vis === "visible" || vis === "none";
    updateJumpButtons();
  }

  function activeRow() {
    if (state.activeIndex < 0 || !els) return null;
    return els.list.querySelector(`.ylr-seg[data-index="${state.activeIndex}"]`);
  }

  // "above" = playing line is scrolled off the top (user is reading ahead);
  // "below" = off the bottom (user is behind); "visible" = in the viewport.
  function rowVisibility(row) {
    if (!row) return "none";
    const r = row.getBoundingClientRect();
    const b = els.body.getBoundingClientRect();
    if (r.bottom < b.top + 4) return "above";
    if (r.top > b.bottom - 4) return "below";
    return "visible";
  }

  function activeVisibility() {
    return rowVisibility(activeRow());
  }

  function rowFullyVisible(row) {
    if (!row) return false;
    const r = row.getBoundingClientRect();
    const b = els.body.getBoundingClientRect();
    return r.top >= b.top - 1 && r.bottom <= b.bottom + 1;
  }

  function updateJumpButtons() {
    if (!els) return;
    const vis = activeTab === "subs" ? activeVisibility() : "none";
    els.jump.hidden = vis !== "above" && vis !== "below";
    if (!els.jump.hidden)
      els.jump.textContent = (vis === "above" ? "↑" : "↓") + " Now playing";
  }

  function jumpToActive() {
    const row = activeRow();
    if (row) row.scrollIntoView({ block: "start", behavior: "smooth" });
    autoFollow = true;
    updateJumpButtons();
  }

  // User-initiated scrolling: if they scroll the playing line out of view, stop
  // following and show the jump button; if it comes back into view, resume.
  function onBodyScroll() {
    hideTip();
    hideMenu(); // its anchor just moved
    // A hidden list measures as zero-size, so its rows read as "scrolled away".
    // Only the visible panel's scrolling says anything about following.
    if (activeTab !== "subs") return;
    const vis = activeVisibility();
    autoFollow = vis === "visible" || vis === "none";
    updateJumpButtons();
  }

  function setActive(idx) {
    if (!els) return;
    const prev = els.list.querySelector(".ylr-seg.ylr-current");
    const prevWasOnScreen = !prev || rowVisibility(prev) === "visible";
    if (prev) prev.classList.remove("ylr-current");
    state.activeIndex = idx;
    if (idx < 0) return;
    const row = els.list.querySelector(`.ylr-seg[data-index="${idx}"]`);
    if (!row) return;
    row.classList.add("ylr-current");
    // Once the playing line runs off the edge, pull it back to the top so the
    // upcoming lines fill the panel. Only when the previous line was on screen —
    // otherwise the user has scrolled away and we leave them alone.
    if (
      autoFollow &&
      !interacting() &&
      activeTab === "subs" &&
      prevWasOnScreen &&
      !rowFullyVisible(row)
    )
      row.scrollIntoView({ block: "start" });
    updateJumpButtons();
  }

  // ---- selection / word menu ----

  function menuOpen() {
    return !!els && !els.menu.hidden;
  }

  // Words touched by the selection, in document order — handles a partial word,
  // a phrase inside one line, or a drag across several lines.
  function selectedWords(sel) {
    const range = sel.getRangeAt(0);
    const root =
      range.commonAncestorContainer.nodeType === 1
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
    if (!root || !els.list.contains(root)) return [];
    const hit = [];
    for (const span of root.querySelectorAll(".ylr-w")) {
      if (sel.containsNode(span, true)) hit.push(span); // document order
    }
    // A selection inside a single word has that word as its ancestor, so the
    // query above finds nothing.
    if (!hit.length) {
      const own = root.closest(".ylr-w");
      if (own) hit.push(own);
    }
    return hit.map(wordFor).filter(Boolean);
  }

  function wordFor(span) {
    const seg = state.segments[Number(span.dataset.seg)];
    if (!seg) return null;
    return wordsOf(seg)[Number(span.dataset.word)] || null;
  }

  function openMenu(rect, words) {
    if (!words.length) return;
    let start = Infinity;
    let end = -Infinity;
    for (const w of words) {
      if (w.start < start) start = w.start;
      if (w.end > end) end = w.end;
    }
    const text = joinWords(words);
    menuRange = { start, end, text };
    hideTip();
    els.menuSel.textContent = text;
    const tr = translationFor({ start, end });
    els.menuTr.textContent = tr || "No translation for this line.";
    els.menuTr.classList.toggle("ylr-menu-empty", !tr);
    els.menuSave.disabled = false;
    els.menuSave.textContent = "★ Save audio";
    els.menu.hidden = false;
    positionMenu(rect);
    document.addEventListener("pointerdown", onDocPointerDown, true);
    document.addEventListener("keydown", onMenuKey, true);
    noteInteraction(2500);
  }

  // Anchored just under the selection and clamped inside the viewport, so the
  // pointer only has to travel a few px to reach it — and nothing hides it on
  // the way: it stays until saved, dismissed, or the selection changes.
  function positionMenu(rect) {
    const m = els.menu;
    const sb = els.root.getBoundingClientRect();
    const width = Math.min(340, Math.max(220, sb.width - 24));
    m.style.width = width + "px";
    m.style.left = Math.min(Math.max(8, rect.left), Math.max(8, sb.right - width - 12)) + "px";
    const h = m.offsetHeight;
    let top = rect.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, rect.top - h - 6);
    m.style.top = top + "px";
  }

  function hideMenu() {
    if (!els || els.menu.hidden) return;
    els.menu.hidden = true;
    menuRange = null;
    document.removeEventListener("pointerdown", onDocPointerDown, true);
    document.removeEventListener("keydown", onMenuKey, true);
  }

  function onDocPointerDown(e) {
    if (!els.menu.contains(e.target)) hideMenu();
  }

  function onMenuKey(e) {
    if (e.key === "Escape") hideMenu();
  }

  function onListMouseUp(e) {
    if (!els) return;
    noteInteraction(3000);
    const sel = window.getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed && els.list.contains(sel.anchorNode)) {
      const words = selectedWords(sel);
      if (words.length) {
        // Anchored at the pointer, not at the selection box: a multi-line
        // selection's box is tall, and the menu should appear where the hand
        // already is so it's a few px of travel to the button.
        openMenu(
          { left: e.clientX - 24, right: e.clientX, top: e.clientY - 10, bottom: e.clientY + 4 },
          words
        );
        return;
      }
    }
    const span = e.target.closest && e.target.closest(".ylr-w");
    if (span) {
      const w = wordFor(span);
      if (w) openMenu(span.getBoundingClientRect(), [w]);
    }
  }

  async function onMenuSave() {
    if (!menuRange) return;
    const range = menuRange;
    els.menuSave.disabled = true;
    els.menuSave.textContent = "Saving…";
    try {
      await saveClip(range);
      hideMenu();
      const sel = window.getSelection();
      if (sel) sel.removeAllRanges();
    } catch (err) {
      console.log("[YLR] save selection failed:", err.message);
      els.menuSave.disabled = false;
      els.menuSave.textContent = "★ Save audio";
      alert("Couldn't save audio: " + err.message);
    }
  }

  function showTip(row, text) {
    if (menuOpen()) return;
    if (!text) {
      hideTip();
      return;
    }
    els.tip.textContent = text;
    els.tip.hidden = false;
    const r = row.getBoundingClientRect();
    els.tip.style.top = Math.max(8, r.top) + "px";
    els.tip.style.right = window.innerWidth - r.left + 8 + "px";
  }

  function hideTip() {
    if (els) els.tip.hidden = true;
  }

  function updateAudioStatus() {
    if (!els || !els.audio) return;
    els.audio.classList.toggle("ylr-audio-on", audioReady);
    els.audio.title = audioReady
      ? "Audio capture on"
      : "Audio capture off — click the extension's toolbar icon to enable";
  }

  // ---- capture / save ----

  // Called by the adapter when a tab-capture MediaStream becomes available
  // (Netflix, after the toolbar-icon enable). Starts recording immediately so
  // the ring buffer is filling as you watch and starring is instant.
  function onCaptureStream(stream) {
    console.log("[YLR] core: capture stream received, starting ring buffer");
    if (!capture) capture = new NS.AudioCapture(video(), { bufferSeconds: 90, liveTime });
    capture
      .ensureFromStream(stream)
      .then(() => {
        capture.resume();
        audioReady = true;
        updateAudioStatus();
        console.log("[YLR] core: ring buffer recording");
      })
      .catch((e) => console.log("[YLR] core: ensureFromStream failed:", e.message));
  }

  async function ensureCapture() {
    const v = video();
    if (!v) throw new Error("no video element");
    // Both sites can swap the <video> element out from under us (SPA nav). Chunks
    // are time-tagged from capture.video, so a stale ref stops the buffer dead.
    if (capture && capture.video !== v) {
      if (capture.captureStream) capture.video = v;
      else capture = null;
    }
    if (capture && capture.ready) {
      capture.resume();
      return;
    }
    if (!capture) capture = new NS.AudioCapture(v, { bufferSeconds: 90, liveTime });
    await adapter.setupAudio(capture);
    capture.resume();
    audioReady = true;
    updateAudioStatus();
  }

  function ensureExtractor() {
    if (!NS.ClipExtractor) return null;
    if (!adapter.audioSegments && !adapter.audioSource) return null;
    if (!extractor) extractor = new NS.ClipExtractor(adapter);
    return extractor;
  }

  // The live ring buffer is instant but only holds what has played through the
  // tap. Anything else — a line ahead of the playhead, or one that has already
  // scrolled out of the buffer — is re-recorded from the audio-only stream.
  async function clipFor(seg) {
    try {
      await ensureCapture();
      console.log(
        "[YLR] star: capturing",
        seg.start.toFixed(2),
        "-",
        seg.end.toFixed(2),
        "| ctx",
        capture.ctx && capture.ctx.state
      );
      return await capture.capture(seg.start, seg.end, {
        immediate: !!(adapter.audioSegments && ensureExtractor())
      });
    } catch (e) {
      console.log("[YLR] live buffer miss:", e.message);
      if (/no audio|cancelled|blocked|tap/i.test(e.message)) {
        capture = null;
        audioReady = false;
        if (adapter.resetAudio) adapter.resetAudio();
      }
      const ex = ensureExtractor();
      if (!ex) throw e;
      return await ex.extract(adapter.currentMediaId(), seg.start, seg.end);
    }
  }

  // One save path for all three ways in: starring a chunk, saving a selection,
  // saving a single word. Every clip stores its text, its translation and the
  // audio for exactly its own time range.
  async function saveClip(range) {
    const wav = await clipFor(range);
    console.log("[YLR] got wav", wav && wav.size, "bytes");
    const record = {
      id:
        adapter.currentMediaId() +
        ":" +
        range.start.toFixed(2) +
        "-" +
        range.end.toFixed(2),
      videoId: adapter.currentMediaId(),
      videoTitle: state.title,
      url: adapter.clipUrl(range),
      text: range.text,
      translation: translationFor(range),
      start: range.start,
      end: range.end,
      createdAt: Date.now(),
      audio: wav
    };
    await NS.db.add(record);
    console.log("[YLR] saved", record.id);
    return record;
  }

  async function onStar(seg, starEl) {
    starEl.classList.add("ylr-capturing");
    try {
      await saveClip({ start: seg.start, end: seg.end, text: seg.text });
      state.starred.add(seg.start);
      starEl.classList.add("ylr-starred");
      starEl.textContent = "★";
    } catch (e) {
      console.log("[YLR] star failed:", e.message);
      alert("Couldn't save audio: " + e.message);
    } finally {
      starEl.classList.remove("ylr-capturing");
    }
  }

  // ---- Saved tab ----

  async function renderSaved() {
    els.saved.innerHTML = '<div class="ylr-note">Loading…</div>';
    let clips;
    try {
      clips = await NS.db.all();
    } catch (e) {
      els.saved.innerHTML = '<div class="ylr-note">Could not read saved clips.</div>';
      return;
    }
    if (!clips.length) {
      els.saved.innerHTML =
        '<div class="ylr-note">No saved clips yet. Star a subtitle to save its text and audio.</div>';
      return;
    }
    els.saved.innerHTML = "";
    for (const clip of clips) {
      const card = document.createElement("div");
      card.className = "ylr-clip";

      const text = document.createElement("div");
      text.className = "ylr-clip-text";
      const mark = document.createElement("mark");
      mark.textContent = clip.text;
      text.appendChild(mark);

      const meta = document.createElement("div");
      meta.className = "ylr-clip-meta";
      meta.textContent =
        clip.videoTitle + " · " + formatTime(clip.start) + "–" + formatTime(clip.end);

      const audio = document.createElement("audio");
      audio.controls = true;
      audio.src = URL.createObjectURL(clip.audio);

      const actions = document.createElement("div");
      actions.className = "ylr-clip-actions";

      const dl = document.createElement("a");
      dl.className = "ylr-link";
      dl.textContent = "Download";
      dl.href = audio.src;
      dl.download = safeName(clip.text) + ".wav";

      const open = document.createElement("a");
      open.className = "ylr-link";
      open.textContent = "Open in video";
      open.href = clip.url;
      open.target = "_blank";

      const del = document.createElement("button");
      del.className = "ylr-link ylr-danger";
      del.textContent = "Delete";
      del.addEventListener("click", async () => {
        await NS.db.remove(clip.id);
        state.starred.delete(clip.start);
        card.remove();
        renderSegments();
        tick();
      });

      actions.appendChild(dl);
      actions.appendChild(open);
      actions.appendChild(del);

      if (clip.thumb) {
        const img = document.createElement("img");
        img.className = "ylr-clip-thumb";
        img.src = URL.createObjectURL(clip.thumb);
        card.appendChild(img);
      }
      card.appendChild(text);
      if (clip.translation) {
        const tr = document.createElement("div");
        tr.className = "ylr-clip-tr";
        tr.textContent = clip.translation;
        card.appendChild(tr);
      }
      card.appendChild(meta);
      card.appendChild(audio);
      card.appendChild(actions);
      els.saved.appendChild(card);
    }
  }

  function formatTime(s) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return m + ":" + String(sec).padStart(2, "0");
  }

  function safeName(text) {
    return text.slice(0, 40).replace(/[^\p{L}\p{N} _-]/gu, "").trim() || "clip";
  }

  // ---- boot / navigation ----

  function boot() {
    if (!adapter.isWatchPage()) return;
    ensureUI();
    if (!state.segments.length && els) {
      els.list.innerHTML = '<div class="ylr-note">Loading subtitles…</div>';
    }
    adapter.requestTracks();
  }

  adapter.onNavigate(() => {
    if (adapter.currentMediaId() !== state.mediaId) {
      state.mediaId = null;
      state.track = null;
      state.segments = [];
      state.translation = [];
      state.starred = new Set();
    }
    boot();
  });

  adapter.init({ onTracks, onTranslation, onCaptureStream });

  // YouTube can tap the element directly, so start recording on the first user
  // gesture (audio contexts need one). Then the phrase you star has already been
  // buffered and saving is instant, with no seek/replay. Netflix waits for the
  // toolbar-icon tab-capture instead.
  if (adapter.name === "youtube") {
    const startOnce = () => {
      ensureCapture().catch((e) => console.log("[YLR] early audio init:", e.message));
    };
    window.addEventListener("pointerdown", startOnce, { once: true, capture: true });
  }

  boot();
})();
