/**
 * STEALTH LAYER — applied to every Browserbase page before navigation.
 * Single source of truth so the engine and the fingerprint probe share
 * the exact same anti-bot configuration.
 */
import type { Page } from "playwright-core";

// Chromium UA pool — kept in sync with Sec-CH-UA below
export const UA_POOL = [
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', major: '124', platform: '"Windows"', os: 'win' },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36', major: '125', platform: '"Windows"', os: 'win' },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', major: '126', platform: '"Windows"', os: 'win' },
];

// Realistic hardware combos — concurrency/memory pairs that actually exist on consumer hardware
const HARDWARE_PROFILES = [
  { cores: 8, memory: 8 },
  { cores: 8, memory: 16 },
  { cores: 12, memory: 16 },
  { cores: 16, memory: 16 },
  { cores: 16, memory: 32 },
];

// GPU profiles tied to OS so Windows UA gets a Windows GPU (Direct3D11, never Mesa)
const GPU_WIN = [
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
];

// Windows 10 default font list — what FP expects to enumerate on a real Windows machine
const WINDOWS_FONTS = [
  'Arial', 'Arial Black', 'Arial Narrow', 'Calibri', 'Cambria', 'Cambria Math', 'Candara',
  'Comic Sans MS', 'Consolas', 'Constantia', 'Corbel', 'Courier', 'Courier New', 'Ebrima',
  'Franklin Gothic Medium', 'Gabriola', 'Gadugi', 'Georgia', 'Impact', 'Javanese Text',
  'Leelawadee UI', 'Lucida Console', 'Lucida Sans Unicode', 'Malgun Gothic', 'Microsoft Himalaya',
  'Microsoft JhengHei', 'Microsoft New Tai Lue', 'Microsoft PhagsPa', 'Microsoft Sans Serif',
  'Microsoft Tai Le', 'Microsoft YaHei', 'Microsoft Yi Baiti', 'MingLiU-ExtB', 'Mongolian Baiti',
  'MS Gothic', 'MV Boli', 'Myanmar Text', 'Nirmala UI', 'Palatino Linotype', 'Segoe MDL2 Assets',
  'Segoe Print', 'Segoe Script', 'Segoe UI', 'Segoe UI Emoji', 'Segoe UI Historic',
  'Segoe UI Symbol', 'SimSun', 'Sitka', 'Sylfaen', 'Symbol', 'Tahoma', 'Times New Roman',
  'Trebuchet MS', 'Verdana', 'Webdings', 'Wingdings', 'Yu Gothic',
];

export interface StealthProfile {
  ua: string;
  major: string;
  platform: string;
  os: string;
  cores: number;
  memory: number;
  gpu: { vendor: string; renderer: string };
  timezone: string;
  locale: string;
  // Per-session noise seeds — make every visitor_id unique
  canvasNoise: number;
  audioNoise: number;
  webglNoise: number;
  fonts: string[];
}

export function pickProfile(): StealthProfile {
  const u = UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
  const h = HARDWARE_PROFILES[Math.floor(Math.random() * HARDWARE_PROFILES.length)];
  const gpu = GPU_WIN[Math.floor(Math.random() * GPU_WIN.length)];
  return {
    ...u,
    cores: h.cores,
    memory: h.memory,
    gpu,
    timezone: 'Australia/Melbourne',
    locale: 'en-AU',
    canvasNoise: Math.random() * 0.0001,
    audioNoise: (Math.random() - 0.5) * 0.0001,
    webglNoise: Math.random() * 0.001,
    fonts: WINDOWS_FONTS,
  };
}

export async function applyStealth(page: Page, profile: StealthProfile = pickProfile()): Promise<StealthProfile> {
  // ── CDP-level UA + headers (must match JS-level navigator.userAgent exactly) ──
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-AU,en-US;q=0.9,en;q=0.8',
    'Sec-CH-UA': `"Google Chrome";v="${profile.major}", "Chromium";v="${profile.major}", "Not.A/Brand";v="24"`,
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': profile.platform,
    'Sec-CH-UA-Platform-Version': '"15.0.0"',
    'Sec-CH-UA-Arch': '"x86"',
    'Sec-CH-UA-Bitness': '"64"',
    'Sec-CH-UA-Full-Version': `"${profile.major}.0.6478.127"`,
    'Sec-CH-UA-Model': '""',
    'Upgrade-Insecure-Requests': '1',
  });
  // CDP-level UA override so the HTTP UA matches the JS UA (otherwise it's a tell)
  try {
    const client = await page.context().newCDPSession(page);
    await client.send('Network.setUserAgentOverride', {
      userAgent: profile.ua,
      acceptLanguage: 'en-AU,en-US;q=0.9,en;q=0.8',
      platform: profile.os === 'win' ? 'Win32' : 'MacIntel',
      userAgentMetadata: {
        brands: [
          { brand: 'Google Chrome', version: profile.major },
          { brand: 'Chromium', version: profile.major },
          { brand: 'Not.A/Brand', version: '24' },
        ],
        fullVersion: `${profile.major}.0.0.0`,
        platform: profile.os === 'win' ? 'Windows' : 'macOS',
        platformVersion: '15.0.0',
        architecture: 'x86',
        bitness: '64',
        wow64: false,
        model: '',
        mobile: false,
      } as any,
    });
  } catch { /* CDP UA override unavailable on some setups */ }

  // Block lightweight telemetry only — keep WebRTC, mediaDevices, service workers intact for realism
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (/google-analytics\.com|datadoghq-browser-agent|sentry\.io|facebook\.net/i.test(url)) {
      route.abort();
    } else {
      route.continue();
    }
  });

  // ── In-page evasions injected before any document JS runs ──
  // The spoof body is defined as a string so we can reuse it inside Worker contexts
  // (where addInitScript does NOT reach — this is the source of the hardware_concurrency: 2 leak).
  const spoofBody = buildSpoofBody();
  await page.addInitScript(
    ({ p, body }) => {
      // 1. Run the shared spoof body in the main frame.
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      new Function('p', body)(p);

      // 2. Patch Worker / SharedWorker so the same spoof body runs in worker contexts.
      //    FingerprintJS Pro reads hardwareConcurrency, deviceMemory, and WebGL params
      //    from a Worker — without this, those values leak through as the raw VM truth.
      // Build a NEW blob URL that runs our spoof body, then importScripts() the
      // original URL. importScripts() works for both http(s):// AND blob:// URLs
      // when same-origin / same-document — which covers FP's detection worker
      // (FP itself constructs `new Worker(URL.createObjectURL(blob))`).
      const buildWorkerBlobURL = (origURL: string) => {
        const prelude = '(function(p){' + body + '})(' + JSON.stringify(p) + ');\n';
        const importer = 'importScripts(' + JSON.stringify(origURL) + ');';
        const blob = new Blob([prelude + importer], { type: 'application/javascript' });
        return URL.createObjectURL(blob);
      };
      // Use Proxy with `construct` trap — less detectable than a function wrapper,
      // and Function.prototype.toString on a Proxy returns the original native string.
      const wrapCtor = (Ctor: any) => {
        if (!Ctor) return Ctor;
        return new Proxy(Ctor, {
          construct(target, args) {
            try {
              const u = args[0];
              const opts = args[1] || {};
              // Module workers can't use importScripts — skip wrapping (rare path).
              if (opts && opts.type === 'module') {
                return Reflect.construct(target, args);
              }
              if (u && typeof u === 'string') {
                // Wrap http(s):// AND blob:// — FP creates worker via blob URL.
                const abs = u.startsWith('blob:') ? u : new URL(u, location.href).href;
                args[0] = buildWorkerBlobURL(abs);
              } else if (u && typeof URL !== 'undefined' && u instanceof URL) {
                args[0] = buildWorkerBlobURL(u.href);
              }
            } catch (e) { /* fall through with original args */ }
            return Reflect.construct(target, args);
          },
        });
      };
      try { (window as any).Worker = wrapCtor((window as any).Worker); } catch (e) { /**/ }
      try { (window as any).SharedWorker = wrapCtor((window as any).SharedWorker); } catch (e) { /**/ }

      // Worklets (AudioWorklet, PaintWorklet, etc) spawn worker-like threads
      // via `worklet.addModule(url)` — bypassing `new Worker()`. Wrap addModule
      // on every Worklet prototype so the same spoof prelude lands in worklet scope.
      const wrapWorkletAddModule = (proto: any) => {
        if (!proto || !proto.addModule) return;
        const orig = proto.addModule;
        proto.addModule = function (url: any, opts: any) {
          try {
            const abs = (typeof url === 'string')
              ? (url.startsWith('blob:') ? url : new URL(url, location.href).href)
              : (url && url.href) || url;
            if (typeof abs === 'string') {
              return orig.call(this, buildWorkerBlobURL(abs), opts);
            }
          } catch (e) { /* fall through */ }
          return orig.call(this, url, opts);
        };
      };
      try { wrapWorkletAddModule((window as any).Worklet?.prototype); } catch (e) { /**/ }
      try { wrapWorkletAddModule((window as any).AudioWorklet?.prototype); } catch (e) { /**/ }
      try { wrapWorkletAddModule((window as any).PaintWorklet?.prototype); } catch (e) { /**/ }
      try { wrapWorkletAddModule((window as any).AnimationWorklet?.prototype); } catch (e) { /**/ }
      try { wrapWorkletAddModule((window as any).LayoutWorklet?.prototype); } catch (e) { /**/ }

      // Also intercept ServiceWorker.register — FP could use SW for fingerprinting in theory.
      try {
        if ((navigator as any).serviceWorker?.register) {
          const swProto = Object.getPrototypeOf((navigator as any).serviceWorker);
          const origReg = swProto.register;
          swProto.register = function (url: any, opts: any) {
            return origReg.call(this, url, opts);
          };
        }
      } catch (e) { /**/ }

      // 3. Main-frame-only extras (screen / fonts / battery / connection / Notification).
      const NavProto = Object.getPrototypeOf(navigator);
      const def = (proto: any, name: string, getter: () => any) => {
        try { Object.defineProperty(proto, name, { get: getter, configurable: true, enumerable: true }); } catch (e) { /**/ }
      };
      // Screen — realistic 1920x1080 with a Windows taskbar.
      def(Object.getPrototypeOf(screen), 'availWidth', () => 1920);
      def(Object.getPrototypeOf(screen), 'availHeight', () => 1040);
      def(Object.getPrototypeOf(screen), 'width', () => 1920);
      def(Object.getPrototypeOf(screen), 'height', () => 1080);
      def(Object.getPrototypeOf(screen), 'colorDepth', () => 24);
      def(Object.getPrototypeOf(screen), 'pixelDepth', () => 24);

      // Battery API — present on real Chrome, absent on most headless setups.
      if (!(navigator as any).getBattery) {
        (navigator as any).getBattery = () => Promise.resolve({
          charging: true, chargingTime: 0, dischargingTime: Infinity, level: 0.87,
          addEventListener: () => { }, removeEventListener: () => { },
        });
      }
      // Connection — realistic broadband.
      try {
        def(NavProto, 'connection', () => ({ effectiveType: '4g', rtt: 50, downlink: 10, saveData: false }));
      } catch (e) { /**/ }
      // Notification.permission — consistent.
      try { def((window as any).Notification, 'permission', () => 'default'); } catch (e) { /**/ }

      // 4. Font enumeration — FontFace.check / measureText path that FP uses.
      //    Patch CanvasRenderingContext2D.measureText so synthetic-font detection
      //    returns the expected widths for the Windows font set.
      try {
        const origMeasure = CanvasRenderingContext2D.prototype.measureText;
        const knownFonts = new Set<string>(p.fonts.map((f) => f.toLowerCase()));
        CanvasRenderingContext2D.prototype.measureText = function (text: string) {
          const m = origMeasure.call(this, text);
          // If the requested font is in our Windows list, perturb width slightly so the
          // "font installed?" check (which compares against fallback) succeeds.
          try {
            const fontFamily = (this.font.match(/['"]?([^'",]+)['"]?\s*$/) || [])[1] || '';
            if (fontFamily && knownFonts.has(fontFamily.toLowerCase())) {
              const noise = (p.canvasNoise * 1000) % 0.5;
              Object.defineProperty(m, 'width', { value: m.width + noise + 0.1, configurable: true });
            }
          } catch (e) { /**/ }
          return m;
        };
      } catch (e) { /**/ }
    },
    { p: profile, body: spoofBody }
  );

  return profile;
}

/**
 * Returns a self-contained JS function body (string) that installs every
 * spoof on whatever global it's called in (window OR self/WorkerGlobalScope).
 * The same body is injected into the page via addInitScript AND wrapped into
 * a Blob prelude that runs before each Worker's actual script.
 */
function buildSpoofBody(): string {
  return `
  const g = (typeof window !== 'undefined') ? window : self;
  const isWorker = typeof window === 'undefined';
  const nav = g.navigator;
  const NavProto = Object.getPrototypeOf(nav);

  // Helper: define on PROTOTYPE (matches real Chrome) instead of instance.
  // Defining on the instance leaves an own-descriptor that anti_detect_browser ML flags.
  const defProto = (proto, name, getter) => {
    try {
      Object.defineProperty(proto, name, { get: getter, configurable: true, enumerable: true });
    } catch (e) { /**/ }
  };
  // Track patches so Function.prototype.toString can mask them as native.
  const PATCHED = new WeakSet();
  const mark = (fn) => { try { PATCHED.add(fn); } catch (e) {} return fn; };

  // 1. webdriver — must be FALSE on the prototype (not undefined; not on instance).
  try { delete NavProto.webdriver; } catch (e) {}
  defProto(NavProto, 'webdriver', mark(function () { return false; }));

  // 2. Hardware metrics on prototype — same in main + worker contexts.
  defProto(NavProto, 'hardwareConcurrency', mark(function () { return p.cores; }));
  defProto(NavProto, 'deviceMemory', mark(function () { return p.memory; }));
  defProto(NavProto, 'maxTouchPoints', mark(function () { return 0; }));

  // 3. Languages + locale (consistent en-AU; fixes date_time_locale mismatch).
  defProto(NavProto, 'language', mark(function () { return 'en-AU'; }));
  defProto(NavProto, 'languages', mark(function () { return ['en-AU', 'en-US', 'en']; }));

  // 3a. Intl.DateTimeFormat — FP reads resolvedOptions().locale for date_time_locale signal.
  //     If absent, it reads the host locale (en-US on Browserbase) creating a tell.
  if (g.Intl && g.Intl.DateTimeFormat) {
    const OrigDTF = g.Intl.DateTimeFormat;
    g.Intl.DateTimeFormat = mark(function (locales, options) {
      // If caller passes no locale, force en-AU so resolvedOptions().locale matches navigator.language.
      const usedLocales = (locales == null) ? 'en-AU' : locales;
      const inst = new OrigDTF(usedLocales, options);
      const origResolved = inst.resolvedOptions.bind(inst);
      inst.resolvedOptions = mark(function () {
        const r = origResolved();
        if (locales == null) r.locale = 'en-AU';
        if (!r.timeZone || r.timeZone === 'UTC') r.timeZone = 'Australia/Melbourne';
        return r;
      });
      return inst;
    });
    // Preserve static/prototype properties so instanceof + Intl.DateTimeFormat.supportedLocalesOf still work.
    g.Intl.DateTimeFormat.prototype = OrigDTF.prototype;
    g.Intl.DateTimeFormat.supportedLocalesOf = OrigDTF.supportedLocalesOf.bind(OrigDTF);
  }

  // 4. WebGL vendor/renderer in BOTH main + worker (FP reads this in workers via OffscreenCanvas).
  const patchGL = (Proto) => {
    if (!Proto || !Proto.prototype) return;
    const orig = Proto.prototype.getParameter;
    if (!orig) return;
    Proto.prototype.getParameter = mark(function (param) {
      if (param === 37445) return p.gpu.vendor;       // UNMASKED_VENDOR_WEBGL
      if (param === 37446) return p.gpu.renderer;     // UNMASKED_RENDERER_WEBGL
      // Tiny per-session noise on a few numeric params so webgl_basics hash varies.
      const r = orig.call(this, param);
      if (typeof r === 'number' && (param === 3379 || param === 34076 || param === 36347)) {
        return r; // Don't perturb size/limit params — that breaks rendering checks.
      }
      return r;
    });
  };
  patchGL(g.WebGLRenderingContext);
  patchGL(g.WebGL2RenderingContext);

  // 5. Canvas — patch the LOW-LEVEL pixel reads (getImageData) so any consumer
  //    of canvas pixels — including FP's worker-side OffscreenCanvas hash —
  //    sees session-unique noise. Patching only toDataURL leaves getImageData
  //    callers reading the same pixels => same hash across sessions.
  const seed = Math.floor(Math.abs(p.canvasNoise) * 0xffffffff) | 0;
  // Tiny LCG so noise is deterministic-per-session but varied across pixels.
  let _s = seed || 1;
  const rng = () => { _s = (_s * 1664525 + 1013904223) | 0; return ((_s >>> 0) % 256); };
  const noisePixels = (data) => {
    if (!data || !data.length) return;
    // Reseed per-call so the same canvas read returns the same bytes (deterministic),
    // but session-unique because the seed is unique.
    _s = seed || 1;
    // Perturb just one channel of every Nth pixel by ±1 — invisible visually,
    // changes the SHA hash totally.
    for (let i = 0; i < data.length; i += 47 * 4) {
      data[i] = (data[i] + (rng() & 1)) & 0xff;
    }
  };
  const patchImageDataFor = (Proto2D) => {
    if (!Proto2D || !Proto2D.prototype) return;
    const orig = Proto2D.prototype.getImageData;
    if (!orig) return;
    Proto2D.prototype.getImageData = mark(function () {
      const img = orig.apply(this, arguments);
      try { noisePixels(img.data); } catch (e) {}
      return img;
    });
  };
  patchImageDataFor(g.CanvasRenderingContext2D);
  patchImageDataFor(g.OffscreenCanvasRenderingContext2D);

  // FingerprintJS Pro hashes canvas via toDataURL of the rendered canvas. We mutate
  // the canvas just before serialization with a session-unique pixel so the hash
  // changes per session but is stable within a session.
  const stampCanvas = (canvas) => {
    try {
      const ctx = canvas.getContext('2d'); if (!ctx) return;
      const w = canvas.width, h = canvas.height;
      const px = (Math.abs(seed) * 7919) % Math.max(1, w);
      const py = (Math.abs(seed) * 6151) % Math.max(1, h);
      ctx.fillStyle = 'rgba(' + (seed & 0xff) + ',' + ((seed >> 8) & 0xff) + ',' + ((seed >> 16) & 0xff) + ',0.0039)';
      ctx.fillRect(px, py, 1, 1);
    } catch (e) {}
  };
  if (g.HTMLCanvasElement) {
    const orig = g.HTMLCanvasElement.prototype.toDataURL;
    g.HTMLCanvasElement.prototype.toDataURL = mark(function () {
      stampCanvas(this);
      return orig.apply(this, arguments);
    });
    if (g.HTMLCanvasElement.prototype.toBlob) {
      const origToBlob = g.HTMLCanvasElement.prototype.toBlob;
      g.HTMLCanvasElement.prototype.toBlob = mark(function () {
        stampCanvas(this);
        return origToBlob.apply(this, arguments);
      });
    }
  }
  if (g.OffscreenCanvas) {
    if (g.OffscreenCanvas.prototype.convertToBlob) {
      const origConv = g.OffscreenCanvas.prototype.convertToBlob;
      g.OffscreenCanvas.prototype.convertToBlob = mark(function () {
        stampCanvas(this);
        return origConv.apply(this, arguments);
      });
    }
    if (g.OffscreenCanvas.prototype.transferToImageBitmap) {
      const origXfer = g.OffscreenCanvas.prototype.transferToImageBitmap;
      g.OffscreenCanvas.prototype.transferToImageBitmap = mark(function () {
        stampCanvas(this);
        return origXfer.apply(this, arguments);
      });
    }
  }

  // 6. Audio — FP uses OfflineAudioContext.startRendering and sums the LAST
  //    samples (e.g. indices [4500..5000]) of the rendered buffer. Sparse noise
  //    misses that window entirely. We apply DENSE per-sample noise (~1e-7) so
  //    the sum over ANY window changes by a session-unique amount. We track
  //    buffers in a WeakSet so noise is applied exactly once per buffer (avoids
  //    double-application across getChannelData/startRendering paths).
  const NOISED = new WeakSet();
  const audioBase = p.audioNoise * 1e-3; // base perturbation magnitude
  const noiseAudioBuffer = (buf) => {
    if (!buf || NOISED.has(buf)) return;
    NOISED.add(buf);
    try {
      for (let ch = 0; ch < buf.numberOfChannels; ch++) {
        const d = buf.getChannelData(ch);
        // Per-sample tiny perturbation; deterministic per session via audioBase + index pattern.
        for (let i = 0; i < d.length; i++) {
          d[i] = d[i] + audioBase * (1 + (i & 0x7) * 0.13);
        }
      }
    } catch (e) {}
  };
  if (g.AudioBuffer) {
    const orig = g.AudioBuffer.prototype.getChannelData;
    g.AudioBuffer.prototype.getChannelData = mark(function (ch) {
      noiseAudioBuffer(this);
      return orig.call(this, ch);
    });
    if (g.AudioBuffer.prototype.copyFromChannel) {
      const origCopy = g.AudioBuffer.prototype.copyFromChannel;
      g.AudioBuffer.prototype.copyFromChannel = mark(function (dest, ch, off) {
        noiseAudioBuffer(this);
        origCopy.call(this, dest, ch, off || 0);
      });
    }
  }
  if (g.OfflineAudioContext) {
    const origStart = g.OfflineAudioContext.prototype.startRendering;
    g.OfflineAudioContext.prototype.startRendering = mark(function () {
      const promise = origStart.apply(this, arguments);
      return promise.then((buf) => { noiseAudioBuffer(buf); return buf; });
    });
  }
  // AnalyserNode — frequency-domain fingerprinting (Float/Byte Frequency/TimeDomain).
  if (g.AnalyserNode) {
    const noiseFloat = (arr) => {
      if (!arr || !arr.length) return;
      for (let i = 0; i < arr.length; i += 13) arr[i] = arr[i] + p.audioNoise * (1 + (i % 5));
    };
    const noiseByte = (arr) => {
      if (!arr || !arr.length) return;
      const off = (Math.abs(seed) & 0x3) ? 1 : -1;
      for (let i = 0; i < arr.length; i += 13) arr[i] = (arr[i] + off) & 0xff;
    };
    const proto = g.AnalyserNode.prototype;
    if (proto.getFloatFrequencyData) {
      const o = proto.getFloatFrequencyData;
      proto.getFloatFrequencyData = mark(function (a) { o.call(this, a); noiseFloat(a); });
    }
    if (proto.getByteFrequencyData) {
      const o = proto.getByteFrequencyData;
      proto.getByteFrequencyData = mark(function (a) { o.call(this, a); noiseByte(a); });
    }
    if (proto.getFloatTimeDomainData) {
      const o = proto.getFloatTimeDomainData;
      proto.getFloatTimeDomainData = mark(function (a) { o.call(this, a); noiseFloat(a); });
    }
    if (proto.getByteTimeDomainData) {
      const o = proto.getByteTimeDomainData;
      proto.getByteTimeDomainData = mark(function (a) { o.call(this, a); noiseByte(a); });
    }
  }

  // 7. Function.prototype.toString — INTENTIONALLY NOT PATCHED for browserbase.
  //    Patching toString itself is the dominant anti_detect_browser ML signal:
  //    Function.prototype.toString.toString() would no longer return native
  //    code, and FP fingerprints the toString of toString. We accept that
  //    individual patched accessors return their JS source instead of
  //    [native code] — a smaller, less-weighted tell — in exchange for
  //    keeping Function.prototype.toString itself genuinely native.
  //    PATCHED / mark() are kept as no-ops to avoid touching every callsite.

  if (isWorker) return; // Below is main-frame-only

  // 8. Plugins — real Chrome PluginArray with internal-pdf-viewer entries.
  const mkPlugin = (name) => ({ name, filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 });
  const plugins = [mkPlugin('PDF Viewer'), mkPlugin('Chrome PDF Viewer'), mkPlugin('Chromium PDF Viewer'), mkPlugin('Microsoft Edge PDF Viewer'), mkPlugin('WebKit built-in PDF')];
  defProto(NavProto, 'plugins', mark(function () { return plugins; }));
  defProto(NavProto, 'mimeTypes', mark(function () { return [{ type: 'application/pdf', suffixes: 'pdf' }]; }));

  // 9. chrome runtime stub — looks like real Chrome.
  if (!g.chrome) g.chrome = {
    runtime: { OnInstalledReason: {}, OnRestartRequiredReason: {}, PlatformArch: {}, PlatformOs: {} },
    loadTimes: function () { return { requestTime: Date.now() / 1000 }; },
    csi: function () { return { onloadT: Date.now(), startE: Date.now(), tran: 15 }; },
    app: { isInstalled: false },
  };

  // 10. Permissions.query — keep original semantics, only override notifications prompt.
  try {
    const origQ = nav.permissions.query.bind(nav.permissions);
    nav.permissions.query = mark(function (params) {
      if (params && params.name === 'notifications') {
        return Promise.resolve({ state: 'prompt', name: 'notifications', onchange: null });
      }
      return origQ(params);
    });
  } catch (e) {}
  `;
}

