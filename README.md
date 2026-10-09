# Sentence Reader – Chromium extension (Chrome, Edge, Brave)

Reads a page (or your selection) aloud with natural voices and highlights the sentence being spoken.
A themed "dynamic island" at the top of the page gives you play / pause / skip controls.

## Install (developer mode)
1. Put this folder somewhere permanent.
2. `chrome://extensions` (or `edge://extensions`, `brave://extensions`) → turn on **Developer mode** → **Load unpacked** → pick the folder.
   (After updating files, click the reload icon on the extension card.)

## Voices

### Kokoro – built in (default, nothing to install)
The Kokoro-82M voice model runs inside the extension itself – no Docker, no Python, no account.

- The first time you read (or press **Download voices now** in the popup) the model is downloaded once from
  Hugging Face and cached by the browser: about **310 MB** when your graphics card is used (WebGPU, ~4× faster
  than real time) or about **160 MB** on the CPU (roughly real time). After that it works offline.
- **Run on** in the popup: *Auto* uses the graphics card when available and falls back to the CPU;
  *CPU only* forces the CPU.
- 28 English voices (American and British). ★ marks the best-rated ones (Heart, Bella).
- The highlight changes colour at every comma, semicolon, colon, dash and quote, timed from the model's own
  per-sound durations so it stays in step with the voice. Pause/resume continues mid-sentence.
- Speed applies; pitch is not supported by Kokoro.

### Azure Neural (Microsoft cloud)
1. In the Azure portal create a **Speech** resource (the free F0 tier is enough for casual reading).
2. Copy **Key 1** and the **Region** (e.g. `westeurope`) from "Keys and Endpoint".
3. Popup → engine **Azure Neural** → paste key + region → **Save & load voices**.

The key is stored locally in the browser (not synced) and only sent to Microsoft's speech endpoint.
Azure charges per character beyond the free tier.

### Kokoro – your own local server (optional)
If you already run [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) (e.g.
`docker run -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest`), pick **Kokoro – my own local server**,
check the URL (default `http://localhost:8880`) and press **Connect & load voices**. Only `localhost` /
`127.0.0.1` addresses are allowed. This also gives you the non-English Kokoro voices.

### Browser voices
Whatever voices your browser/OS provides. Lowest quality, but needs nothing.

## Use
- **Dynamic island**: click **Read aloud**, or double-tap **J** (outside text fields), then highlight what you want read.
  Reading starts half a second after you finish selecting (Enter = start now, Esc = cancel).
- While reading, the island shows previous / pause / next / stop, a counter, the current sentence and a progress line.
  Double-tap J again to pause/resume.
- **⚙ (gear)** on the island opens the appearance panel: themes, highlight colours, speed, volume, compact mode,
  bold text, drag-to-move and the J J shortcut. Click outside it or press Esc to close.
- **Themes**: Midnight Glass, Aurora, Sunset, Cyber Neon, Deep Ocean and Paper. Each theme styles the island and the
  popup and comes with matching highlight colours ("Match theme"), or pick Rainbow / Warm / Cool / Marker / Custom.
- Right-click → "Read selection aloud" / "Read page aloud". Shortcut Alt+Shift+R (change at `chrome://extensions/shortcuts`).

## Notes
- Works on any normal website (including Gemini, YouTube, Gmail). Chrome does not allow extensions on its own
  pages (`chrome://`, the new-tab page, the Chrome Web Store) or inside the built-in PDF viewer.
- For local files (`file://`) turn on **Allow access to file URLs** on the extension's details page.
- After installing or updating, the island is added to tabs that are already open – no refresh needed.
- Some sites use J as their own shortcut (Gmail, YouTube, X); turn off "Double-tap J" if it gets in the way.
- If the island says "Click ▶ to begin", the browser wants one click on the page before audio may start.

## Development
- `vendor/` holds the in-browser Kokoro runtime (`kokoro-js` + ONNX Runtime Web). To update it:
  `cd build && npm install && npm run build`.
- `dev/` has test pages: run `python dev/serve.py` and open `http://localhost:8765/dev/harness.html`
  (island + reading with a stubbed `chrome` API) or `dev/popup-preview.html`.
