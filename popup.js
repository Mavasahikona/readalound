const $ = (id) => document.getElementById(id);

const { DEFAULTS, THEMES, PALETTES, KOKORO_VOICES, KOKORO_GROUPS } = self.SR;
const PLAY = '<path d="M8 5v14l11-7z"/>';
const PAUSE = '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>';

let settings = { ...DEFAULTS };

/* ---------- messaging with the page ---------- */

async function send(msg) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^(https?|file):/.test(tab.url || '')) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch (_) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['shared.js', 'content.js'] });
      return await chrome.tabs.sendMessage(tab.id, msg);
    } catch (_) { return null; }
  }
}

function save(patch) {
  Object.assign(settings, patch);
  chrome.storage.sync.set(patch);
}

/* ---------- engine switch ---------- */

function renderEngine() {
  $('kokoroWebBox').hidden = settings.engine !== 'kokoroWeb';
  $('azureBox').hidden = settings.engine !== 'azure';
  $('kokoroBox').hidden = settings.engine !== 'kokoro';
  $('browserBox').hidden = settings.engine !== 'browser';
  $('pitchRow').hidden = settings.engine === 'kokoroWeb' || settings.engine === 'kokoro'; // Kokoro has no pitch control
}

/* ---------- Kokoro built in ---------- */

const SAMPLE = 'Hello! This is how I will sound when reading your page aloud.';

function populateKokoroWebVoices() {
  const sel = $('kokoroWebVoice');
  sel.innerHTML = '';
  for (const [prefix, label] of Object.entries(KOKORO_GROUPS)) {
    const og = document.createElement('optgroup');
    og.label = label;
    for (const [id, name, grade] of KOKORO_VOICES.filter(([v]) => v.startsWith(prefix + '_'))) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = `${name}${grade.startsWith('A') ? ' ★' : ''}  ·  ${grade}`;
      og.appendChild(o);
    }
    sel.appendChild(og);
  }
  sel.value = settings.kokoroWebVoice;
  if (sel.value !== settings.kokoroWebVoice) { sel.value = 'af_heart'; save({ kokoroWebVoice: 'af_heart' }); }
}

function renderKokoroWebStatus(st = { phase: 'idle' }) {
  const msg = $('kwMsg'), bar = $('kwBar'), btn = $('kwLoad');
  const where = st.device === 'webgpu' ? 'graphics card' : st.device === 'wasm' ? 'CPU' : '';
  msg.classList.toggle('err', st.phase === 'error');
  btn.hidden = st.phase === 'ready' || st.phase === 'downloading';
  if (st.phase === 'downloading') {
    bar.style.width = (st.pct || 0) + '%';
    msg.textContent = `Getting voices… ${st.pct || 0}% (one-time download${where ? ', for your ' + where : ''})`;
  } else if (st.phase === 'ready') {
    bar.style.width = '100%';
    msg.textContent = `Ready – running on your ${where || 'computer'}. Works offline from now on.`;
  } else if (st.phase === 'error') {
    bar.style.width = '0';
    msg.textContent = 'Could not load voices: ' + (st.error || 'unknown error');
    btn.textContent = 'Try again';
  } else {
    bar.style.width = '0';
    msg.textContent = settings.kokoroWebDevice === 'wasm'
      ? 'Voices download once (about 160 MB) the first time you read, then work offline.'
      : 'Voices download once the first time you read (about 310 MB with a graphics card, 160 MB without), then work offline.';
    btn.textContent = 'Download voices now';
  }
}

async function kokoroWebLoad() {
  renderKokoroWebStatus({ phase: 'downloading', pct: 0 });
  const r = await chrome.runtime.sendMessage({ cmd: 'kokoroWebLoad' });
  if (r?.error) renderKokoroWebStatus({ phase: 'error', error: r.error });
}

async function kokoroWebPreview() {
  const btn = $('kokoroWebPreview');
  btn.disabled = true;
  const r = await chrome.runtime.sendMessage({
    cmd: 'synth', engine: 'kokoroWeb', text: SAMPLE, voice: $('kokoroWebVoice').value, rate: settings.rate
  });
  btn.disabled = false;
  if (!r || r.error) { renderKokoroWebStatus({ phase: 'error', error: r?.error || 'No response' }); return; }
  const a = new Audio('data:audio/wav;base64,' + r.audio);
  a.volume = settings.volume;
  a.play();
}

/* ---------- themes ---------- */

function applyTheme() {
  const t = THEMES[settings.theme] || THEMES.midnight;
  const css = document.documentElement.style;
  css.setProperty('--accent', t.accent);
  css.setProperty('--hero', t.bg.replace(/^rgba\((.*),\s*[\d.]+\)$/, 'rgb($1)')); // opaque version of glassy themes
  css.setProperty('--hero-text', t.text);
  css.setProperty('--hero-muted', t.muted);
  document.body.classList.toggle('light-hero', !!t.light);
  for (const b of document.querySelectorAll('.theme')) b.setAttribute('aria-pressed', String(b.dataset.theme === settings.theme));
}

function buildThemes() {
  $('themes').innerHTML = Object.entries(THEMES).map(([id, t]) => {
    const bars = t.highlights.slice(0, 3).map((c) => `<s style="background:${c}"></s>`).join('');
    const box = t.ring
      ? `border:2px solid transparent;background:${t.bg} padding-box,linear-gradient(90deg,#5ef2b8,#29b6ff,#b06bff) border-box;`
      : `background:${t.bg};border:1px solid ${t.light ? 'rgba(0,0,0,.15)' : t.border};`;
    const glow = t.neon ? `box-shadow:0 0 8px ${t.glow};` : '';
    return `<button class="theme" data-theme="${id}" aria-pressed="false"><span class="mini" style="${box}${glow}">` +
      `<i style="background:${t.accent}"></i>${bars}</span>${t.name}</button>`;
  }).join('');
  $('themes').addEventListener('click', (e) => {
    const b = e.target.closest('[data-theme]');
    if (!b) return;
    save({ theme: b.dataset.theme });
    applyTheme();
    renderSwatches();
  });
}

/* ---------- Azure voices ---------- */

function azureMsg(text, isError) {
  const el = $('azureMsg');
  el.textContent = text || '';
  el.classList.toggle('err', !!isError);
}

function populateAzureVoices(list) {
  const sel = $('azureVoice');
  sel.innerHTML = '';
  if (!list?.length) { sel.innerHTML = '<option value="">Save key first to load voices</option>'; return; }

  const exact = (navigator.language || 'en-US').toLowerCase();
  const lang = exact.split('-')[0];
  const rankLoc = (l) => (l.toLowerCase() === exact ? 0 : l.toLowerCase().startsWith(lang) ? 1 : 2);

  const byLoc = {};
  for (const v of list) (byLoc[v.l] ||= []).push(v);
  const locs = Object.keys(byLoc).sort((a, b) => rankLoc(a) - rankLoc(b) || a.localeCompare(b));

  for (const loc of locs) {
    const og = document.createElement('optgroup');
    og.label = loc;
    byLoc[loc].sort((a, b) => (/Multilingual/.test(b.n) - /Multilingual/.test(a.n)) || a.n.localeCompare(b.n));
    for (const v of byLoc[loc]) {
      const o = document.createElement('option');
      o.value = v.n;
      o.textContent = `${v.d} (${v.g})${/Multilingual/.test(v.n) ? ' ★' : ''}`;
      og.appendChild(o);
    }
    sel.appendChild(og);
  }
  sel.value = settings.azureVoice;
  if (sel.value !== settings.azureVoice) { sel.selectedIndex = 0; save({ azureVoice: sel.value }); }
}

async function azureSave() {
  const key = $('azureKey').value.trim();
  const region = $('azureRegion').value.trim().toLowerCase();
  if (!key || !/^[a-z0-9-]+$/.test(region)) { azureMsg('Enter your key and a region such as westeurope.', true); return; }
  azureMsg('Checking…');
  try {
    const r = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/voices/list`, {
      headers: { 'Ocp-Apim-Subscription-Key': key }
    });
    if (!r.ok) throw new Error(r.status === 401 || r.status === 403
      ? `Key or region rejected (HTTP ${r.status}). Check both match the same Azure resource.`
      : `Azure returned HTTP ${r.status}.`);
    const data = await r.json();
    const list = data.map((v) => ({ n: v.ShortName, l: v.Locale, g: v.Gender, d: v.LocalName || v.DisplayName }));
    await chrome.storage.local.set({ azureKey: key, azureRegion: region, azureVoices: list });
    populateAzureVoices(list);
    save({ engine: 'azure' });
    $('engine').value = 'azure';
    renderEngine();
    azureMsg(`Connected – ${list.length} voices loaded. ★ = multilingual, very natural.`);
  } catch (e) {
    azureMsg(e.message || 'Could not reach Azure.', true);
  }
}

async function preview() {
  azureMsg('Generating preview…');
  const r = await chrome.runtime.sendMessage({
    cmd: 'synth', engine: 'azure', text: SAMPLE,
    voice: $('azureVoice').value, rate: settings.rate, pitch: settings.pitch
  });
  if (!r || r.error) { azureMsg(r?.error || 'No response', true); return; }
  azureMsg('');
  const a = new Audio('data:audio/mpeg;base64,' + r.audio);
  a.volume = settings.volume;
  a.play();
}

/* ---------- Kokoro (own local server, e.g. Docker) ---------- */

const SERVER_GROUPS = {
  ...KOKORO_GROUPS,
  ef: 'Spanish · female', em: 'Spanish · male', ff: 'French · female', hf: 'Hindi · female', hm: 'Hindi · male',
  if: 'Italian · female', im: 'Italian · male', jf: 'Japanese · female', jm: 'Japanese · male',
  pf: 'Portuguese · female', pm: 'Portuguese · male', zf: 'Chinese · female', zm: 'Chinese · male'
};

function kokoroMsg(text, isError) {
  const el = $('kokoroMsg');
  el.textContent = text || '';
  el.classList.toggle('err', !!isError);
}

function populateKokoroVoices(list) {
  const sel = $('kokoroVoice');
  sel.innerHTML = '';
  if (!list?.length) { sel.innerHTML = '<option value="af_bella">af_bella (connect to load more)</option>'; sel.value = 'af_bella'; return; }

  const groups = {};
  for (const v of list) (groups[v.slice(0, 2)] ||= []).push(v);
  const order = Object.keys(groups).sort((a, b) => (a in SERVER_GROUPS ? 0 : 1) - (b in SERVER_GROUPS ? 0 : 1) || a.localeCompare(b));
  for (const g of order) {
    const og = document.createElement('optgroup');
    og.label = SERVER_GROUPS[g] || 'Other';
    for (const v of groups[g].sort()) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = v.replace(/^[a-z]{2}_/, '');
      og.appendChild(o);
    }
    sel.appendChild(og);
  }
  sel.value = settings.kokoroVoice;
  if (sel.value !== settings.kokoroVoice) { sel.selectedIndex = 0; save({ kokoroVoice: sel.value }); }
}

async function kokoroSave() {
  const url = $('kokoroUrl').value.trim().replace(/\/+$/, '') || 'http://localhost:8880';
  if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(url)) {
    kokoroMsg('Use http://localhost:PORT or http://127.0.0.1:PORT (default port 8880).', true);
    return;
  }
  kokoroMsg('Connecting…');
  await chrome.storage.local.set({ kokoroUrl: url });
  const r = await chrome.runtime.sendMessage({ cmd: 'kokoroVoices' });
  if (!r || r.error) { kokoroMsg(r?.error || 'No response from extension', true); return; }
  await chrome.storage.local.set({ kokoroVoiceList: r.voices });
  populateKokoroVoices(r.voices);
  save({ engine: 'kokoro' });
  $('engine').value = 'kokoro';
  renderEngine();
  kokoroMsg(`Connected – ${r.voices.length} voices loaded.`);
}

async function kokoroPreview() {
  kokoroMsg('Generating preview…');
  const r = await chrome.runtime.sendMessage({
    cmd: 'synth', engine: 'kokoro', text: SAMPLE,
    voice: $('kokoroVoice').value, rate: settings.rate
  });
  if (!r || r.error) { kokoroMsg(r?.error || 'No response', true); return; }
  kokoroMsg('');
  const a = new Audio('data:audio/mpeg;base64,' + r.audio);
  a.volume = settings.volume;
  a.play();
}

/* ---------- browser voices ---------- */

function loadVoices() {
  const select = $('voice');
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return;
  const rank = (v) => (/natural/i.test(v.name) ? 0 : /microsoft/i.test(v.name) ? 1 : 2);
  voices.sort((a, b) => rank(a) - rank(b) || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));

  select.innerHTML = '<option value="">Auto (best match for the page language)</option>';
  for (const v of voices) {
    const o = document.createElement('option');
    o.value = v.name;
    o.textContent = v.name.replace(/^Microsoft\s+/, '');
    select.appendChild(o);
  }
  select.value = settings.voice;
  if (select.value !== settings.voice) select.value = '';

  const naturals = voices.filter((v) => /natural/i.test(v.name)).length;
  $('browserHint').textContent = naturals
    ? ''
    : 'Only your system\'s older voices are available in this browser (the "Natural" voices are Edge-only). Pick "Kokoro – built in" above for natural voices.';
}

/* ---------- sliders, colours, status ---------- */

function renderSwatches() {
  const colors = self.SR.highlightColors(settings);
  $('swatches').innerHTML = colors.map((c) => `<span style="background:${c}"></span>`).join('');
  document.querySelector('.row:has(#palette)')?.classList.toggle('custom', settings.palette === 'custom');
}

function bindSlider(key) {
  const el = $(key), out = $(key + 'Out');
  const fmt = (v) => (key === 'volume' ? Math.round(v * 100) + '%' : Number(v).toFixed(1) + '×');
  el.value = settings[key];
  out.textContent = fmt(settings[key]);
  el.addEventListener('input', () => {
    out.textContent = fmt(el.value);
    save({ [key]: Number(el.value) });
  });
}

async function refreshStatus() {
  const s = await send({ cmd: 'status' });
  const label = $('status');
  if (!s) { label.textContent = 'Unavailable on this page'; $('playIcon').innerHTML = PLAY; return; }
  label.textContent = s.state === 'idle' ? 'Idle' : s.state === 'prompt' ? 'Waiting for your selection' : `${s.state === 'paused' ? 'Paused' : 'Reading'} ${s.idx + 1} / ${s.total}`;
  $('playIcon').innerHTML = s.state === 'playing' ? PAUSE : PLAY;
}

/* ---------- init ---------- */

(async function init() {
  settings = await chrome.storage.sync.get(DEFAULTS);
  const local = await chrome.storage.local.get({
    azureKey: '', azureRegion: '', azureVoices: [], kokoroUrl: 'http://localhost:8880', kokoroVoiceList: [],
    kokoroWebStatus: { phase: 'idle' }
  });

  buildThemes();
  applyTheme();

  $('engine').value = settings.engine;
  $('engine').addEventListener('change', (e) => { save({ engine: e.target.value }); renderEngine(); });
  renderEngine();

  populateKokoroWebVoices();
  $('kokoroWebVoice').addEventListener('change', (e) => save({ kokoroWebVoice: e.target.value }));
  $('kokoroWebPreview').addEventListener('click', kokoroWebPreview);
  $('kokoroWebDevice').value = settings.kokoroWebDevice;
  $('kokoroWebDevice').addEventListener('change', (e) => { save({ kokoroWebDevice: e.target.value }); renderKokoroWebStatus(); });
  $('kwLoad').addEventListener('click', kokoroWebLoad);
  renderKokoroWebStatus(local.kokoroWebStatus);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.kokoroWebStatus) renderKokoroWebStatus(changes.kokoroWebStatus.newValue);
  });

  $('azureKey').value = local.azureKey;
  $('azureRegion').value = local.azureRegion;
  populateAzureVoices(local.azureVoices);
  $('azureSave').addEventListener('click', azureSave);
  $('azureVoice').addEventListener('change', (e) => save({ azureVoice: e.target.value }));
  $('preview').addEventListener('click', preview);

  $('kokoroUrl').value = local.kokoroUrl;
  populateKokoroVoices(local.kokoroVoiceList);
  $('kokoroSave').addEventListener('click', kokoroSave);
  $('kokoroVoice').addEventListener('change', (e) => save({ kokoroVoice: e.target.value }));
  $('kokoroPreview').addEventListener('click', kokoroPreview);

  loadVoices();
  speechSynthesis.onvoiceschanged = loadVoices;
  $('voice').addEventListener('change', (e) => save({ voice: e.target.value }));

  ['rate', 'pitch', 'volume'].forEach(bindSlider);

  $('palette').innerHTML = Object.entries(PALETTES).map(([id, p]) => `<option value="${id}">${p.name}</option>`).join('');
  $('palette').value = settings.palette in PALETTES ? settings.palette : 'theme';
  $('customColor').value = settings.customColor;
  $('palette').addEventListener('change', (e) => { save({ palette: e.target.value }); renderSwatches(); });
  $('customColor').addEventListener('input', (e) => { save({ customColor: e.target.value }); renderSwatches(); });
  renderSwatches();

  $('play').addEventListener('click', async () => { await send({ cmd: 'toggle' }); setTimeout(refreshStatus, 150); });
  $('stop').addEventListener('click', async () => { await send({ cmd: 'stop' }); refreshStatus(); });
  $('prev').addEventListener('click', async () => { await send({ cmd: 'prev' }); refreshStatus(); });
  $('next').addEventListener('click', async () => { await send({ cmd: 'next' }); refreshStatus(); });

  $('island').checked = settings.island;
  $('jj').checked = settings.jj;
  $('island').addEventListener('change', (e) => save({ island: e.target.checked }));
  $('jj').addEventListener('change', (e) => save({ jj: e.target.checked }));
  $('readPage').addEventListener('click', async () => { await send({ cmd: 'start' }); window.close(); });

  refreshStatus();
  setInterval(refreshStatus, 600);
})();
