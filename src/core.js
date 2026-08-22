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
    starred: new Set(),
    savedRanges: [], // every saved clip's span, for marking the words in the list
    translationLang: "en",
    translationName: "English"
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

  // Player time minus subtitle time. Ad-supported Prime streams stitch ad breaks
  // into the same timeline the <video> element reports, but the subtitle file
  // only covers the feature, so the two drift apart by the ads played so far.
  let syncOffset = 0;
  let syncMode = "auto"; // "auto" = follow the player's own captions; "manual"
  let filterQuery = "";
  let filterShown = 0;
  let inPlayer = false;
  let wordHighlight = false; // karaoke highlight, off unless switched on
  let lastAudioOk = null;
  let audioNoteDismissed = false;
  let pushPage = true; // narrow the page instead of covering it
  let hidePlayerCaptions = true; // the sidebar shows the same line
  let resizeTimer = null;
  let lastLayout = "";
  let directAudioFailed = false; // fetching the audio outright stopped working
  let lastDirectError = "";

  function video() {
    return adapter.getVideo();
  }

  function liveTime() {
    const v = video();
    return v ? v.currentTime : NaN;
  }

  // Where we are in the subtitle file, as opposed to in the stream.
  function contentTime() {
    const t = liveTime();
    return Number.isNaN(t) ? t : t - syncOffset;
  }

  function seekTo(contentSeconds) {
    adapter.seek(contentSeconds + syncOffset);
  }

  function trackKey(t) {
    return t.languageCode + "|" + (t.kind || "");
  }

  // ---- handlers the adapter calls when data arrives ----

  function onTracks(payload) {
    if (!payload.tracks || !payload.tracks.length) return;
    if (!inPlayer) {
      if (!adapter.isWatchPage()) return; // a late reply after the player closed
      showPlayerUI();
    }
    const isNew = payload.mediaId !== state.mediaId;
    state.tracks = payload.tracks;
    state.mediaId = payload.mediaId;
    state.title = payload.title || document.title;
    ensureUI();
    populateLangSelect();
    bindTimeupdate();
    if (isNew || !state.track || !state.segments.length)
      selectTrack(adapter.defaultTrack(payload.tracks));
  }

  function onTranslation(payload) {
    if (payload.mediaId && payload.mediaId !== adapter.currentMediaId()) return;
    if (state.track && state.track.languageCode !== payload.lang) return;
    state.translation = payload.cues || [];
    state.translationLang = payload.targetLang || "en";
    state.translationName =
      payload.targetName ||
      (adapter.translationLabel && adapter.translationLabel()) ||
      "English";
    updateSubBar();
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
      els.search.value = "";
      filterQuery = "";
      els.list.innerHTML = '<div class="ylr-note">Loading subtitles…</div>';
    }
    try {
      const segments = await adapter.loadTrack(track);
      if (state.track !== track) return; // a newer selection superseded this one
      state.segments = segments || [];
      state.activeIndex = -1;
      startSync();
      renderSegments();
      loadSavedRanges();
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
          <button class="ylr-tab" data-tab="settings">Settings</button>
        </div>
        <div class="ylr-head-right">
          <button class="ylr-audio" title="Audio capture">🎙</button>
          <select class="ylr-lang" title="Subtitle language"></select>
          <button class="ylr-icon ylr-close" title="Hide">✕</button>
        </div>
      </div>
      <div class="ylr-subbar" hidden>
        <div class="ylr-subbar-row">
          <input type="search" class="ylr-search" placeholder="Filter subtitles…" spellcheck="false">
        </div>
        <div class="ylr-subbar-row">
          <span class="ylr-subbar-count"></span>
          <span class="ylr-subbar-dl">
            <span class="ylr-subbar-label">Download all</span>
            <button class="ylr-link" data-fmt="txt">TXT</button>
            <button class="ylr-link" data-fmt="srt">SRT</button>
            <button class="ylr-link" data-fmt="json">JSON</button>
          </span>
        </div>
        <div class="ylr-subbar-row ylr-sync" hidden>
          <span class="ylr-sync-state"></span>
          <span class="ylr-sync-btns">
            <button class="ylr-link ylr-sync-pick" title="Click this, then click the line being spoken right now">⌖ Set</button>
            <button class="ylr-link" data-nudge="-0.25" title="Subtitles 0.25s later">−</button>
            <button class="ylr-link" data-nudge="0.25" title="Subtitles 0.25s earlier">+</button>
            <button class="ylr-link ylr-sync-reset" title="Go back to following the player's own captions">Auto</button>
          </span>
        </div>
      </div>
      <div class="ylr-audio-note" hidden>
        <span class="ylr-audio-why"></span>
        <button class="ylr-icon ylr-audio-dismiss" title="Dismiss">✕</button>
      </div>
      <div class="ylr-capture-status" hidden>
        <span class="ylr-capture-text"></span>
        <button class="ylr-icon ylr-capture-dismiss" title="Dismiss">✕</button>
      </div>
      <div class="ylr-body">
        <div class="ylr-list" data-panel="subs"></div>
        <div class="ylr-saved" data-panel="saved" hidden></div>
        <div class="ylr-settings" data-panel="settings" hidden>
          <div class="ylr-set-group">
            <label class="ylr-set-check">
              <input id="ylr-set-hidecc" type="checkbox">
              <span>Hide the player's own subtitles</span>
            </label>
            <div class="ylr-set-hint">
              The sidebar already shows the line being spoken, so the overlay on the
              video is a duplicate. It stays loaded either way — the sidebar needs
              its text to keep itself in sync through ad breaks.
            </div>
          </div>
          <div class="ylr-set-group">
            <label class="ylr-set-check">
              <input id="ylr-set-push" type="checkbox">
              <span>Make room for the sidebar</span>
            </label>
            <div class="ylr-set-hint">
              Narrows the page so the sidebar sits beside the video instead of on
              top of it. Turn this off if a site's layout doesn't cope.
            </div>
          </div>
          <div class="ylr-set-group">
            <label class="ylr-set-check">
              <input id="ylr-set-word" type="checkbox">
              <span>Highlight the word being spoken</span>
            </label>
            <div class="ylr-set-hint">
              Paints each word yellow as it is said. With this off, the line being
              spoken is still shaded — only the word-by-word highlight goes away.
            </div>
          </div>
        </div>
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
      audioNote: root.querySelector(".ylr-audio-note"),
      audioWhy: root.querySelector(".ylr-audio-why"),
      captureStatus: root.querySelector(".ylr-capture-status"),
      captureText: root.querySelector(".ylr-capture-text"),
      subbar: root.querySelector(".ylr-subbar"),
      subbarCount: root.querySelector(".ylr-subbar-count"),
      search: root.querySelector(".ylr-search"),
      sync: root.querySelector(".ylr-sync"),
      syncState: root.querySelector(".ylr-sync-state"),
      syncPick: root.querySelector(".ylr-sync-pick"),
      list: root.querySelector('[data-panel="subs"]'),
      saved: root.querySelector('[data-panel="saved"]'),
      settings: root.querySelector('[data-panel="settings"]'),
      setWord: root.querySelector("#ylr-set-word"),
      setPush: root.querySelector("#ylr-set-push"),
      setHideCC: root.querySelector("#ylr-set-hidecc"),
      jump: root.querySelector(".ylr-jump"),
      tabs: root.querySelectorAll(".ylr-tab"),
      menu,
      menuSel: menu.querySelector(".ylr-menu-sel"),
      menuTr: menu.querySelector(".ylr-menu-tr"),
      menuSave: menu.querySelector(".ylr-menu-save")
    };
    els.jump.addEventListener("click", jumpToActive);
    root.querySelector(".ylr-capture-dismiss").addEventListener("click", () =>
      setCaptureStatus("")
    );
    // The mic pill still shows the state, so the banner only has to be seen once.
    root.querySelector(".ylr-audio-dismiss").addEventListener("click", () => {
      audioNoteDismissed = true;
      updateAudioStatus();
    });
    els.search.addEventListener("input", applyFilter);
    els.search.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      els.search.value = "";
      applyFilter();
    });
    els.subbar.querySelectorAll("[data-fmt]").forEach((b) =>
      b.addEventListener("click", () => downloadTranscript(b.dataset.fmt, b))
    );
    els.subbar.querySelectorAll("[data-nudge]").forEach((b) =>
      b.addEventListener("click", () =>
        applyOffset(syncOffset + Number(b.dataset.nudge), "manual")
      )
    );
    els.syncPick.addEventListener("click", () =>
      armPick(!els.list.classList.contains("ylr-picking"))
    );
    root.querySelector(".ylr-sync-reset").addEventListener("click", () => {
      armPick(false);
      lockedAt = 0;
      pendingOffset = null;
      applyOffset(0, "auto");
      startSync();
    });
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

    // The mic pill is only meaningful where audio needs enabling (the DRM sites,
    // which expose audioEnabled); the element tap on YouTube just works on first
    // star.
    if (!adapter.audioEnabled) els.audio.style.display = "none";
    els.audio.addEventListener("click", () => {
      if (!audioReady)
        alert(
          "To save audio here, click this extension's icon in the Chrome toolbar " +
            "once — that enables tab-audio capture for this tab. Then star a line."
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
    initSettingsPanel();
  }

  // ---- Settings tab ----

  function initSettingsPanel() {
    NS.settings.ready.then(showSettings);
    NS.settings.onChange(showSettings);
    els.setWord.addEventListener("change", () => {
      applyWordHighlight(els.setWord.checked);
      NS.settings.set({ wordHighlight: els.setWord.checked }).catch((e) => {
        console.log("[YLR] could not save settings:", e.message);
      });
    });
    els.setHideCC.addEventListener("change", () => {
      hidePlayerCaptions = els.setHideCC.checked;
      applyLayout();
      NS.settings.set({ hidePlayerCaptions }).catch((e) => {
        console.log("[YLR] could not save settings:", e.message);
      });
    });
    els.setPush.addEventListener("change", () => {
      pushPage = els.setPush.checked;
      applyLayout();
      NS.settings.set({ pushPage }).catch((e) => {
        console.log("[YLR] could not save settings:", e.message);
      });
    });
    document.addEventListener("fullscreenchange", applyLayout);
  }

  function showSettings(s) {
    pushPage = s.pushPage !== false;
    hidePlayerCaptions = s.hidePlayerCaptions !== false;
    if (els) {
      els.setWord.checked = !!s.wordHighlight;
      els.setPush.checked = pushPage;
      els.setHideCC.checked = hidePlayerCaptions;
    }
    applyWordHighlight(!!s.wordHighlight);
    applyLayout();
  }

  function applyWordHighlight(on) {
    wordHighlight = on;
    if (!on && els) clearPaintedWord();
  }

  function setOpen(open) {
    document.documentElement.classList.toggle("ylr-open", open);
    applyLayout();
  }

  // Push mode narrows the page rather than sitting on top of it. Suspended in
  // fullscreen, where the video is meant to own the screen and the top layer
  // ignores our layout anyway.
  function applyLayout() {
    const html = document.documentElement;
    const push = pushPage && !document.fullscreenElement;
    html.classList.toggle("ylr-push", push);
    html.classList.toggle("ylr-hidecc", hidePlayerCaptions);
    const open = html.classList.contains("ylr-open");
    // A full-viewport player isn't in normal flow, so narrowing the body does
    // nothing for it. Narrow the container the adapter points at instead — and
    // if there isn't one, the sidebar simply overlays as it used to.
    const root = adapter.playerRoot && adapter.playerRoot();
    if (root) {
      if (push && open)
        root.style.setProperty("width", "calc(100vw - " + SIDEBAR_WIDTH + "px)", "important");
      else root.style.removeProperty("width");
    }
    const key = push + "|" + open + "|" + !!root + "|" + hidePlayerCaptions;
    if (key === lastLayout) return;
    lastLayout = key;
    notifyResize();
  }

  // Players size themselves in JS off a resize event rather than off CSS, so
  // taking the space away isn't enough — they have to be told.
  function notifyResize() {
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => window.dispatchEvent(new Event("resize")), 300);
  }

  const SIDEBAR_WIDTH = 380; // keep in step with --ylr-width in sidebar.css

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
    els.settings.hidden = name !== "settings";
    if (name === "settings") {
      els.body.scrollTop = scrollPos.settings || 0;
    } else if (name === "saved") {
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
    updateSubBar();
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

  // A word counts as saved when its midpoint sits inside a saved clip, so a
  // clip's lead-in padding doesn't drag the preceding word into the highlight.
  function isWordSaved(word) {
    const mid = (word.start + word.end) / 2;
    for (const r of state.savedRanges) {
      if (mid >= r.start - 0.05 && mid <= r.end + 0.05) return true;
    }
    return false;
  }

  function markSaved(range) {
    state.savedRanges.push({ start: range.start, end: range.end });
    if (!els) return;
    state.segments.forEach((seg, si) => {
      if (seg.end < range.start - 0.05 || seg.start > range.end + 0.05) return;
      wordsOf(seg).forEach((w, wi) => {
        if (!isWordSaved(w)) return;
        const span = els.list.querySelector(`.ylr-w[data-seg="${si}"][data-word="${wi}"]`);
        if (span) span.classList.add("ylr-w-saved");
      });
    });
  }

  // Highlights survive reloads and track switches: rebuild the ranges from the
  // clips already in the database for this video.
  async function loadSavedRanges() {
    const id = adapter.currentMediaId();
    if (!id) return;
    let clips;
    try {
      clips = await NS.db.all();
    } catch (e) {
      console.log("[YLR] could not read saved clips:", e.message);
      return;
    }
    if (adapter.currentMediaId() !== id) return;
    state.savedRanges = [];
    state.starred = new Set();
    for (const c of clips) {
      if (c.videoId !== id || typeof c.start !== "number") continue;
      state.savedRanges.push({ start: c.start, end: c.end });
      // ★ means the whole line was saved — a selection that merely begins at the
      // same moment shouldn't light it up.
      const seg = state.segments.find(
        (s) => Math.abs(s.start - c.start) < 0.05 && Math.abs(s.end - c.end) < 0.05
      );
      if (seg) state.starred.add(seg.start);
    }
    renderSegments();
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
    updateSubBar();
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
        seekTo(seg.start);
      });

      const text = document.createElement("div");
      text.className = "ylr-text";
      const words = wordsOf(seg);
      words.forEach((w, wi) => {
        if (wi && spaceBetween(words[wi - 1].text, w.text))
          text.appendChild(document.createTextNode(" "));
        const span = document.createElement("span");
        span.className = isWordSaved(w) ? "ylr-w ylr-w-saved" : "ylr-w";
        span.textContent = w.text;
        span.dataset.seg = i;
        span.dataset.word = wi;
        text.appendChild(span);
      });

      const star = document.createElement("button");
      star.className = "ylr-star";
      const saved = state.starred.has(seg.start);
      star.textContent = saved ? "★" : "☆";
      star.title = saved ? "Remove this saved clip" : "Save phrase + audio clip";
      if (saved) star.classList.add("ylr-starred");
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
    applyFilter();
  }

  // ---- filtering ----

  // Accent-folded as well as lower-cased: someone studying Spanish will type
  // "como" and mean "cómo".
  function fold(str) {
    return (str || "")
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase();
  }

  function foldedText(seg) {
    if (seg._fold == null) seg._fold = fold(seg.text);
    return seg._fold;
  }

  // Rows are hidden rather than removed: every other part of the sidebar
  // addresses them by index (karaoke, the active line, saved-word marking), so
  // the list has to stay whole.
  function applyFilter() {
    if (!els) return;
    filterQuery = fold(els.search.value.trim());
    for (const hit of els.list.querySelectorAll(".ylr-w-hit"))
      hit.classList.remove("ylr-w-hit");
    filterShown = 0;
    const tokens = filterQuery ? filterQuery.split(/\s+/) : [];
    for (const row of els.list.querySelectorAll(".ylr-seg")) {
      const seg = state.segments[Number(row.dataset.index)];
      const match = !filterQuery || (seg && foldedText(seg).indexOf(filterQuery) !== -1);
      row.classList.toggle("ylr-filtered", !match);
      if (!match) continue;
      filterShown++;
      if (!tokens.length) continue;
      for (const span of row.querySelectorAll(".ylr-w")) {
        const word = fold(span.textContent);
        if (tokens.some((t) => word.indexOf(t) !== -1)) span.classList.add("ylr-w-hit");
      }
    }
    updateSubBar();
    updateJumpButtons();
  }

  function isFilteredOut(row) {
    return !!row && row.classList.contains("ylr-filtered");
  }

  // ---- whole-track download ----

  // The Saved tab exports what you starred; this exports the entire subtitle
  // track for what you're watching — every line, with its translation beside it.
  function updateSubBar() {
    if (!els) return;
    const on = activeTab === "subs" && state.segments.length > 0;
    els.subbar.hidden = !on;
    if (!on) return;
    const src = state.track ? adapter.trackLabel(state.track) : "";
    const tr = state.translation.length ? " → " + state.translationName : "";
    const lines = filterQuery
      ? filterShown + " of " + state.segments.length
      : String(state.segments.length);
    els.subbarCount.textContent = lines + " lines · " + src + tr;
    els.sync.hidden = !adapter.syncable;
    if (adapter.syncable) els.syncState.textContent = syncStateText();
  }

  function transcriptRows() {
    return state.segments.map((seg) => ({
      start: seg.start,
      end: seg.end,
      text: seg.text,
      translation: translationFor(seg)
    }));
  }

  function stamp(seconds, msSep) {
    const total = Math.max(0, Math.round((seconds || 0) * 1000));
    const ms = total % 1000;
    const whole = (total - ms) / 1000;
    const h = Math.floor(whole / 3600);
    const m = Math.floor((whole % 3600) / 60);
    const sec = whole % 60;
    return (
      String(h).padStart(2, "0") +
      ":" +
      String(m).padStart(2, "0") +
      ":" +
      String(sec).padStart(2, "0") +
      msSep +
      String(ms).padStart(3, "0")
    );
  }

  function transcriptHeader() {
    return [
      bestKnownTitle(),
      "Source: " + (state.track ? adapter.trackLabel(state.track) : "unknown"),
      "Translation: " +
        (state.translation.length ? state.translationName : "none loaded"),
      adapter.clipUrl({ start: 0, end: 0 }),
      "Exported " + new Date().toLocaleString()
    ];
  }

  function buildTxt(rows) {
    const out = transcriptHeader().map((l) => "# " + l);
    out.push("");
    for (const r of rows) {
      out.push("[" + stamp(r.start, ".") + " --> " + stamp(r.end, ".") + "]");
      out.push(r.text);
      if (r.translation) out.push(r.translation);
      out.push("");
    }
    return out.join("\n");
  }

  // Both languages in one cue, source first — the shape every player and most
  // flashcard importers already understand.
  function buildSrt(rows) {
    const out = [];
    rows.forEach((r, i) => {
      out.push(String(i + 1));
      out.push(stamp(r.start, ",") + " --> " + stamp(r.end, ","));
      out.push(r.text);
      if (r.translation) out.push(r.translation);
      out.push("");
    });
    return out.join("\n");
  }

  function buildJson(rows) {
    return JSON.stringify(
      {
        title: bestKnownTitle(),
        site: adapter.name,
        mediaId: adapter.currentMediaId(),
        url: adapter.clipUrl({ start: 0, end: 0 }),
        source: state.track
          ? { languageCode: state.track.languageCode, name: adapter.trackLabel(state.track) }
          : null,
        translation: state.translation.length
          ? { languageCode: state.translationLang, name: state.translationName }
          : null,
        exportedAt: new Date().toISOString(),
        cues: rows
      },
      null,
      2
    );
  }

  const FORMATS = {
    txt: { build: buildTxt, mime: "text/plain", ext: "txt" },
    srt: { build: buildSrt, mime: "application/x-subrip", ext: "srt" },
    json: { build: buildJson, mime: "application/json", ext: "json" }
  };

  function downloadFile(name, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a); // detached anchors don't always download
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  // Some sites only know the real episode name once their player has settled, so
  // ask for the freshest one at the moment the file is named.
  function bestKnownTitle() {
    if (adapter.currentTitle) {
      const fresh = (adapter.currentTitle() || "").trim();
      const weak = !state.title || /^netflix$/i.test(state.title);
      if (fresh && (weak || fresh.length > state.title.length)) state.title = fresh;
    }
    return state.title;
  }

  function downloadTranscript(fmt, btn) {
    const spec = FORMATS[fmt];
    if (!spec || !state.segments.length) return;
    const label = btn.textContent;
    try {
      const rows = transcriptRows();
      const name =
        safeName(bestKnownTitle() || "subtitles", 120) +
        (state.track ? "." + state.track.languageCode : "") +
        "." +
        spec.ext;
      downloadFile(name, new Blob([spec.build(rows)], { type: spec.mime + ";charset=utf-8" }));
      btn.textContent = "✓";
      setTimeout(() => (btn.textContent = label), 1200);
    } catch (e) {
      console.log("[YLR] transcript export failed:", e.message);
      alert("Couldn't export the subtitles: " + e.message);
      btn.textContent = label;
    }
  }

  // ---- drift correction ----

  // Ad breaks push the stream's clock ahead of the subtitle file's clock, so a
  // fixed offset is wrong by the end of the first break. The player's own
  // caption overlay always knows the truth, so we read the line it is currently
  // showing, find that line in our list, and take the difference. Re-measured on
  // every caption change, so each ad break is absorbed within a line or two.
  let captionNode = null;
  let captionObserver = null;
  let captionIndex = null; // normalized cue text -> [segment index]
  let lastCaptionText = "";
  let pendingOffset = null;
  let lockedAt = 0;
  let scanTimer = null;
  let scanMisses = 0;

  function normText(str) {
    return (str || "")
      .replace(/\s+/g, " ")
      .toLowerCase()
      .replace(/[^\p{L}\p{N} ]/gu, "")
      .trim();
  }

  function buildCaptionIndex() {
    captionIndex = new Map();
    state.segments.forEach((seg, i) => {
      const key = normText(seg.text);
      if (key.length < 4) return; // too short to identify a moment
      if (!captionIndex.has(key)) captionIndex.set(key, []);
      captionIndex.get(key).push(i);
    });
  }

  function playerRoot() {
    if (adapter.playerRoot) {
      const r = adapter.playerRoot();
      if (r) return r;
    }
    const v = video();
    return (v && v.parentElement) || document.body;
  }

  // The overlay element is found by what it says, not by a class name: the one
  // node under the player whose text is a line of the track we loaded.
  // Our own sidebar, tooltip and save menu all repeat the subtitle text, so they
  // must never be mistaken for the player's overlay.
  function isOurs(el) {
    return (
      !!els &&
      (els.root.contains(el) || els.menu.contains(el) || els.tip.contains(el))
    );
  }

  function findCaptionNode() {
    const root = playerRoot();
    if (!root || !captionIndex || !captionIndex.size) return null;
    for (const el of root.querySelectorAll("div, span, p")) {
      if (isOurs(el) || el.children.length > 3) continue;
      const key = normText(el.textContent);
      if (!captionIndex.has(key)) continue;
      // Climb to the outermost node that still says only this line — that's the
      // overlay container, which survives the next cue.
      let node = el;
      while (
        node.parentElement &&
        node.parentElement !== root &&
        !isOurs(node.parentElement) &&
        normText(node.parentElement.textContent) === key
      )
        node = node.parentElement;
      return node;
    }
    return null;
  }

  function measureFromCaption() {
    if (!captionNode || !captionNode.isConnected) {
      stopCaptionWatch();
      return;
    }
    const key = normText(captionNode.textContent);
    if (!key || key === lastCaptionText) return;
    lastCaptionText = key;
    const hits = captionIndex.get(key);
    if (!hits || !hits.length) return;
    const now = liveTime();
    if (Number.isNaN(now)) return;
    let pick = hits[0];
    if (hits.length > 1) {
      // A repeated line ("Sí.") only pins us down if we already know roughly
      // where we are; otherwise it could mean any of a dozen moments.
      let bestGap = Infinity;
      for (const i of hits) {
        const gap = Math.abs(state.segments[i].start - (now - syncOffset));
        if (gap < bestGap) {
          bestGap = gap;
          pick = i;
        }
      }
      if (bestGap > 60) return;
    }
    proposeOffset(now - state.segments[pick].start, hits.length === 1);
  }

  // A line that appears exactly once in the track pins the moment down on its
  // own, so it corrects immediately — that's what gets the sidebar back in step
  // on the first caption after an ad break. A repeated line has to be confirmed
  // by a second reading that agrees.
  function proposeOffset(measured, unique) {
    if (Math.abs(measured - syncOffset) < 0.35) {
      pendingOffset = null;
      const wasCold = !lockedAt;
      lockedAt = Date.now();
      if (wasCold) updateSubBar();
      return; // already in sync
    }
    if (unique || (pendingOffset !== null && Math.abs(pendingOffset - measured) < 0.75)) {
      pendingOffset = null;
      applyOffset(measured, "auto");
      return;
    }
    pendingOffset = measured;
  }

  function applyOffset(value, mode) {
    syncOffset = value;
    syncMode = mode;
    if (mode === "auto") lockedAt = Date.now();
    state.activeIndex = -1;
    tick();
    updateSubBar();
  }

  function startCaptionWatch(node) {
    stopCaptionWatch();
    captionNode = node;
    lastCaptionText = "";
    captionObserver = new MutationObserver(measureFromCaption);
    captionObserver.observe(node, { childList: true, subtree: true, characterData: true });
    measureFromCaption();
    console.log("[YLR] sync: watching the player's caption overlay");
  }

  function stopCaptionWatch() {
    if (captionObserver) captionObserver.disconnect();
    captionObserver = null;
    captionNode = null;
    lastCaptionText = "";
  }

  function scanForCaptions() {
    if (syncMode !== "auto" || !state.segments.length) return;
    if (captionNode && captionNode.isConnected) {
      measureFromCaption(); // MutationObserver can miss a full subtree swap
      return;
    }
    const node = findCaptionNode();
    if (node) {
      startCaptionWatch(node);
      return;
    }
    if (++scanMisses === 20) updateSubBar(); // long enough to say why
  }

  function resetSync() {
    stopCaptionWatch();
    clearInterval(scanTimer);
    scanTimer = null;
    captionIndex = null;
    pendingOffset = null;
    scanMisses = 0;
    lockedAt = 0;
    syncOffset = 0;
    syncMode = "auto";
    if (els) armPick(false);
  }

  function startSync() {
    if (!adapter.syncable) return;
    buildCaptionIndex();
    stopCaptionWatch();
    pendingOffset = null;
    scanMisses = 0;
    if (!scanTimer) scanTimer = setInterval(scanForCaptions, 1000);
  }

  function syncStateText() {
    if (!adapter.syncable) return "";
    const sign = syncOffset >= 0 ? "+" : "−";
    const amount = sign + Math.abs(syncOffset).toFixed(1) + "s";
    if (syncMode === "manual") return "Sync: manual " + amount;
    if (lockedAt) return "Sync: auto " + amount;
    if (scanMisses >= 20)
      return "Sync: turn the player's own subtitles on (same language), or set it below";
    return "Sync: looking for the player's captions…";
  }

  // Manual fallback for when the player's captions are switched off: the user
  // clicks the line being spoken right now and that becomes the anchor.
  function armPick(on) {
    if (!els) return;
    els.list.classList.toggle("ylr-picking", on);
    els.syncPick.classList.toggle("ylr-on", on);
    els.syncPick.textContent = on ? "Click the line" : "⌖ Set";
    if (on) els.list.addEventListener("click", onPickClick, true);
    else els.list.removeEventListener("click", onPickClick, true);
  }

  function onPickClick(e) {
    const row = e.target.closest && e.target.closest(".ylr-seg");
    e.preventDefault();
    e.stopPropagation();
    armPick(false);
    if (!row) return;
    const seg = state.segments[Number(row.dataset.index)];
    const now = liveTime();
    if (!seg || Number.isNaN(now)) return;
    applyOffset(now - seg.start, "manual");
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
    const t = contentTime();
    let idx = -1;
    for (let i = 0; i < state.segments.length; i++) {
      if (state.segments[i].start <= t + 0.05) idx = i;
      else break;
    }
    if (idx !== state.activeIndex) setActive(idx);
    const key = audioAvailable() + "|" + (adapter.audioSegments ? directAudioReason() : "");
    if (key !== lastAudioOk) {
      lastAudioOk = key;
      updateAudioStatus();
    }
  }

  // ---- karaoke ----

  // Driven by rAF rather than the 250ms tick: word highlighting needs to land
  // close to the audio or it reads as lag. Only touches the DOM when the word
  // actually changes.
  function paintWord() {
    requestAnimationFrame(paintWord);
    if (!els || activeTab !== "subs") return;
    if (!wordHighlight) {
      if (painted.word >= 0) clearPaintedWord();
      return;
    }
    const v = video();
    const seg = state.segments[state.activeIndex];
    if (!v || !seg) {
      if (painted.word >= 0) clearPaintedWord();
      return;
    }
    const t = contentTime();
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
    const row = activeRow();
    return isFilteredOut(row) ? "none" : rowVisibility(row);
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
    if (row && !isFilteredOut(row))
      row.scrollIntoView({ block: "start", behavior: "smooth" });
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
      !isFilteredOut(row) &&
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
    if (!els || els.list.classList.contains("ylr-picking")) return;
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
      alert("Couldn't save that selection: " + err.message);
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

  // YouTube taps the element and needs no permission, so it never reports an
  // audioEnabled state and never shows the banner.
  function audioAvailable() {
    return !adapter.audioEnabled || adapter.audioEnabled();
  }

  // Why can't this site give us audio right now? The direct fetch is the
  // preferred route, so if that has failed its reason is the useful one — the
  // tab-capture advice is only the fallback.
  function directAudioReason() {
    const status = adapter.directAudioStatus && adapter.directAudioStatus();
    if (status && status.probed && !status.ok) return status.reason;
    return directAudioFailed ? lastDirectError : "";
  }

  function updateAudioStatus() {
    if (!els || !els.audio) return;
    const ok = audioAvailable();
    const why = adapter.audioSegments ? directAudioReason() : "";
    els.audio.classList.toggle("ylr-audio-on", ok && audioReady);
    els.audio.title = ok
      ? "Audio capture on"
      : "Audio capture off — click the extension's toolbar icon to enable";
    els.audioNote.hidden =
      ok || audioNoteDismissed || !adapter.audioEnabled || (!!adapter.audioSegments && !why);
    if (els.audioNote.hidden) return;
    els.audioWhy.textContent = why
      ? "Couldn't fetch this title's audio: " +
        why +
        " — falling back to recording the tab, which needs the extension's " +
        "toolbar icon clicked once."
      : "Audio capture is off. This site's audio is DRM-protected, so a clip has " +
        "to be recorded from the tab — click the extension's icon in the Chrome " +
        "toolbar once to switch it on.";
  }

  function setCaptureStatus(text) {
    if (!els) return;
    els.captureText.textContent = text || "";
    els.captureStatus.hidden = !text;
  }

  // ---- capture / save ----

  // Called by the adapter when a tab-capture MediaStream becomes available
  // (Netflix, after the toolbar-icon enable). Starts recording immediately so
  // the ring buffer is filling as you watch and starring is instant.
  function onCaptureStream(stream) {
    console.log("[YLR] core: capture stream received, starting ring buffer");
    updateAudioStatus();
    // Granted from the detail page, before playback. Nothing to tag chunks
    // against yet, so leave the buffer for enterPlayer to start.
    if (!video()) return;
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

  // Three ways to get the audio for a range, in order of preference:
  //   1. Fetch and decode it directly (YouTube's own segments, Netflix's
  //      unencrypted audio streams). Instant, needs no permission, doesn't
  //      disturb playback.
  //   2. Slice it out of the live ring buffer, if the tap is running and the
  //      line has already played through it.
  //   3. Play the range again and record it (DRM sites with no fetchable audio).
  async function clipFor(seg) {
    const start = seg.start + syncOffset;
    const end = seg.end + syncOffset;
    const extractor = ensureExtractor();
    const canFetch = !!(extractor && adapter.audioSegments);
    console.log(
      "[YLR] clip " + start.toFixed(1) + "-" + end.toFixed(1) + "s" +
        " | direct fetch: " + (canFetch ? "yes" : "no") +
        " | live tap: " + (audioReady ? "ready" : "off") +
        " | replay: " + (adapter.replayable ? "yes" : "no")
    );

    if (!canFetch || audioReady) {
      try {
        await ensureCapture();
        console.log(
          "[YLR] star: capturing",
          start.toFixed(2),
          "-",
          end.toFixed(2),
          "| ctx",
          capture.ctx && capture.ctx.state
        );
        return await capture.capture(start, end, { immediate: canFetch });
      } catch (e) {
        console.log("[YLR] live buffer miss:", e.message);
        if (/no audio|cancelled|blocked|tap/i.test(e.message)) {
          capture = null;
          audioReady = false;
          // A stale element only needs the capture rebuilt. Tearing down the
          // tab-capture stream as well would cost another toolbar click for
          // nothing — reserve that for a tap that genuinely carries no audio.
          if (adapter.resetAudio && !/tap/i.test(e.message)) adapter.resetAudio();
        }
        if (!extractor && !(adapter.replayable && audioAvailable())) throw e;
      }
    }

    if (extractor) {
      try {
        return await extractor.extract(adapter.currentMediaId(), start, end);
      } catch (e) {
        console.log("[YLR] direct extraction failed:", e.message);
        directAudioFailed = true;
        lastDirectError = e.message;
        updateAudioStatus();
        if (!(adapter.replayable && audioAvailable())) throw e;
      }
    }

    if (adapter.replayable && audioAvailable()) return await replayCapture(seg);
    throw new Error("no way to capture audio for that line");
  }

  // Everything the live buffer holds is what has already played through the tap.
  // On a DRM site there is no second source to decode, so the only way to get a
  // line that hasn't played (or has scrolled out of the buffer) is to play it:
  // jump there, record it as it goes past, then put the playhead back.
  async function replayCapture(range) {
    await ensureCapture();
    const v = video();
    if (!v) throw new Error("the player isn't open");
    const start = range.start + syncOffset;
    const end = range.end + syncOffset;
    const back = v.currentTime;
    const wasPaused = v.paused;
    setCaptureStatus(
      "Replaying " + formatTime(range.start) + "–" + formatTime(range.end) + " to record it…"
    );
    capture.reset(); // stale tags must not satisfy the range we're about to fill
    adapter.seek(Math.max(0, start - NS.CLIP_PAD.lead - 0.5));
    try {
      return await capture.capture(start, end, {
        waitForPlayback: true,
        label: "tab capture"
      });
    } finally {
      setCaptureStatus("");
      adapter.seek(back);
      if (wasPaused) setTimeout(() => v.pause(), 250);
    }
  }

  // The text, translation and timings are the point; the audio is a bonus. If
  // capture fails the line is still saved, flagged so the Saved tab can say why.
  async function saveClip(range) {
    let wav = null;
    let audioError = null;
    // Some routes record in real time, so say so rather than leaving the star
    // pulsing with no explanation. Only if it actually takes a moment.
    const slow = setTimeout(
      () => setCaptureStatus("Capturing audio for this line…"),
      1200
    );
    try {
      wav = await withTimeout(clipFor(range), 45000, "audio capture timed out");
      console.log("[YLR] got wav", wav && wav.size, "bytes");
    } catch (e) {
      audioError = e.message || String(e);
      console.log("[YLR] no audio for this clip:", audioError);
    } finally {
      clearTimeout(slow);
      if (!audioError) setCaptureStatus("");
    }
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
      audio: wav,
      audioError
    };
    await NS.db.add(record);
    // One line per save, so the outcome is findable without reading the whole log.
    console.log(
      "[YLR] SAVED " +
        JSON.stringify((range.text || "").slice(0, 40)) +
        " " +
        range.start.toFixed(1) +
        "-" +
        range.end.toFixed(1) +
        "s | audio: " +
        (audioError ? "FAILED — " + audioError : Math.round((wav.size || 0) / 1024) + " KB")
    );
    markSaved(range);
    if (audioError) flashStatus("Saved text only — no audio: " + audioError, 0);
    return record;
  }

  function withTimeout(promise, ms, message) {
    let timer = null;
    return Promise.race([
      promise.finally(() => clearTimeout(timer)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      })
    ]);
  }

  let statusTimer = null;
  // ms = 0 keeps it up until dismissed — a failure reason is worth reading.
  function flashStatus(text, ms = 6000) {
    setCaptureStatus(text);
    clearTimeout(statusTimer);
    if (ms) statusTimer = setTimeout(() => setCaptureStatus(""), ms);
  }

  async function onStar(seg, starEl) {
    if (state.starred.has(seg.start)) return unstar(seg, starEl);
    starEl.classList.add("ylr-capturing");
    try {
      await saveClip({ start: seg.start, end: seg.end, text: seg.text });
      state.starred.add(seg.start);
      starEl.classList.add("ylr-starred");
      starEl.textContent = "★";
      starEl.title = "Remove this saved clip";
    } catch (e) {
      console.log("[YLR] star failed:", e.message);
      alert("Couldn't save that line: " + e.message);
    } finally {
      starEl.classList.remove("ylr-capturing");
    }
  }

  // Un-starring throws the clip away. Matched on the line's own span, so a
  // selection saved from inside the same line is left alone.
  async function unstar(seg, starEl) {
    starEl.classList.add("ylr-capturing");
    try {
      const id = adapter.currentMediaId();
      const clips = await NS.db.all();
      const doomed = clips.filter(
        (c) =>
          c.videoId === id &&
          Math.abs(c.start - seg.start) < 0.05 &&
          Math.abs(c.end - seg.end) < 0.05
      );
      for (const clip of doomed) await NS.db.remove(clip.id);
      state.starred.delete(seg.start);
      console.log("[YLR] removed", doomed.length, "clip(s) at", seg.start.toFixed(1) + "s");
      await loadSavedRanges(); // re-renders with the star and word marks cleared
      flashStatus(doomed.length ? "Removed from Saved." : "Nothing saved for that line.");
    } catch (e) {
      console.log("[YLR] unstar failed:", e.message);
      alert("Couldn't remove that clip: " + e.message);
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
    els.saved.appendChild(savedToolbar(clips));
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

      const audio = clip.audio ? document.createElement("audio") : null;
      if (audio) {
        audio.controls = true;
        audio.src = URL.createObjectURL(clip.audio);
      }

      const actions = document.createElement("div");
      actions.className = "ylr-clip-actions";

      const dl = document.createElement("a");
      dl.className = "ylr-link";
      dl.textContent = "Download";
      if (audio) {
        dl.href = audio.src;
        dl.download = safeName(clip.text) + ".wav";
      }

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
        card.remove();
        await loadSavedRanges(); // re-renders with the highlight gone
        tick();
      });

      if (audio) actions.appendChild(dl);
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
      if (audio) card.appendChild(audio);
      else {
        const noAudio = document.createElement("div");
        noAudio.className = "ylr-clip-noaudio";
        noAudio.textContent = "Text only — " + (clip.audioError || "audio wasn't captured");
        card.appendChild(noAudio);
      }
      card.appendChild(actions);
      els.saved.appendChild(card);
    }
  }

  // Exports every clip as one self-contained HTML file: audio inlined as data
  // URIs so it opens straight off the disk, with nothing hosted anywhere.
  function savedToolbar(clips) {
    const bar = document.createElement("div");
    bar.className = "ylr-saved-bar";

    const count = document.createElement("span");
    const bytes = clips.reduce((n, c) => n + ((c.audio && c.audio.size) || 0), 0);
    count.className = "ylr-saved-count";
    count.textContent =
      clips.length + (clips.length === 1 ? " clip" : " clips") + " · " + mb(bytes);

    const btn = document.createElement("button");
    btn.className = "ylr-link";
    btn.textContent = "⬇ Export library";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        const html = await NS.buildLibraryHtml(clips, (done, total) => {
          btn.textContent = "Embedding audio " + done + "/" + total + "…";
        });
        btn.textContent = "Building file…";
        const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = "passage-library-" + new Date().toISOString().slice(0, 10) + ".html";
        document.body.appendChild(a); // detached anchors don't always download
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        btn.textContent = "⬇ Export library";
      } catch (e) {
        console.log("[YLR] export failed:", e.message);
        alert("Couldn't export the library: " + e.message);
        btn.textContent = "⬇ Export library";
      } finally {
        btn.disabled = false;
      }
    });

    bar.appendChild(count);
    bar.appendChild(btn);
    return bar;
  }

  function mb(bytes) {
    if (bytes < 1048576) return Math.max(1, Math.round(bytes / 1024)) + " KB";
    return (bytes / 1048576).toFixed(1) + " MB";
  }

  function formatTime(s) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return m + ":" + String(sec).padStart(2, "0");
  }

  function safeName(text, max = 40) {
    return text.slice(0, max).replace(/[^\p{L}\p{N} _-]/gu, "").trim() || "clip";
  }

  // ---- boot / navigation ----

  // Everything tied to one title. Leaving the player throws it all away so that
  // coming back re-fetches rather than showing the last video's lines.
  function resetMedia() {
    state.mediaId = null;
    state.track = null;
    state.tracks = [];
    state.segments = [];
    state.translation = [];
    state.starred = new Set();
    state.savedRanges = [];
    state.activeIndex = -1;
    painted = { seg: -1, word: -1 };
    resetSync();
    if (!els) return;
    els.search.value = "";
    filterQuery = "";
    els.lang.innerHTML = "";
    els.list.innerHTML = "";
    updateSubBar();
    updateJumpButtons();
  }

  function showPlayerUI() {
    inPlayer = true;
    ensureUI();
    setOpen(true);
    els.toggle.hidden = false;
  }

  function enterPlayer() {
    const fresh = adapter.currentMediaId() !== state.mediaId;
    showPlayerUI();
    if (fresh) resetMedia();
    // A stream tap survives the player closing, but the element its chunks are
    // time-tagged against does not.
    const v = video();
    if (capture && capture.captureStream && v && capture.video !== v) {
      capture.video = v;
      capture.reset();
    }
    if (!capture && audioAvailable() && adapter.audioEnabled)
      ensureCapture().catch((e) => console.log("[YLR] pre-warm audio:", e.message));
    if (!state.segments.length)
      els.list.innerHTML = '<div class="ylr-note">Loading subtitles…</div>';
    applyLayout(); // the player container may only just have appeared
    adapter.requestTracks();
  }

  // The player closed — back to a browse or detail page. The sidebar and its
  // handle both go away; the audio tap is left running, since re-creating one on
  // the same <video> element isn't allowed and starring should work at once when
  // the player comes back.
  function exitPlayer() {
    inPlayer = false;
    hideMenu();
    hideTip();
    resetMedia();
    if (!els) return;
    setOpen(false);
    els.toggle.hidden = true;
  }

  function checkLocation() {
    if (!adapter.isWatchPage()) {
      if (inPlayer) exitPlayer();
      return;
    }
    const id = adapter.currentMediaId();
    // Only a confirmed switch to a different title re-enters; an id we don't
    // know yet must not restart the load on every tick.
    if (!inPlayer || (id && state.mediaId && id !== state.mediaId)) enterPlayer();
  }

  adapter.onNavigate(checkLocation);

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

  console.log(
    "[YLR] core " +
      ((chrome.runtime.getManifest && chrome.runtime.getManifest().version) || "?") +
      " on " +
      adapter.name +
      " | direct fetch: " +
      (NS.ClipExtractor && adapter.audioSegments ? "available" : "no") +
      " | tab capture: " +
      (adapter.audioEnabled ? "needs enabling" : "n/a")
  );

  checkLocation();
})();
