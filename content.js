// Sentence Reader – content script
// Splits the page (or selection) into sentences, speaks them one at a time and highlights
// the current one with the CSS Custom Highlight API. Shows a themed "dynamic island" with
// playback controls and an appearance panel. Shared data (defaults, themes) is in shared.js.

(() => {
  // After the extension is reloaded/updated, the old copy of this script keeps running in open tabs
  // but can no longer reach the extension. A new copy replaces such an orphan instead of skipping.
  const alive = () => { try { return !!chrome.runtime?.id; } catch (_) { return false; } };
  if (window.__srAlive?.()) return;
  try { window.__srCleanup?.(); } catch (_) {}
  window.__srAlive = alive;
  const life = new AbortController(); // removes this copy's page listeners on cleanup
  const { signal } = life;

  const { DEFAULTS, THEMES, PALETTES } = self.SR;
  const MAX_COLORS = 6;
  const AUDIO_ENGINES = new Set(['kokoroWeb', 'kokoro', 'azure']);
  const BLOCK = 'p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th,dt,dd,figcaption,pre,div,section,article,header,footer,main,aside,tr,ul,ol,table,summary';

  let settings = { ...DEFAULTS };
  let sentences = [];
  let idx = 0;
  let state = 'idle'; // idle | playing | paused
  let token = 0;
  let currentUtterance = null; // keep a reference so it isn't garbage collected mid-speech
  let prompting = false;       // island is waiting for the user to highlight text
  let notice = '';             // short message shown in the island
  let labelOverride = '';
  let loading = false;         // waiting for audio of the current sentence
  let noticeTimer = null;
  let dotColor = '';
  let partIdx = 0;             // which clause of the current sentence is highlighted
  let panelOpen = false;
  let kokoroStatus = { phase: 'idle' };
  let gen = 0;                 // bumped on stop/skip so the built-in Kokoro queue can drop stale work
  let audioCtx = null, gainNode = null, currentSource = null;
  const audioCache = new Map(); // sentence index -> Promise<AudioBuffer> (with .settled flag)

  chrome.storage.sync.get(DEFAULTS).then((s) => { settings = s; applyStyles(); render(); });
  chrome.storage.local.get({ kokoroWebStatus: { phase: 'idle' } }).then((s) => { kokoroStatus = s.kokoroWebStatus; });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      if (changes.kokoroWebStatus) { kokoroStatus = changes.kokoroWebStatus.newValue || { phase: 'idle' }; render(); }
      return;
    }
    if (area !== 'sync') return;
    for (const k in changes) settings[k] = changes[k].newValue;
    if (['azureVoice', 'kokoroVoice', 'kokoroWebVoice', 'rate', 'pitch', 'engine'].some((k) => k in changes)) dropAudio();
    if (['theme', 'palette', 'customColor'].some((k) => k in changes)) {
      applyStyles();
      if (state !== 'idle' && sentences[idx]) paint(idx, partIdx, false);
    }
    render();
    if (panelOpen) syncPanel();
  });

  /* ---------- colours ---------- */

  function palette() {
    return self.SR.highlightColors(settings).slice(0, MAX_COLORS);
  }

  function theme() {
    return THEMES[settings.theme] || THEMES.midnight;
  }

  function applyStyles() {
    let st = document.getElementById('sr-highlight-style');
    if (!st) {
      st = document.createElement('style');
      st.id = 'sr-highlight-style';
      (document.head || document.documentElement).appendChild(st);
    }
    st.textContent = palette()
      .map((c, i) => `::highlight(sr-c${i}) { background-color: ${c}; color: #111; }`)
      .join('\n');
  }

  function clearHighlights() {
    if (!('highlights' in CSS)) return;
    for (let k = 0; k < MAX_COLORS; k++) CSS.highlights.delete('sr-c' + k);
  }

  // Highlight one clause of sentence i. Every clause on the page gets the next colour in the
  // palette, so the colour changes at each comma, semicolon, dash or quote.
  function paint(i, k = 0, scroll = true) {
    clearHighlights();
    const part = sentences[i].parts[k] || sentences[i].parts[0];
    const pal = palette();
    const colorIdx = part.ci % pal.length;
    CSS.highlights.set('sr-c' + colorIdx, new Highlight(part.range));
    dotColor = pal[colorIdx];
    partIdx = k;
    if (scroll) keepInView(part.range);
  }

  function partAt(sentence, charIndex) {
    let k = 0;
    while (k < sentence.parts.length - 1 && sentence.parts[k + 1].at <= charIndex) k++;
    return k;
  }

  function keepInView(range) {
    const r = range.getBoundingClientRect();
    if (!r.height) return;
    const margin = 90;
    if (r.top < margin || r.bottom > window.innerHeight - margin) {
      window.scrollBy({ top: r.top - window.innerHeight / 3, behavior: 'smooth' });
    }
  }

  /* ---------- collecting sentences ---------- */

  const visCache = new Map();
  function elementOk(el, skipChrome) {
    if (visCache.has(el)) return visCache.get(el);
    let sel = 'script,style,noscript,textarea,select,svg,canvas,iframe,[aria-hidden="true"],[hidden],sentence-reader-island';
    if (skipChrome) sel += ',nav,footer,aside';
    let ok = !el.closest(sel);
    if (ok && el.checkVisibility) ok = el.checkVisibility({ checkVisibilityCSS: true });
    visCache.set(el, ok);
    return ok;
  }

  const WORD = /[\p{L}\p{N}]/u;

  // Positions in t[a..b) where a new clause starts: after , ; : … dashes and closing quotes or
  // brackets, and before opening quotes or brackets. A single quote only closes if one was opened,
  // so apostrophes (don't, students' books) never split.
  function clauseCuts(t, a, b) {
    const cuts = new Set();
    let openDouble = false, openSingle = false;
    for (let i = a; i < b; i++) {
      const c = t[i], prev = i > a ? t[i - 1] : ' ', next = i + 1 < b ? t[i + 1] : ' ';
      const opens = /[\s(\[—–]/.test(prev) && WORD.test(next);
      const closes = /[\p{L}\p{N}.,!?;:…]/u.test(prev) && /[\s,.;:!?)\]—–]/.test(next);
      if (/[,;:…]/.test(c) && /\s/.test(next)) cuts.add(i + 1);
      else if (/[—–]/.test(c) || (c === '-' && /\s/.test(prev) && /\s/.test(next))) { cuts.add(i); cuts.add(i + 1); }
      else if (/[“«(\[]/.test(c)) cuts.add(i);
      else if (/[”»)\]]/.test(c)) cuts.add(i + 1);
      else if (c === '"') {
        if (!openDouble && opens) { cuts.add(i); openDouble = true; } else if (openDouble) { cuts.add(i + 1); openDouble = false; }
      } else if (/['‘’]/.test(c)) {
        if (!openSingle && opens && c !== '’') { cuts.add(i); openSingle = true; } else if (openSingle && closes) { cuts.add(i + 1); openSingle = false; }
      }
    }
    return [...cuts].filter((x) => x > a && x < b).sort((x, y) => x - y);
  }

  function rangeFor(P, a, b) {
    let i = 0;
    while (i < P.length - 1 && P[i + 1].g <= a) i++;
    let j = i;
    while (j < P.length - 1 && P[j + 1].g < b) j++;
    const r = document.createRange();
    r.setStart(P[i].node, P[i].s + (a - P[i].g));
    r.setEnd(P[j].node, P[j].s + (b - P[j].g));
    return r;
  }

  // Split a sentence into clauses: { range, at (offset in the spoken text), w (rough speaking length) }.
  function clauses(t, P, start, end) {
    const spans = [];
    let a = start;
    for (const cut of [...clauseCuts(t, start, end), end]) {
      let s = a, e = cut;
      while (s < e && /\s/.test(t[s])) s++;
      while (e > s && /\s/.test(t[e - 1])) e--;
      a = cut;
      if (e <= s) continue;
      const last = spans[spans.length - 1];
      // Bits without letters (a lone quote or dash) are merged into a neighbouring clause.
      if (last && (!WORD.test(t.slice(s, e)) || !WORD.test(t.slice(last[0], last[1])))) { last[1] = e; continue; }
      spans.push([s, e]);
    }
    return spans.map(([s, e]) => {
      const piece = t.slice(s, e);
      const pause = /[,;:…—–-]["'”’)\]]*$/.test(piece) ? 4 : /["'”’)\]]$/.test(piece) ? 2 : 0;
      return {
        range: rangeFor(P, s, e),
        text: piece.replace(/\s+/g, ' '),
        at: t.slice(start, s).replace(/\s+/g, ' ').length,
        w: (piece.match(/[\p{L}\p{N}]/gu) || []).length + pause
      };
    });
  }

  function gather(root, range, skipChrome) {
    visCache.clear();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue.trim()) return NodeFilter.FILTER_SKIP;
        const p = n.parentElement;
        if (!p) return NodeFilter.FILTER_SKIP;
        if (range && !range.intersectsNode(n)) return NodeFilter.FILTER_SKIP;
        return elementOk(p, skipChrome) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
    });

    // Group text nodes by their block element so sentences don't run across paragraphs.
    const groups = [];
    let group = null;
    let n;
    while ((n = walker.nextNode())) {
      let s = 0, e = n.nodeValue.length;
      if (range) {
        if (n === range.startContainer) s = range.startOffset;
        if (n === range.endContainer) e = range.endOffset;
      }
      if (e <= s) continue;
      const block = n.parentElement.closest(BLOCK) || document.body;
      if (!group || group.block !== block) {
        group = { block, text: '', pieces: [] };
        groups.push(group);
      }
      group.pieces.push({ node: n, s, e, g: group.text.length });
      group.text += n.nodeValue.slice(s, e);
    }

    let segmenter;
    try {
      segmenter = new Intl.Segmenter(document.documentElement.lang || undefined, { granularity: 'sentence' });
    } catch (_) {
      segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
    }

    const out = [];
    for (const g of groups) {
      const P = g.pieces;
      for (const seg of segmenter.segment(g.text)) {
        const raw = seg.segment;
        const text = raw.replace(/\s+/g, ' ').trim();
        if (!WORD.test(text)) continue;

        const start = seg.index + (raw.length - raw.trimStart().length);
        const end = seg.index + raw.trimEnd().length;
        try {
          const parts = clauses(g.text, P, start, end);
          if (parts.length) out.push({ text, range: rangeFor(P, start, end), parts });
        } catch (_) { /* text changed under us */ }
      }
    }
    return out;
  }

  function collect(selOverride) {
    const sel = selOverride || window.getSelection();
    if (sel && (sel.rangeCount || sel.startContainer)) {
      const hasText = sel.toString ? sel.toString().trim() : String(sel).trim();
      if (hasText && !sel.isCollapsed) {
        const range = sel.getRangeAt ? sel.getRangeAt(0).cloneRange() : sel.cloneRange();
        let root = range.commonAncestorContainer;
        if (root.nodeType === Node.TEXT_NODE) root = root.parentNode;
        return { list: gather(root, range, false), startIdx: 0, fromSelection: true };
      }
    }

    let root = document.querySelector('article, main, [role="main"]') || document.body;
    let list = gather(root, null, root === document.body);
    if (list.length < 3 && root !== document.body) list = gather(document.body, null, true);

    // Start at the first sentence that is fully visible on screen.
    let startIdx = 0;
    for (let i = 0; i < list.length; i++) {
      const r = list[i].range.getBoundingClientRect();
      if (r.height > 0 && r.top >= -4 && r.top < window.innerHeight) { startIdx = i; break; }
    }
    return { list, startIdx, fromSelection: false };
  }


  /* ---------- speech: browser voices ---------- */

  function resolveVoice() {
    const voices = speechSynthesis.getVoices();
    let v = voices.find((x) => x.name === settings.voice);
    if (!v) {
      const lang = (document.documentElement.lang || navigator.language || 'en').toLowerCase().split('-')[0];
      const cands = voices.filter((x) => x.lang.toLowerCase().startsWith(lang));
      v = cands.find((x) => /natural/i.test(x.name)) || cands.find((x) => /microsoft/i.test(x.name)) || cands[0];
    }
    return v || null;
  }

  async function ensureVoices() {
    if (speechSynthesis.getVoices().length) return;
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 1500);
      speechSynthesis.addEventListener('voiceschanged', () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }

  function speakCurrent() {
    if (state !== 'playing') return;
    if (idx >= sentences.length) { stop(); return; }

    const my = ++token;
    if (AUDIO_ENGINES.has(settings.engine)) { speakAudio(my); return; }
    labelOverride = '';
    paint(idx);
    render();

    const u = new SpeechSynthesisUtterance(sentences[idx].text);
    const voice = resolveVoice();
    if (voice) { u.voice = voice; u.lang = voice.lang; }
    u.rate = Number(settings.rate) || 1;
    u.pitch = Number(settings.pitch) || 1;
    u.volume = Number(settings.volume);
    if (!(u.volume >= 0)) u.volume = 1;

    const sentence = sentences[idx];
    let gotBoundary = false;
    const show = (k) => {
      if (my !== token || state !== 'playing' || k === partIdx) return;
      paint(idx, k);
      render();
    };
    u.onboundary = (e) => { gotBoundary = true; show(partAt(sentence, e.charIndex)); };
    u.onstart = () => {
      // Some voices never report word boundaries; fall back to an estimate (~14 chars/second).
      const cps = 14 * (Number(settings.rate) || 1);
      let acc = 0;
      sentence.parts.forEach((part, k) => {
        if (k) setTimeout(() => { if (!gotBoundary) show(k); }, (acc / cps) * 1000);
        acc += part.w;
      });
    };
    u.onend = () => {
      if (my !== token || state !== 'playing') return;
      idx++;
      speakCurrent();
    };
    u.onerror = (e) => {
      if (my !== token) return;
      if (e.error === 'canceled' || e.error === 'interrupted') return;
      if (e.error === 'not-allowed') {
        // Browsers require a click on the page before speech may start.
        state = 'paused';
        labelOverride = 'Click ▶ to begin';
        render();
        return;
      }
      idx++;
      speakCurrent();
    };

    currentUtterance = u;
    speechSynthesis.speak(u);
  }

  /* ---------- speech: audio engines (built-in Kokoro, Kokoro server, Azure) ---------- */

  function stopAudio() {
    if (currentSource) { try { currentSource.stop(); } catch (_) {} currentSource = null; }
  }

  function cancelSpeech() {
    speechSynthesis.resume();
    speechSynthesis.cancel();
  }

  function ensureAudio() {
    if (!audioCtx) {
      audioCtx = new AudioContext();
      gainNode = audioCtx.createGain();
      gainNode.connect(audioCtx.destination);
    }
  }

  function engineVoice() {
    return settings.engine === 'kokoroWeb' ? settings.kokoroWebVoice
      : settings.engine === 'kokoro' ? settings.kokoroVoice : settings.azureVoice;
  }

  function fetchAudio(i) {
    if (audioCache.has(i)) return audioCache.get(i);
    const p = (async () => {
      const res = await chrome.runtime.sendMessage({
        cmd: 'synth', text: sentences[i].text, engine: settings.engine, voice: engineVoice(),
        parts: sentences[i].parts.map((part) => part.text), rate: settings.rate, pitch: settings.pitch, gen
      });
      if (!res || res.error) throw new Error(res?.error || 'No response from extension');
      const bin = atob(res.audio);
      const bytes = new Uint8Array(bin.length);
      for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
      const buf = await audioCtx.decodeAudioData(bytes.buffer);
      const exact = Array.isArray(res.times) && res.times.length === sentences[i].parts.length;
      return { buf, times: exact ? snapToOnsets(buf, res.times) : clauseTimes(buf, sentences[i].parts) };
    })();
    p.settled = false;
    audioCache.set(i, p);
    p.then(() => { p.settled = true; }, () => { if (audioCache.get(i) === p) audioCache.delete(i); });
    return p;
  }

  // When does each clause start in the audio? Estimate from clause lengths, then snap to the nearest
  // pause the voice actually made (commas, quotes and dashes come out as short silences).
  // Loudness of the audio in 10 ms frames.
  function energy(buf) {
    const data = buf.getChannelData(0);
    const hop = Math.round(buf.sampleRate / 100);
    const rms = [];
    let max = 0;
    for (let i = 0; i + hop <= data.length; i += hop) {
      let sum = 0;
      for (let j = i; j < i + hop; j++) sum += data[j] * data[j];
      const v = Math.sqrt(sum / hop);
      rms.push(v);
      if (v > max) max = v;
    }
    return { rms, quiet: max * 0.06 };
  }

  // Exact clause times from the built-in Kokoro are within ~0.1 s; move each one onto the moment
  // the voice actually starts again (the end of the pause) when there is one close by.
  function snapToOnsets(buf, times) {
    const { rms, quiet } = energy(buf);
    return times.map((t, k) => {
      if (!k) return 0;
      const at = Math.round(t * 100);
      let best = null;
      for (let f = Math.max(1, at - 15); f <= Math.min(rms.length - 1, at + 10); f++) {
        if (rms[f - 1] <= quiet && rms[f] > quiet && (best === null || Math.abs(f - at) < Math.abs(best - at))) best = f;
      }
      return best === null ? t : best / 100;
    });
  }

  function clauseTimes(buf, parts) {
    if (parts.length < 2) return [0];
    const { rms, quiet } = energy(buf);
    const first = Math.max(0, rms.findIndex((v) => v > quiet));
    let last = rms.length - 1;
    while (last > first && rms[last] <= quiet) last--;

    const gaps = []; // silent runs of 60 ms or more inside the speech
    for (let f = first, run = -1; f <= last + 1; f++) {
      if (f <= last && rms[f] <= quiet) { if (run < 0) run = f; continue; }
      if (run >= 0 && f - run >= 6) gaps.push({ mid: (run + f) / 2, end: f });
      run = -1;
    }

    const total = parts.reduce((sum, p) => sum + p.w, 0) || 1;
    const span = last - first;
    const times = [0];
    let acc = 0, used = -1, prevFrame = first;
    for (let k = 1; k < parts.length; k++) {
      acc += parts[k - 1].w;
      const est = first + (span * acc) / total;
      const reach = Math.max(25, (0.5 * span * Math.min(parts[k - 1].w, parts[k].w)) / total);
      let best = -1, bestD = Infinity;
      for (let g = used + 1; g < gaps.length; g++) {
        const d = Math.abs(gaps[g].mid - est);
        if (gaps[g].end > prevFrame && d < bestD) { best = g; bestD = d; }
      }
      let frame = est;
      if (best >= 0 && bestD <= reach) { frame = gaps[best].end - 3; used = best; }
      frame = Math.max(prevFrame + 5, frame);
      prevFrame = frame;
      times.push(frame / 100);
    }
    return times;
  }

  // Forget queued audio requests (after stop / skip / voice change). Finished clips are kept
  // when `keepDone` so jumping back is instant.
  function dropAudio(keepDone = false) {
    gen++;
    for (const [i, p] of audioCache) if (!keepDone || !p.settled) audioCache.delete(i);
    if (settings.engine === 'kokoroWeb') chrome.runtime.sendMessage({ cmd: 'kokoroWebCancel', gen }).catch(() => {});
  }

  function prefetchAudioAhead() {
    const maxAhead = settings.engine === 'kokoroWeb' ? 3 : 4;
    for (let offset = 1; offset <= maxAhead; offset++) {
      const n = idx + offset;
      if (n < sentences.length && !audioCache.has(n)) fetchAudio(n).catch(() => {});
    }
  }

  async function speakAudio(my) {
    ensureAudio();
    if (audioCtx.state === 'suspended') {
      try {
        await audioCtx.resume();
      } catch (_) {}
      if (my !== token) return;
      if (audioCtx.state === 'suspended') {
        // Browser wants a click on the page first.
        state = 'paused';
        labelOverride = 'Click ▶ to begin';
        render();
        return;
      }
    }

    if (!audioCache.get(idx)?.settled) { loading = true; render(); }
    let buf, times;
    try {
      ({ buf, times } = await fetchAudio(idx));
    } catch (e) {
      if (my !== token) return;
      if (e.message === 'cancelled') { speakAudio(my); return; } // stale request was dropped; ask again
      loading = false;
      state = 'paused';
      labelOverride = String(e.message || e).slice(0, 70);
      render();
      return;
    }
    if (my !== token || state !== 'playing') return;

    loading = false;
    labelOverride = '';
    paint(idx);
    render();
    prefetchAudioAhead();

    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    gainNode.gain.value = Number(settings.volume) >= 0 ? Number(settings.volume) : 1;
    src.connect(gainNode);
    src.onended = () => {
      if (my !== token || currentSource !== src) return;
      currentSource = null;
      idx++;
      speakCurrent();
    };
    currentSource = src;
    const startedAt = audioCtx.currentTime;
    src.start();
    followClauses(my, src, startedAt, times);
  }

  // Keep the highlighted clause in step with the audio actually coming out of the speakers:
  // position = audio clock since start minus output latency (large for Bluetooth headphones).
  // The audio clock stops while paused, so the highlight pauses with the voice.
  function followClauses(my, src, startedAt, times) {
    const sentence = idx;
    const LEAD = 0.04; // switch a hair early – the eye should land just as the word is heard
    const tick = () => {
      if (my !== token || currentSource !== src || idx !== sentence) return;
      const latency = (audioCtx.outputLatency || 0) + (audioCtx.baseLatency || 0);
      const pos = audioCtx.currentTime - startedAt - latency + LEAD;
      let k = 0;
      while (k < times.length - 1 && times[k + 1] <= pos) k++;
      if (k !== partIdx) { paint(sentence, k); render(); }
      if (document.hidden) setTimeout(tick, 200);
      else requestAnimationFrame(tick);
    };
    tick();
  }

  /* ---------- transport ---------- */

  async function start() {
    if (!('highlights' in CSS)) { flash('This browser is too old for sentence highlighting'); return; }
    prompting = false;
    const sel = window.getSelection();
    const selRange = (sel && sel.rangeCount && !sel.isCollapsed && sel.toString().trim()) ? sel.getRangeAt(0).cloneRange() : null;
    hardStop();
    settings = await chrome.storage.sync.get(DEFAULTS);
    applyStyles();
    const { list, startIdx, fromSelection } = collect(selRange);
    if (!list.length) { flash('Nothing to read here'); return; }
    let ci = 0;
    for (const sen of list) for (const part of sen.parts) part.ci = ci++;
    // Native selection paints over custom highlights, so drop it after we capture the range.
    if (fromSelection) {
      try { const s = window.getSelection(); if (s) s.removeAllRanges(); } catch (_) {}
    }
    sentences = list;
    idx = startIdx;
    state = 'playing';
    render();
    await ensureVoices();
    speakCurrent();
  }

  // If the user already selected text, read it immediately. Otherwise ask them to
  // highlight something to read.
  function startSmart() {
    if (hasSelection()) { start(); return; }
    prompting = true;
    panelOpen = false;
    render();
  }

  function cancelPrompt() { clearTimeout(selTimer); prompting = false; render(); }

  // Pause freezes playback where it is (the audio clock is suspended, or the browser voice is
  // paused), so resume continues mid-sentence instead of starting the sentence again.
  function pause() {
    if (state !== 'playing') return;
    state = 'paused';
    loading = false;
    if (currentSource) audioCtx.suspend();
    else if (speechSynthesis.speaking) speechSynthesis.pause();
    else token++; // still preparing audio – drop it, resume asks again
    render();
  }

  function resume() {
    if (state !== 'paused') return;
    state = 'playing';
    labelOverride = '';
    if (currentSource && audioCtx.state === 'suspended') { audioCtx.resume(); render(); return; }
    if (speechSynthesis.paused && speechSynthesis.speaking && currentUtterance?.text === sentences[idx]?.text) {
      speechSynthesis.resume();
      render();
      return;
    }
    token++;
    speakCurrent();
  }

  function hardStop() {
    token++;
    cancelSpeech();
    stopAudio();
    dropAudio();
    clearHighlights();
    sentences = [];
    idx = 0;
    loading = false;
    state = 'idle';
  }

  function stop() {
    hardStop();
    labelOverride = '';
    render();
  }

  function jump(to) {
    if (state === 'idle') return;
    if (to >= sentences.length) { stop(); return; }
    idx = Math.max(0, to);
    token++;
    cancelSpeech();
    stopAudio();
    dropAudio(true);
    paint(idx);
    render();
    if (state === 'playing') setTimeout(speakCurrent, 60);
  }

  function toggle() {
    if (prompting) cancelPrompt();
    else if (state === 'idle') startSmart();
    else if (state === 'playing') pause();
    else resume();
  }

  /* ---------- dynamic island + appearance panel ---------- */

  let host, root, wrap, island, panel, els = {}, selTimer, drag = null, justDragged = false;

  const ICON = {
    prev: '<path d="M6 6h2v12H6zM20 6v12L9.5 12z"/>',
    next: '<path d="M16 6h2v12h-2zM4 6v12l10.5-6z"/>',
    play: '<path d="M8 5v14l11-7z"/>',
    pause: '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>',
    stop: '<path d="M7 7h10v10H7z"/>',
    close: '<path d="M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6z"/>',
    gear: '<path d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.18l-2.39.96a7.03 7.03 0 0 0-1.63-.94L14.5 2.5a.5.5 0 0 0-.5-.5h-3.99a.5.5 0 0 0-.5.5l-.26 2.5c-.57.23-1.11.54-1.63.94l-2.39-.96a.5.5 0 0 0-.6.18L2.72 9.84a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.18l2.39-.96c.52.4 1.06.71 1.63.94l.26 2.5a.5.5 0 0 0 .5.5h3.99a.5.5 0 0 0 .5-.5l.26-2.5c.57-.23 1.11-.54 1.63-.94l2.39.96a.5.5 0 0 0 .6-.18l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z"/>',
    wave: '<path d="M3 10v4M7.5 7v10M12 4v16M16.5 7v10M21 10v4" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" fill="none"/>'
  };
  const svg = (p, s = 18) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="currentColor" aria-hidden="true">${p}</svg>`;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  const ISLAND_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .wrap { --bg: rgba(14,16,24,.72); --border: rgba(255,255,255,.14); --text: #fff; --muted: #aaa; --accent: #7cc4ff;
            --glow: rgba(124,196,255,.35); --hover: rgba(255,255,255,.16); --c: var(--accent);
            display: flex; flex-direction: column; align-items: center; gap: 8px;
            font: 13px/1.25 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; color: var(--text); }
    .wrap[data-light] { --hover: rgba(0,0,0,.07); }
    .wrap[data-up] { flex-direction: column-reverse; }
    .wrap[data-bold] .island { font-weight: 700; }

    .island { position: relative; overflow: hidden; height: 40px; width: 196px; border-radius: 20px;
      background: var(--bg); border: 1px solid var(--border); color: var(--text);
      box-shadow: 0 10px 30px rgba(0,0,0,.35);
      user-select: none; -webkit-user-select: none;
      transition: width .5s cubic-bezier(.34,1.45,.5,1), height .5s cubic-bezier(.34,1.45,.5,1),
                  border-radius .5s ease, box-shadow .4s ease; }
    .wrap[data-blur] .island, .wrap[data-blur] .panel { backdrop-filter: blur(16px) saturate(1.4); }
    .wrap[data-light] .island { box-shadow: 0 8px 24px rgba(0,0,0,.14); }
    .wrap[data-compact] .island[data-view="idle"] { width: 92px; }
    .island[data-view="prompt"] { width: 400px; height: 46px; border-radius: 23px; }
    .island[data-view="active"] { width: 430px; height: 72px; border-radius: 28px; }
    .island[data-playing] { box-shadow: 0 10px 30px rgba(0,0,0,.35), 0 0 22px 2px var(--glow); }

    /* Aurora: flowing gradient ring */
    .wrap[data-ring] .island, .wrap[data-ring] .panel { border: 2px solid transparent;
      background: var(--bg) padding-box, linear-gradient(90deg,#5ef2b8,#29b6ff,#b06bff,#ff6ad5,#5ef2b8) border-box;
      background-size: 100% 100%, 300% 100%; animation: flow 6s linear infinite; }
    .wrap[data-ring] .island[data-playing] { animation-duration: 2.5s; }
    @keyframes flow { to { background-position: 0 0, 300% 0; } }

    /* Cyber neon: glowing tube edge that flickers while reading */
    .wrap[data-neon] .island, .wrap[data-neon] .panel { box-shadow: 0 0 6px var(--glow), 0 0 18px var(--glow), inset 0 0 10px rgba(255,61,242,.25); }
    .wrap[data-neon] .island[data-playing] { animation: neon 2.2s ease-in-out infinite; }
    @keyframes neon { 0%,100% { box-shadow: 0 0 6px var(--glow), 0 0 22px var(--glow), inset 0 0 10px rgba(255,61,242,.25); }
                      50% { box-shadow: 0 0 10px rgba(41,243,255,.7), 0 0 30px rgba(41,243,255,.45), inset 0 0 12px rgba(41,243,255,.25); } }
    .wrap[data-neon] .label { text-shadow: 0 0 8px var(--glow); letter-spacing: .02em; }

    /* Gradient themes get a soft light sweep while reading */
    .island::after { content: ""; position: absolute; inset: 0; pointer-events: none; opacity: 0;
      background: linear-gradient(100deg, transparent 30%, rgba(255,255,255,.18) 50%, transparent 70%); background-size: 250% 100%; }
    .wrap[data-sheen] .island[data-playing]::after { opacity: 1; animation: sheen 3.2s ease-in-out infinite; }
    @keyframes sheen { from { background-position: 150% 0; } to { background-position: -100% 0; } }

    .view { position: absolute; inset: 0; display: flex; align-items: center; opacity: 0; visibility: hidden;
            transition: opacity .12s, visibility 0s .12s; }
    .island[data-view="idle"] .v-idle, .island[data-view="prompt"] .v-prompt,
    .island[data-view="active"] .v-active { opacity: 1; visibility: visible; transition: opacity .25s .15s; }

    button { all: unset; display: grid; place-items: center; width: 32px; height: 32px; border-radius: 50%;
             cursor: pointer; color: inherit; flex: none; transition: background .15s, transform .15s; }
    button:hover { background: var(--hover); }
    button:active { transform: scale(.92); }
    button:focus-visible, .start:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    button.gear { width: 28px; height: 28px; color: var(--muted); }
    button.gear:hover, button.gear[aria-expanded="true"] { color: var(--text); }
    button.gear svg { transition: transform .3s ease; }
    button.gear[aria-expanded="true"] svg { transform: rotate(60deg); }
    button.play { width: 38px; height: 38px; background: var(--accent); color: #0b0b10; box-shadow: 0 0 14px var(--glow); }
    button.play:hover { background: var(--accent); filter: brightness(1.1); }
    .wrap[data-light] button.play { color: #fff; }

    .v-idle { padding: 0 6px 0 4px; gap: 2px; }
    .start { display: flex; align-items: center; gap: 8px; flex: 1; height: 32px; padding: 0 10px; border-radius: 16px; cursor: pointer; min-width: 0; outline: none; }
    .start:hover { background: var(--hover); }
    .wrap[data-draggable] .start { cursor: grab; }
    .start .wave { color: var(--accent); display: grid; }
    .wrap[data-compact] .label, .wrap[data-compact] kbd { display: none; }
    kbd { font: 600 10.5px "Segoe UI", sans-serif; padding: 1px 6px; border-radius: 5px; background: var(--hover); color: var(--muted); margin-left: auto; }

    .v-prompt { gap: 10px; padding: 0 6px 0 16px; }
    .v-prompt .t { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pulse { width: 10px; height: 10px; border-radius: 50%; background: var(--accent); flex: none; animation: pulse 1.3s ease-in-out infinite; }
    @keyframes pulse { 0%,100% { box-shadow: 0 0 0 0 var(--glow); } 50% { box-shadow: 0 0 0 8px transparent; } }

    .v-active { flex-direction: column; align-items: stretch; padding: 6px 12px 0 14px; }
    .row1 { display: flex; align-items: center; gap: 2px; height: 40px; }
    .row1 .spacer { flex: 1; }
    .count { min-width: 64px; text-align: center; font-variant-numeric: tabular-nums; padding: 0 6px; white-space: nowrap;
             overflow: hidden; text-overflow: ellipsis; color: var(--muted); font-size: 12px; max-width: 190px; }
    .snip { margin-top: 1px; color: var(--muted); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 6px; }
    .progress { position: absolute; left: 0; bottom: 0; height: 3px; width: 0; background: var(--c); opacity: .85;
                box-shadow: 0 0 8px var(--c); transition: width .4s ease, background .3s; }

    .eq { display: flex; align-items: center; gap: 2px; width: 22px; height: 18px; margin-right: 6px; flex: none; }
    .eq i { flex: 1; height: 30%; border-radius: 2px; background: var(--c); transition: background .3s; }
    .island[data-playing] .eq i { animation: eq 1s ease-in-out infinite; }
    .island[data-playing] .eq i:nth-child(2) { animation-delay: -.3s; }
    .island[data-playing] .eq i:nth-child(3) { animation-delay: -.6s; }
    .island[data-playing] .eq i:nth-child(4) { animation-delay: -.15s; }
    .island[data-loading] .eq i { animation: load 1s ease-in-out infinite; }
    @keyframes eq { 0%,100% { height: 25%; } 50% { height: 100%; } }
    @keyframes load { 0%,100% { opacity: .25; } 50% { opacity: 1; } }

    /* ---- appearance panel ---- */
    .panel { width: 330px; padding: 12px 14px 14px; border-radius: 18px; background: var(--bg); border: 1px solid var(--border);
             box-shadow: 0 18px 50px rgba(0,0,0,.45); color: var(--text);
             transform-origin: top center; animation: pop .28s cubic-bezier(.34,1.4,.5,1); }
    .wrap[data-ring] .panel { animation: pop .28s cubic-bezier(.34,1.4,.5,1), flow 6s linear infinite; }
    .wrap[data-up] .panel { transform-origin: bottom center; }
    .wrap[data-light] .panel { box-shadow: 0 18px 50px rgba(0,0,0,.18); }
    .panel[hidden] { display: none; }
    @keyframes pop { from { opacity: 0; transform: scale(.92) translateY(-6px); } }
    .ph { display: flex; align-items: center; justify-content: space-between; margin-bottom: 2px; }
    .ph b { font-size: 14px; font-weight: 700; }
    .ph button { width: 26px; height: 26px; color: var(--muted); }
    .sec { margin-top: 12px; font-size: 10.5px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
    .themes { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 6px; }
    .theme { all: unset; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 5px; padding: 6px 4px 5px;
             border-radius: 12px; font-size: 11px; color: var(--muted); border: 1px solid transparent; transition: background .15s; }
    .theme:hover { background: var(--hover); }
    .theme[aria-pressed="true"] { color: var(--text); border-color: var(--accent); background: var(--hover); }
    .theme .mini { width: 100%; height: 26px; border-radius: 13px; display: flex; align-items: center; gap: 4px; padding: 0 9px; }
    .theme .mini i { width: 7px; height: 7px; border-radius: 50%; flex: none; }
    .theme .mini s { height: 4px; border-radius: 2px; flex: 1; text-decoration: none; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; align-items: center; }
    .chip { all: unset; cursor: pointer; display: flex; align-items: center; gap: 6px; padding: 4px 9px 4px 5px; border-radius: 14px;
            font-size: 11.5px; background: var(--hover); border: 1px solid transparent; }
    .chip[aria-pressed="true"] { border-color: var(--accent); }
    .chip .sw { display: flex; }
    .chip .sw b { width: 8px; height: 14px; }
    .chip .sw b:first-child { border-radius: 7px 0 0 7px; }
    .chip .sw b:last-child { border-radius: 0 7px 7px 0; }
    .chip .sw b:only-child { width: 14px; border-radius: 7px; }
    input[type=color] { width: 28px; height: 22px; padding: 0; border: none; background: none; cursor: pointer; }
    .sl { display: grid; grid-template-columns: 56px 1fr 40px; align-items: center; gap: 8px; margin-top: 8px; font-size: 12px; }
    .sl output { text-align: right; color: var(--muted); font-variant-numeric: tabular-nums; }
    input[type=range] { width: 100%; margin: 0; accent-color: var(--accent); }
    .toggles { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 16px; margin-top: 4px; }
    .tg { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; padding: 5px 0; cursor: pointer; }
    .tg input { appearance: none; width: 30px; height: 17px; border-radius: 9px; background: var(--hover); position: relative; cursor: pointer;
                margin: 0; flex: none; transition: background .2s; outline: 1px solid var(--border); }
    .tg input::after { content: ""; position: absolute; top: 2px; left: 2px; width: 13px; height: 13px; border-radius: 50%;
                       background: var(--muted); transition: transform .2s, background .2s; }
    .tg input:checked { background: var(--accent); }
    .tg input:checked::after { transform: translateX(13px); background: #fff; }
    .foot { display: flex; justify-content: space-between; align-items: center; margin-top: 10px; font-size: 11px; color: var(--muted); }
    .link { all: unset; cursor: pointer; color: var(--accent); font-size: 11px; }
    .link:hover { text-decoration: underline; }
    @media (prefers-reduced-motion: reduce) { *, *::after { animation: none !important; transition: none !important; } }
  `;

  function persist(patch) {
    Object.assign(settings, patch);
    chrome.storage.sync.set(patch);
  }

  function shouldShow() {
    return settings.island || state !== 'idle' || prompting || !!notice || panelOpen;
  }

  function themeCard(id, t) {
    const bars = t.highlights.slice(0, 3).map((c) => `<s style="background:${c}"></s>`).join('');
    const box = t.ring
      ? `border:2px solid transparent;background:${t.bg} padding-box,linear-gradient(90deg,#5ef2b8,#29b6ff,#b06bff) border-box;`
      : `background:${t.bg};border:1px solid ${t.border};`;
    const glow = t.neon ? `box-shadow:0 0 8px ${t.glow};` : '';
    return `<button class="theme" data-theme="${id}" aria-pressed="false" title="${esc(t.name)}">` +
      `<span class="mini" style="${box}${glow}"><i style="background:${t.accent};box-shadow:0 0 6px ${t.accent}"></i>${bars}</span>${esc(t.name)}</button>`;
  }

  function paletteChip(id, p) {
    const colors = id === 'theme' ? theme().highlights : id === 'custom' ? [settings.customColor] : p.colors;
    const sw = colors.slice(0, 4).map((c) => `<b style="background:${esc(c)}"></b>`).join('');
    return `<button class="chip" data-palette="${id}" aria-pressed="false"><span class="sw">${sw}</span>${esc(p.name)}</button>`;
  }

  function buildIsland() {
    // Own tag name (site rules aimed at div/aside don't match), !important inline styles (site
    // stylesheets can't hide it) and a manual popover, which puts it in the browser's top layer –
    // above everything on the page regardless of z-index or stacking contexts.
    host = document.createElement('sentence-reader-island');
    host.id = 'sr-host';
    host.setAttribute('popover', 'manual');
    host.style.cssText = ['all:initial', 'display:block', 'position:fixed', 'z-index:2147483647', 'visibility:visible',
      'opacity:1', 'margin:0', 'padding:0', 'border:0', 'background:transparent', 'overflow:visible', 'pointer-events:auto',
      'inset:auto', 'top:10px', 'left:50%', 'transform:translateX(-50%)', 'width:auto', 'height:auto']
      .map((d) => d + ' !important').join(';');
    root = host.attachShadow({ mode: 'open' });
    const gear = `<button class="gear" data-a="panel" title="Appearance" aria-expanded="false">${svg(ICON.gear, 16)}</button>`;
    root.innerHTML = `
      <style>${ISLAND_CSS}</style>
      <div class="wrap">
        <div class="island" data-view="idle">
          <div class="view v-idle">
            <div class="start" data-a="smart" role="button" tabindex="0" title="Click, or double-tap J, then highlight text to read">
              <span class="wave">${svg(ICON.wave, 18)}</span><span class="label">Read aloud</span><kbd class="jj">J J</kbd>
            </div>
            ${gear}
          </div>
          <div class="view v-prompt">
            <span class="pulse"></span>
            <span class="t"></span>
            ${gear}
            <button data-a="cancel" title="Cancel (Esc)">${svg(ICON.close, 16)}</button>
          </div>
          <div class="view v-active">
            <div class="row1">
              <span class="eq"><i></i><i></i><i></i><i></i></span>
              <button data-a="prev" title="Previous sentence">${svg(ICON.prev)}</button>
              <button data-a="toggle" class="play" title="Play / pause">${svg(ICON.pause)}</button>
              <button data-a="next" title="Next sentence">${svg(ICON.next)}</button>
              <span class="count"></span>
              <span class="spacer"></span>
              ${gear}
              <button data-a="stop" title="Stop">${svg(ICON.stop)}</button>
            </div>
            <div class="snip"></div>
            <div class="progress"></div>
          </div>
        </div>
        <div class="panel" hidden role="dialog" aria-label="Appearance">
          <div class="ph"><b>Appearance</b><button data-a="panel" title="Close">${svg(ICON.close, 14)}</button></div>
          <div class="sec">Theme</div>
          <div class="themes">${Object.entries(THEMES).map(([id, t]) => themeCard(id, t)).join('')}</div>
          <div class="sec">Highlight colours</div>
          <div class="chips"></div>
          <div class="sec">Playback</div>
          <label class="sl"><span>Speed</span><input type="range" data-k="rate" min="0.5" max="2" step="0.1"><output data-o="rate"></output></label>
          <label class="sl"><span>Volume</span><input type="range" data-k="volume" min="0" max="1" step="0.05"><output data-o="volume"></output></label>
          <div class="sec">Island</div>
          <div class="toggles">
            <label class="tg">Compact <input type="checkbox" data-k="compact"></label>
            <label class="tg">Bold text <input type="checkbox" data-k="bold"></label>
            <label class="tg">Drag to move <input type="checkbox" data-k="draggable"></label>
            <label class="tg">Double-tap J <input type="checkbox" data-k="jj"></label>
          </div>
          <div class="foot"><span>Voices &amp; engines: toolbar icon</span><button class="link" data-a="reset-pos">Reset position</button></div>
        </div>
      </div>`;
    wrap = root.querySelector('.wrap');
    island = root.querySelector('.island');
    panel = root.querySelector('.panel');
    els = {
      prompt: root.querySelector('.v-prompt .t'),
      play: root.querySelector('.play'),
      count: root.querySelector('.count'),
      snip: root.querySelector('.snip'),
      progress: root.querySelector('.progress'),
      jj: root.querySelector('.jj'),
      chips: root.querySelector('.chips'),
      gears: root.querySelectorAll('.gear')
    };

    root.addEventListener('click', onClick);
    root.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('.start')) { e.preventDefault(); startSmart(); }
    });
    panel.addEventListener('input', onPanelInput);
    island.addEventListener('mousedown', onDragStart);
  }

  function onClick(e) {
    const t = e.target;
    const th = t.closest('[data-theme]');
    if (th) { persist({ theme: th.dataset.theme }); themeChanged(); return; }
    const pal = t.closest('[data-palette]');
    if (pal) { persist({ palette: pal.dataset.palette }); themeChanged(); return; }
    const b = t.closest('[data-a]');
    if (!b) return;
    if (b.dataset.a === 'smart' && justDragged) return;
    switch (b.dataset.a) {
      case 'smart': startSmart(); break;
      case 'cancel': cancelPrompt(); break;
      case 'prev': jump(idx - 1); break;
      case 'next': jump(idx + 1); break;
      case 'toggle': toggle(); break;
      case 'stop': stop(); break;
      case 'panel': setPanel(!panelOpen); break;
      case 'reset-pos': persist({ bubbleX: null, bubbleY: null }); render(); break;
    }
  }

  function themeChanged() {
    applyStyles();
    if (state !== 'idle' && sentences[idx]) paint(idx, partIdx, false);
    render();
    syncPanel();
  }

  function onPanelInput(e) {
    const el = e.target;
    const k = el.dataset.k;
    if (!k) return;
    if (el.type === 'checkbox') persist({ [k]: el.checked });
    else if (el.type === 'range') persist({ [k]: Number(el.value) });
    else if (el.type === 'color') { persist({ [k]: el.value }); themeChanged(); return; }
    if (k === 'volume' && gainNode) gainNode.gain.value = Number(el.value);
    syncPanel();
    render();
  }

  function setPanel(open) {
    panelOpen = open;
    render();
    if (open) syncPanel();
  }

  // Reflect current settings in the panel controls.
  function syncPanel() {
    if (!panel) return;
    for (const b of panel.querySelectorAll('[data-theme]')) b.setAttribute('aria-pressed', String(b.dataset.theme === settings.theme));
    const picker = root.activeElement?.matches?.('input[type=color]');
    if (!picker) {
      els.chips.innerHTML = Object.entries(PALETTES).map(([id, p]) => paletteChip(id, p)).join('') +
        (settings.palette === 'custom' ? `<input type="color" data-k="customColor" value="${esc(settings.customColor)}" title="Pick colour">` : '');
    }
    for (const c of els.chips.querySelectorAll('[data-palette]')) c.setAttribute('aria-pressed', String(c.dataset.palette === settings.palette));
    for (const el of panel.querySelectorAll('[data-k]')) {
      const v = settings[el.dataset.k];
      if (el.type === 'checkbox') el.checked = !!v;
      else if (el.type === 'range' && root.activeElement !== el) el.value = v;
    }
    panel.querySelector('[data-o="rate"]').textContent = Number(settings.rate).toFixed(1) + '×';
    panel.querySelector('[data-o="volume"]').textContent = Math.round(settings.volume * 100) + '%';
  }

  /* ---- dragging (only when "Drag to move" is on) ---- */

  function onDragStart(e) {
    if (!settings.draggable || e.button !== 0 || e.target.closest('button')) return;
    const r = host.getBoundingClientRect();
    drag = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, moved: false };
    e.preventDefault();
  }
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    place(drag.left + dx, drag.top + dy);
  }, { capture: true, signal });
  window.addEventListener('mouseup', () => {
    if (!drag) return;
    if (drag.moved) {
      const r = host.getBoundingClientRect();
      persist({ bubbleX: Math.round(r.left), bubbleY: Math.round(r.top) });
      justDragged = true;
      setTimeout(() => { justDragged = false; }, 0);
    }
    drag = null;
  }, { capture: true, signal });

  function setPos(left, top, transform) {
    host.style.setProperty('left', left, 'important');
    host.style.setProperty('top', top, 'important');
    host.style.setProperty('transform', transform, 'important');
  }

  // Put the island on the page (again) – some sites remove elements they don't recognise.
  let reattached = 0;
  function attach() {
    if (!host.isConnected) document.documentElement.append(host);
    try { if (!host.matches(':popover-open')) host.showPopover(); } catch (_) { /* older browser: z-index still applies */ }
  }
  const hostWatch = new MutationObserver(() => {
    if (!host || host.isConnected || !shouldShow() || reattached > 30) return;
    reattached++;
    attach();
  }).observe(document.documentElement, { childList: true });

  function place(x, y) {
    const w = island.offsetWidth || 200, h = island.offsetHeight || 40;
    setPos(Math.max(4, Math.min(window.innerWidth - w - 4, x)) + 'px', Math.max(4, Math.min(window.innerHeight - h - 4, y)) + 'px', 'none');
  }

  function render() {
    if (!shouldShow()) { host?.remove(); return; }
    if (!host) buildIsland();
    attach();

    const t = theme();
    const vars = { '--bg': t.bg, '--border': t.border, '--text': t.text, '--muted': t.muted, '--accent': t.accent,
                   '--glow': t.glow, '--c': dotColor || t.accent };
    for (const k in vars) wrap.style.setProperty(k, vars[k]);
    wrap.toggleAttribute('data-blur', !!t.blur);
    wrap.toggleAttribute('data-ring', !!t.ring);
    wrap.toggleAttribute('data-neon', !!t.neon);
    wrap.toggleAttribute('data-light', !!t.light);
    wrap.toggleAttribute('data-sheen', /gradient/.test(t.bg));
    wrap.toggleAttribute('data-bold', !!settings.bold);
    wrap.toggleAttribute('data-compact', !!settings.compact);
    wrap.toggleAttribute('data-draggable', !!settings.draggable);

    const view = (prompting || notice) ? 'prompt' : state === 'idle' ? 'idle' : 'active';
    island.dataset.view = view;
    island.toggleAttribute('data-playing', state === 'playing' && !loading);
    island.toggleAttribute('data-loading', loading);

    panel.hidden = !panelOpen;
    for (const g of els.gears) g.setAttribute('aria-expanded', String(panelOpen));

    if (settings.bubbleX != null && settings.bubbleY != null) {
      if (!drag) place(settings.bubbleX, settings.bubbleY);
      wrap.toggleAttribute('data-up', settings.bubbleY > window.innerHeight / 2);
    } else {
      setPos('50%', '10px', 'translateX(-50%)');
      wrap.removeAttribute('data-up');
    }

    els.prompt.textContent = notice || 'Highlight the text you want read';
    els.jj.style.display = settings.jj ? '' : 'none';
    els.play.innerHTML = svg(state === 'playing' ? ICON.pause : ICON.play, 20);
    els.count.textContent = statusLabel();
    els.snip.textContent = loading && settings.engine === 'kokoroWeb' && kokoroStatus.phase === 'downloading'
      ? 'One-time download – after this, voices work offline.'
      : sentences[idx]?.text || '';
    els.progress.style.width = sentences.length ? `${((idx + 1) / sentences.length) * 100}%` : '0';
  }

  function statusLabel() {
    if (labelOverride) return labelOverride;
    if (loading) {
      if (settings.engine === 'kokoroWeb' && kokoroStatus.phase === 'downloading') return `Getting voices ${kokoroStatus.pct || 0}%`;
      return 'Preparing voice…';
    }
    return sentences.length ? `${Math.min(idx + 1, sentences.length)} / ${sentences.length}` : '';
  }

  function flash(text) {
    notice = text;
    prompting = false;
    render();
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { notice = ''; render(); }, 2500);
  }

  /* ---------- "highlight what you want read" prompt ---------- */

  function fromIsland(e) { return !!host && (e.target === host || e.composedPath().includes(host)); }
  function hasSelection() {
    const s = window.getSelection();
    if (!s || !s.rangeCount) return false;
    for (let i = 0; i < s.rangeCount; i++) {
      const r = s.getRangeAt(i);
      if (r.collapsed || !r.toString().trim()) continue;
      const rect = r.getBoundingClientRect();
      if ((rect.width || rect.height) && rect.top < window.innerHeight && rect.bottom > 0 && rect.left < window.innerWidth && rect.right > 0) return true;
    }
    return false;
  }

  // After the user finishes highlighting, wait briefly (so double/triple-click can extend
  // the selection), then start reading. Enter starts immediately.
  function armAutoStart() {
    clearTimeout(selTimer);
    selTimer = setTimeout(() => { if (prompting && hasSelection()) start(); }, 500);
  }
  document.addEventListener('mousedown', (e) => {
    if (fromIsland(e)) return;
    if (panelOpen) setPanel(false); // click outside closes the appearance panel
    if (prompting) clearTimeout(selTimer);
  }, { capture: true, signal });
  document.addEventListener('mouseup', (e) => { if (prompting && !fromIsland(e)) armAutoStart(); }, { capture: true, signal });
  document.addEventListener('touchend', () => { if (prompting) armAutoStart(); }, { capture: true, signal });

  /* ---------- keyboard: jj, Enter, Esc ---------- */

  function isEditable(t) {
    return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  }

  let lastJ = -Infinity;
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panelOpen) { setPanel(false); return; }
    if (prompting) {
      if (e.key === 'Escape') { e.preventDefault(); cancelPrompt(); return; }
      if (e.key === 'Enter' && hasSelection()) { e.preventDefault(); clearTimeout(selTimer); start(); return; }
    }
    if (e.shiftKey && prompting) armAutoStart(); // keyboard selection (Shift+arrows)

    if (!settings.jj) return;
    if (e.key !== 'j' || e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (isEditable(e.composedPath()[0])) return;

    const now = performance.now();
    if (now - lastJ < 450) {
      lastJ = -Infinity;
      e.preventDefault();
      e.stopPropagation();
      toggle();
    } else {
      lastJ = now;
    }
  }, { capture: true, signal });
  document.addEventListener('keyup', (e) => { if (prompting && e.key.startsWith('Arrow') && e.shiftKey) armAutoStart(); }, { capture: true, signal });

  /* ---------- messaging ---------- */

  function status() { return { state: prompting ? 'prompt' : state, idx, total: sentences.length }; }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.cmd) {
      case 'start': start(); break;          // selection if any, otherwise the page
      case 'toggle': toggle(); break;        // selection -> read, else prompt to highlight
      case 'pause': pause(); break;
      case 'resume': resume(); break;
      case 'stop': stop(); break;
      case 'next': jump(idx + 1); break;
      case 'prev': jump(idx - 1); break;
    }
    sendResponse(status());
    return false;
  });

  window.addEventListener('pagehide', () => speechSynthesis.cancel(), { signal });

  function cleanup() {
    life.abort();
    clearInterval(orphanCheck);
    try { hardStop(); } catch (_) { /* extension context already gone */ }
    hostWatch.disconnect();
    host?.remove();
    document.getElementById('sr-highlight-style')?.remove();
  }
  window.__srCleanup = cleanup;
  const orphanCheck = setInterval(() => { if (!alive()) cleanup(); }, 5000);
})();
