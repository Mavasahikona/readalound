// Shared by the content script and the popup: default settings, themes, highlight palettes
// and the built-in Kokoro voice list. Assigned (not declared) so re-injecting is harmless.

self.SR = {
  DEFAULTS: {
    engine: 'kokoroWeb',
    kokoroWebVoice: 'af_heart', kokoroWebDevice: 'auto',
    azureVoice: 'en-US-AvaMultilingualNeural', kokoroVoice: 'af_bella', voice: '',
    rate: 1, pitch: 1, volume: 1,
    theme: 'midnight', palette: 'theme', customColor: '#ffeb3b',
    island: true, jj: true, compact: false, bold: false, draggable: false, bubbleX: null, bubbleY: null
  },

  // Each theme styles the island AND supplies matching sentence-highlight colours.
  THEMES: {
    midnight: {
      name: 'Midnight Glass',
      bg: 'rgba(14,16,24,.72)', blur: true, border: 'rgba(255,255,255,.14)',
      text: '#f4f6fb', muted: '#a3abbd', accent: '#7cc4ff', glow: 'rgba(124,196,255,.35)',
      highlights: ['#bfe3ff', '#d9ccff', '#c6f3e1', '#ffd9ec']
    },
    aurora: {
      name: 'Aurora',
      bg: 'linear-gradient(120deg,#06141b,#0b2a2f 45%,#1d1236)', border: 'transparent', ring: true,
      text: '#eafff6', muted: '#8fd8c0', accent: '#5ef2b8', glow: 'rgba(94,242,184,.45)',
      highlights: ['#b8f7dc', '#a5ecff', '#d8c4ff', '#c2f5c2']
    },
    sunset: {
      name: 'Sunset',
      bg: 'linear-gradient(120deg,#3a0f4d,#b0305c 55%,#f27f3d)', border: 'rgba(255,220,190,.35)',
      text: '#fff6ef', muted: '#ffd2bd', accent: '#ffcf70', glow: 'rgba(255,140,80,.5)',
      highlights: ['#ffe0a3', '#ffc4a8', '#ffb3c7', '#ffd8f0']
    },
    neon: {
      name: 'Cyber Neon',
      bg: 'rgba(6,4,14,.94)', border: '#ff3df2', neon: true,
      text: '#fdf4ff', muted: '#b9a6d9', accent: '#29f3ff', glow: 'rgba(255,61,242,.6)',
      highlights: ['#9ffcff', '#ffb0f8', '#d6ff8f', '#fff38a']
    },
    ocean: {
      name: 'Deep Ocean',
      bg: 'linear-gradient(135deg,#0b1d3a,#0f3b57 55%,#137a83)', border: 'rgba(160,230,255,.25)',
      text: '#ecfbff', muted: '#9ccfe0', accent: '#4fe0d2', glow: 'rgba(79,224,210,.4)',
      highlights: ['#b4f1ec', '#b8dcff', '#c9f0ff', '#d4e4ff']
    },
    paper: {
      name: 'Paper',
      bg: '#fffdf8', border: 'rgba(0,0,0,.1)', light: true,
      text: '#26231e', muted: '#7a7266', accent: '#e8590c', glow: 'rgba(0,0,0,.12)',
      highlights: ['#fff3a0', '#ffd8a8', '#c3fae8', '#d0ebff']
    }
  },

  PALETTES: {
    theme:   { name: 'Match theme' },
    rainbow: { name: 'Rainbow', colors: ['#fff59d', '#a5d6a7', '#81d4fa', '#f48fb1', '#ffcc80', '#ce93d8'] },
    warm:    { name: 'Warm', colors: ['#ffe082', '#ffcc80', '#ffab91', '#f48fb1'] },
    cool:    { name: 'Cool', colors: ['#80deea', '#81d4fa', '#9fa8da', '#b39ddb', '#a5d6a7'] },
    yellow:  { name: 'Marker', colors: ['#fff176'] },
    custom:  { name: 'Custom' }
  },

  // Voices bundled with Kokoro-82M (grades from the model card; A = best).
  KOKORO_VOICES: [
    ['af_heart', 'Heart', 'A'], ['af_bella', 'Bella', 'A-'], ['af_nicole', 'Nicole', 'B-'], ['af_aoede', 'Aoede', 'C+'],
    ['af_kore', 'Kore', 'C+'], ['af_sarah', 'Sarah', 'C+'], ['af_alloy', 'Alloy', 'C'], ['af_nova', 'Nova', 'C'],
    ['af_sky', 'Sky', 'C-'], ['af_jessica', 'Jessica', 'D'], ['af_river', 'River', 'D'],
    ['am_fenrir', 'Fenrir', 'C+'], ['am_michael', 'Michael', 'C+'], ['am_puck', 'Puck', 'C+'], ['am_echo', 'Echo', 'D'],
    ['am_eric', 'Eric', 'D'], ['am_liam', 'Liam', 'D'], ['am_onyx', 'Onyx', 'D'], ['am_santa', 'Santa', 'D-'], ['am_adam', 'Adam', 'F+'],
    ['bf_emma', 'Emma', 'B-'], ['bf_isabella', 'Isabella', 'C'], ['bf_alice', 'Alice', 'D'], ['bf_lily', 'Lily', 'D'],
    ['bm_fable', 'Fable', 'C'], ['bm_george', 'George', 'C'], ['bm_lewis', 'Lewis', 'D+'], ['bm_daniel', 'Daniel', 'D']
  ],
  KOKORO_GROUPS: { af: 'American · female', am: 'American · male', bf: 'British · female', bm: 'British · male' },

  highlightColors(s) {
    const SR = self.SR;
    if (s.palette === 'custom') return [/^#[0-9a-f]{6}$/i.test(s.customColor) ? s.customColor : '#ffeb3b'];
    if (s.palette !== 'theme' && SR.PALETTES[s.palette]?.colors) return SR.PALETTES[s.palette].colors;
    return (SR.THEMES[s.theme] || SR.THEMES.midnight).highlights;
  }
};
