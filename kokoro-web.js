// Kokoro-82M running inside the extension (ONNX Runtime Web on WebGPU or WASM) – no Docker, no Python.
// The runtime ships in vendor/; the model (160–310 MB depending on CPU/GPU) and voice files are
// downloaded from Hugging Face on first use and cached by the browser, so later runs work offline.

import { KokoroTTS, env, phonemize } from './vendor/kokoro.web.js';

// The "timestamped" export is the same model, but it also returns how long each speech sound
// lasts – that is what keeps the highlight exactly in step with the voice.
const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX-timestamped';

env.wasmPaths = new URL('./vendor/', import.meta.url).href;

let ttsPromise = null;
let lastOutputs = null; // raw model outputs of the most recent generation (jobs run one at a time)
const queue = [];
let busy = false;

/** onStatus({ phase: 'downloading'|'loading'|'ready'|'error', pct?, error? }) */
export function loadModel(onStatus = () => {}, { device = 'wasm', dtype = 'fp16' } = {}) {
  if (ttsPromise) return ttsPromise;
  const files = new Map();
  let lastPct = -1;
  onStatus({ phase: 'downloading', pct: 0 });
  ttsPromise = KokoroTTS.from_pretrained(MODEL, {
    dtype,
    device,
    progress_callback: (p) => {
      if (p.status !== 'progress' || !p.total) return;
      files.set(p.file, { loaded: p.loaded, total: p.total });
      let loaded = 0, total = 0;
      for (const f of files.values()) { loaded += f.loaded; total += f.total; }
      if (total < 5e6) return; // ignore the tiny config files so the bar doesn't jump to 100%
      const pct = Math.floor((loaded / total) * 100);
      if (pct !== lastPct) { lastPct = pct; onStatus({ phase: 'downloading', pct }); }
    }
  }).then((tts) => {
    // kokoro-js only keeps the waveform; capture the durations output as well.
    const run = tts.model;
    tts.model = async (inputs) => (lastOutputs = await run(inputs));
    onStatus({ phase: 'ready', pct: 100 });
    return tts;
  }, (e) => {
    ttsPromise = null;
    onStatus({ phase: 'error', error: String(e?.message || e) });
    throw e;
  });
  return ttsPromise;
}

export async function listVoices() {
  const tts = await loadModel();
  return Object.entries(tts.voices).map(([id, v]) => ({ id, ...v }));
}

/**
 * Queue one sentence. Jobs run one at a time, in order. `parts` are the sentence's clauses (in
 * order, together making up `text`). Resolves to { wav: 16-bit WAV ArrayBuffer, times: seconds at
 * which each part starts in the audio }.
 */
export function synth({ text, parts = null, voice = 'af_heart', speed = 1, owner = '', gen = 0 }, onStatus) {
  return new Promise((resolve, reject) => {
    queue.push({ text, parts, voice, speed, owner, gen, resolve, reject });
    pump(onStatus);
  });
}

/** Drop queued (not yet started) jobs from one tab older than `gen`, e.g. after stop or skip. */
export function cancel(owner, gen = Infinity) {
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].owner === owner && queue[i].gen < gen) queue.splice(i, 1)[0].reject(new Error('cancelled'));
  }
}

async function pump(onStatus) {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      try {
        const tts = await loadModel(onStatus);
        job.resolve(await generate(tts, job));
      } catch (e) {
        job.reject(e);
      }
    }
  } finally {
    busy = false;
  }
}

// Phonemize each clause separately (kokoro splits on punctuation anyway, so this is what
// generate() would produce), remember how many tokens each clause has, then turn the model's
// per-token durations into clause start times.
async function generate(tts, job) {
  const voice = job.voice in tts.voices ? job.voice : 'af_heart';
  const speed = Math.min(2, Math.max(0.5, Number(job.speed) || 1));
  const pieces = job.parts?.length ? job.parts : [job.text];
  const phonemes = await Promise.all(pieces.map((p) => phonemize(p, voice[0])));
  const { input_ids } = tts.tokenizer(phonemes.join(' '), { truncation: true });
  lastOutputs = null;
  const audio = await tts.generate_from_ids(input_ids, { voice, speed });
  const samples = audio.audio, rate = audio.sampling_rate;

  const durations = lastOutputs?.durations ? Array.from(lastOutputs.durations.data, Number) : null;
  const counts = phonemes.map((ph) => tts.tokenizer(ph).input_ids.dims.at(-1) - 2); // minus start/end pads
  const expected = counts.reduce((a, b) => a + b, 0) + counts.length - 1 + 2;
  let times;
  if (durations && durations.length === expected) {
    const perUnit = samples.length / durations.reduce((a, b) => a + b, 0) / rate; // seconds per duration unit
    times = [];
    let token = 1; // skip the start pad
    for (const n of counts) {
      times.push(durations.slice(0, token).reduce((a, b) => a + b, 0) * perUnit);
      token += n + 1; // clause tokens + the joining space
    }
    times[0] = 0;
  } else {
    // Truncated or unexpected output: spread clauses by phoneme count.
    const total = counts.reduce((a, b) => a + b, 0) || 1;
    let acc = 0;
    times = counts.map((n) => { const t = (acc / total) * (samples.length / rate); acc += n; return t; });
  }
  return { wav: toWav(samples, rate), times };
}

function toWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}
