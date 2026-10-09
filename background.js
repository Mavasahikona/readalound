// Context menu, keyboard shortcut, and TTS requests: built-in Kokoro (offscreen document),
// Azure Neural, or a local Kokoro-FastAPI server.

chrome.runtime.onInstalled.addListener(async () => {
  chrome.contextMenus.create({ id: 'sr-read-selection', title: 'Read selection aloud', contexts: ['selection'] });
  chrome.contextMenus.create({ id: 'sr-read-page', title: 'Read page aloud', contexts: ['page'] });
  // Chrome only adds content scripts to pages loaded after install/update. Add them to the tabs
  // that are already open so the island shows up everywhere without a refresh.
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const tab of tabs) {
    chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: false }, files: ['shared.js', 'content.js'] }).catch(() => {});
  }
});

async function send(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (e) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['shared.js', 'content.js'] });
    return await chrome.tabs.sendMessage(tabId, msg);
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (tab?.id) send(tab.id, { cmd: 'start' }).catch(() => {});
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-read') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) send(tab.id, { cmd: 'toggle' }).catch(() => {});
});

/* ---------- Azure Neural TTS ---------- */

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function synth({ text, voice, rate, pitch }) {
  const { azureKey, azureRegion } = await chrome.storage.local.get(['azureKey', 'azureRegion']);
  if (!azureKey || !azureRegion) return { error: 'Add your Azure key + region in the popup' };
  if (!/^[a-z0-9-]+$/i.test(azureRegion)) return { error: 'Invalid Azure region' };
  if (!/^[A-Za-z0-9:_-]+$/.test(voice || '')) return { error: 'Pick an Azure voice in the popup' };

  const lang = voice.split('-').slice(0, 2).join('-');
  const r = Math.min(2, Math.max(0.5, Number(rate) || 1)).toFixed(2);
  const p = Math.round(((Number(pitch) || 1) - 1) * 50);
  const ssml =
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}">` +
    `<voice name="${voice}"><prosody rate="${r}" pitch="${p >= 0 ? '+' : ''}${p}%">${esc(text)}</prosody></voice></speak>`;

  let res;
  try {
    res = await fetch(`https://${azureRegion}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': azureKey,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-96kbitrate-mono-mp3'
      },
      body: ssml
    });
  } catch (e) {
    return { error: 'Could not reach Azure (offline?)' };
  }
  if (!res.ok) {
    const why = res.status === 401 || res.status === 403 ? 'key/region rejected'
      : res.status === 429 ? 'rate limit or quota reached'
      : 'HTTP ' + res.status;
    return { error: 'Azure: ' + why };
  }
  return { audio: toBase64(await res.arrayBuffer()) };
}

/* ---------- Kokoro-FastAPI (local server, e.g. Docker) ---------- */
// Requests go through the service worker: pages on https:// cannot call http://localhost directly
// (mixed content / CORS), but extension host_permissions can.

const KOKORO_DEFAULT = 'http://localhost:8880';

async function kokoroBase() {
  const { kokoroUrl } = await chrome.storage.local.get({ kokoroUrl: KOKORO_DEFAULT });
  const url = String(kokoroUrl || KOKORO_DEFAULT).trim().replace(/\/+$/, '');
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(url) ? url : null;
}

async function kokoroSynth({ text, voice, rate }) {
  const base = await kokoroBase();
  if (!base) return { error: 'Kokoro URL must be http://localhost:PORT or http://127.0.0.1:PORT' };
  if (!/^[A-Za-z0-9_+.\-]+$/.test(voice || '')) return { error: 'Pick a Kokoro voice in the popup' };
  const speed = Math.min(2, Math.max(0.5, Number(rate) || 1));

  let res;
  try {
    res = await fetch(`${base}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'kokoro', input: text, voice, response_format: 'mp3', speed, stream: false })
    });
  } catch (e) {
    return { error: 'Kokoro not reachable – is the Docker container running?' };
  }
  if (!res.ok) return { error: 'Kokoro: HTTP ' + res.status };
  return { audio: toBase64(await res.arrayBuffer()) };
}

async function kokoroVoices() {
  const base = await kokoroBase();
  if (!base) return { error: 'Kokoro URL must be http://localhost:PORT or http://127.0.0.1:PORT' };
  try {
    const res = await fetch(`${base}/v1/audio/voices`);
    if (!res.ok) return { error: 'Kokoro: HTTP ' + res.status };
    const data = await res.json();
    const voices = Array.isArray(data) ? data : Array.isArray(data?.voices) ? data.voices : [];
    if (!Array.isArray(voices) || !voices.length) return { error: 'Kokoro returned no voices' };
    const list = voices
      .map((v) => (typeof v === 'string' ? v : (typeof v?.name === 'string' ? v.name : typeof v?.id === 'string' ? v.id : '')))
      .filter(Boolean);
    if (!list.length) return { error: 'Kokoro returned no usable voice names' };
    return { voices: list };
  } catch (e) {
    return { error: 'Kokoro not reachable – is the Docker container running?' };
  }
}

/* ---------- Kokoro built in (offscreen document, no install) ---------- */

let creating = null;
async function ensureOffscreen() {
  const url = chrome.runtime.getURL('offscreen.html');
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
  if (existing.length) return;
  creating ||= chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WORKERS'],
    justification: 'Runs the Kokoro text-to-speech model locally'
  }).finally(() => { creating = null; });
  await creating;
}

async function toOffscreen(msg) {
  const { kokoroWebDevice } = await chrome.storage.sync.get({ kokoroWebDevice: 'auto' });
  await ensureOffscreen();
  for (let attempt = 0; ; attempt++) {
    try {
      return await chrome.runtime.sendMessage({ ...msg, target: 'offscreen', device: kokoroWebDevice });
    } catch (e) {
      // A just-created document may still be loading its scripts.
      if (attempt >= 10 || !/Receiving end does not exist/.test(String(e?.message))) throw e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

// The model is loaded once per offscreen document, so switching CPU/GPU means starting a fresh one.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && 'kokoroWebDevice' in changes) {
    chrome.offscreen.closeDocument().catch(() => {});
    chrome.storage.local.set({ kokoroWebStatus: { phase: 'idle' } });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === 'offscreen') return false;
  const owner = sender.tab?.id != null ? 'tab' + sender.tab.id : 'popup';
  let job = null;
  if (msg?.cmd === 'synth') {
    job = msg.engine === 'kokoroWeb'
      ? toOffscreen({ cmd: 'synth', text: msg.text, parts: msg.parts, voice: msg.voice, speed: msg.rate, owner, gen: msg.gen || 0 })
      : msg.engine === 'kokoro' ? kokoroSynth(msg) : synth(msg);
  } else if (msg?.cmd === 'kokoroWebCancel') job = toOffscreen({ cmd: 'cancel', owner, gen: msg.gen });
  else if (msg?.cmd === 'kokoroWebLoad') job = toOffscreen({ cmd: 'load' });
  else if (msg?.cmd === 'kokoroWebStatus') { chrome.storage.local.set({ kokoroWebStatus: msg.status }); return false; }
  else if (msg?.cmd === 'kokoroVoices') job = kokoroVoices();
  if (!job) return false;
  job.then((r) => sendResponse(r || { error: 'No response from the voice engine' }))
    .catch((e) => sendResponse({ error: String(e?.message || e) }));
  return true; // async response
});
