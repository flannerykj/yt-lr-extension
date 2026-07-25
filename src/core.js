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
      tabs: root.querySelectorAll(".ylr-tab")
    };
    els.jump.addEventListener("click", jumpToActive);

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
    activeTab = name;
    els.tabs.forEach((t) => t.classList.toggle("ylr-active", t.dataset.tab === name));
    els.list.hidden = name !== "subs";
    els.saved.hidden = name !== "saved";
    if (name === "saved") renderSaved();
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

  function renderSegments() {
    if (!els) return;
    autoFollow = true;
    els.jump.hidden = true;
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
      text.textContent = seg.text;
      text.addEventListener("click", () => adapter.seek(seg.start));

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
      activeTab === "subs" &&
      prevWasOnScreen &&
      !rowFullyVisible(row)
    )
      row.scrollIntoView({ block: "start" });
    updateJumpButtons();
  }

  function showTip(row, text) {
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

  async function onStar(seg, starEl) {
    starEl.classList.add("ylr-capturing");
    try {
      const wav = await clipFor(seg);
      console.log("[YLR] star: got wav", wav && wav.size, "bytes");
      const record = {
        id: adapter.currentMediaId() + ":" + seg.start.toFixed(2),
        videoId: adapter.currentMediaId(),
        videoTitle: state.title,
        url: adapter.clipUrl(seg),
        text: seg.text,
        start: seg.start,
        end: seg.end,
        createdAt: Date.now(),
        audio: wav
      };
      await NS.db.add(record);
      console.log("[YLR] star: saved", record.id);
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
      text.textContent = clip.text;

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
