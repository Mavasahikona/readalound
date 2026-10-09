// Runs the Kokoro model for the background worker. Offscreen documents only get
// chrome.runtime, so status updates are sent back as messages.
import { loadModel, synth, cancel } from './kokoro-web.js';

let device = null; // resolved once per document: 'webgpu' or 'wasm'

function report(status) {
  chrome.runtime.sendMessage({ cmd: 'kokoroWebStatus', status: { ...status, device } }).catch(() => {});
}

async function pickDevice(pref) {
  if (pref === 'wasm') return 'wasm';
  try {
    if (navigator.gpu && (await navigator.gpu.requestAdapter())) return 'webgpu';
  } catch (_) {}
  return 'wasm';
}

// WebGPU runs the full-precision model (~310 MB, ~4x real time). On the CPU the half-precision one
// (~160 MB) is as fast as full precision and ~2x faster than the 8-bit model.
async function ready(pref) {
  if (!device) device = await pickDevice(pref);
  try {
    return await loadModel(report, device === 'webgpu' ? { device: 'webgpu', dtype: 'fp32' } : { device: 'wasm', dtype: 'fp16' });
  } catch (e) {
    if (device !== 'webgpu') throw e;
    device = 'wasm'; // GPU failed (driver/blocklist) – fall back to CPU
    return loadModel(report, { device: 'wasm', dtype: 'fp16' });
  }
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;
  let job;
  if (msg.cmd === 'load') job = ready(msg.device).then(() => ({ ok: true, device }));
  else if (msg.cmd === 'synth') {
    job = ready(msg.device)
      .then(() => synth({ text: msg.text, parts: msg.parts, voice: msg.voice, speed: msg.speed, owner: msg.owner, gen: msg.gen }, report))
      .then(({ wav, times }) => ({ audio: toBase64(wav), times }));
  } else if (msg.cmd === 'cancel') { cancel(msg.owner, msg.gen); sendResponse({ ok: true }); return false; }
  else return false;
  job.then(sendResponse, (e) => sendResponse({ error: String(e?.message || e) }));
  return true;
});
