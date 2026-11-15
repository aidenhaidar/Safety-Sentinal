// Phone sensor node: captures camera frames and microphone clips and streams them to AWS.
const $ = (id) => document.getElementById(id);
const SR = 16000;            // sample rate the audio classifier expects
const CLIP = 20800;          // 1.3 s clip; as 8-bit mu-law + base64 it stays under API Gateway's 32 KB frame limit
const HOP = 15600;           // a new clip every 0.975 s (clips overlap so a bang on the boundary is not split)
const MAX_FRAME_B64 = 28000; // same 32 KB limit for camera frames

const params = new URLSearchParams(location.search);
let nodeId = store('sentinel-node-id');
if (!nodeId) nodeId = store('sentinel-node-id', (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)));
$('name').value = store('sentinel-node-name') || '';
$('code').value = params.get('code') || '';
if (CONFIG.joinCodeRequired && !params.get('code')) $('codeRow').hidden = false;

let ws, media, audioCtx, frameTimer, wakeLock, capture = { frameMs: 3000, frameMsHeightened: 1000 }, heightenedUntil = 0;
const sent = { frames: 0, clips: 0 };

$('joinForm').onsubmit = async (e) => {
  e.preventDefault(); $('err').textContent = '';
  try { await start(); } catch (err) { $('err').textContent = explain(err); stop(); }
};
$('stop').onclick = () => { stop(); $('live').hidden = true; $('setup').hidden = false; };

function explain(err) {
  if (!navigator.mediaDevices) return 'This browser cannot access the camera or microphone here. Open the page over https.';
  if (err.name === 'NotAllowedError') return 'Camera and microphone access was blocked. Allow it in the browser settings for this site and try again.';
  if (err.name === 'NotFoundError') return 'No camera or microphone was found on this device.';
  return `Could not start: ${err.message}`;
}

async function start() {
  // Phone noise suppression and auto gain are built for speech and would erase a gunshot, so turn them off.
  const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
  const video = { facingMode: { ideal: 'environment' }, width: { ideal: 640 }, height: { ideal: 480 } };
  try { media = await navigator.mediaDevices.getUserMedia({ audio, video }); }
  catch (err) {
    if (err.name === 'NotAllowedError') throw err;
    media = await navigator.mediaDevices.getUserMedia({ audio }); // no usable camera: run as an audio-only node
  }
  store('sentinel-node-name', $('name').value);
  $('setup').hidden = true; $('live').hidden = false;
  $('who').textContent = `${$('name').value} · ${$('zone').value}`;
  if (media.getVideoTracks().length) { $('video').srcObject = media; await $('video').play().catch(() => {}); } else $('video').hidden = true;
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }

  ws = connect({
    hello: () => ({ action: 'hello', role: 'node', nodeId, name: $('name').value, zone: $('zone').value, tier: $('tier').value, code: $('code').value }),
    onStatus(on) { if (!on) $('stats').textContent = 'Reconnecting…'; },
    onMessage: onServer,
  });
  startAudio();
  scheduleFrame(500);
}

function stop() {
  clearTimeout(frameTimer); ws?.close(); ws = undefined;
  media?.getTracks().forEach((t) => t.stop()); media = undefined;
  audioCtx?.close().catch(() => {}); audioCtx = undefined;
  wakeLock?.release().catch(() => {}); wakeLock = undefined;
}

function onServer(m) {
  if (m.type === 'welcome') { capture = m.capture; show(m.node); }
  else if (m.type === 'assessment' && m.node.nodeId === nodeId) show(m.node);
  else if (m.type === 'directive') {
    heightenedUntil = Date.now() + m.ms;
    $('directive').hidden = false; $('directive').textContent = `Heightened watch: ${m.reason}. Sending video faster.`;
    setTimeout(() => { if (Date.now() >= heightenedUntil) $('directive').hidden = true; }, m.ms + 100);
    scheduleFrame(0);
  } else if (m.type === 'error') { $('err').textContent = m.message; stop(); $('live').hidden = true; $('setup').hidden = false; if (m.code === 'bad_code') $('codeRow').hidden = false; }
}

function show(node) {
  $('banner').className = `banner ${node.level}`;
  $('lvl').textContent = node.drill ? `DRILL · ${node.level}` : node.level;
  $('score').textContent = `Danger ${pct(node.score)}`;
  $('ops').replaceChildren(...node.opinions.filter((o) => o.score >= 0.1).map((o) => h('div', { class: 'dim', style: 'font-size:13px;margin-top:4px' }, h('strong', { style: 'color:var(--text)' }, `${o.agent} ${pct(o.score)} `), o.rationale)));
}

// ---- Camera: one small JPEG every few seconds (faster on heightened watch) ----
const canvas = document.createElement('canvas');
function scheduleFrame(ms) { clearTimeout(frameTimer); frameTimer = setTimeout(sendFrame, ms); }
function sendFrame() {
  const v = $('video');
  const next = Date.now() < heightenedUntil ? capture.frameMsHeightened : capture.frameMs;
  if (ws && v.videoWidth && ws.buffered() < 64000) {
    let width = 480, jpeg = '';
    for (const q of [0.6, 0.45, 0.3, 0.3]) {
      canvas.width = width; canvas.height = Math.round(width * v.videoHeight / v.videoWidth);
      canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height);
      jpeg = canvas.toDataURL('image/jpeg', q).split(',')[1];
      if (jpeg.length <= MAX_FRAME_B64) break;
      if (q === 0.3) width = 360;
    }
    if (jpeg.length <= MAX_FRAME_B64 && ws.send({ action: 'frame', jpeg })) sent.frames++;
  }
  if (media) scheduleFrame(next);
  stats();
}

// ---- Microphone: resample to 16 kHz, cut overlapping clips, skip silence, send as mu-law ----
function startAudio() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  audioCtx.resume();
  const src = audioCtx.createMediaStreamSource(media);
  const proc = audioCtx.createScriptProcessor(4096, 1, 1);
  const mute = audioCtx.createGain(); mute.gain.value = 0;
  src.connect(proc); proc.connect(mute); mute.connect(audioCtx.destination);
  const ring = new Float32Array(CLIP); let fresh = 0, pos = 0, last = 0;
  const step = audioCtx.sampleRate / SR;
  proc.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    // Linear-interpolation resampler; `pos` carries the fractional read position between callbacks.
    while (pos < input.length) {
      const i = Math.floor(pos), a = i > 0 ? input[i - 1] : last, b = input[i];
      ring.copyWithin(0, 1); ring[CLIP - 1] = a + (b - a) * (pos - i); fresh++;
      pos += step;
    }
    pos -= input.length; last = input[input.length - 1];
    if (fresh >= HOP) { fresh = 0; sendClip(ring); }
  };
}

function sendClip(pcm) {
  let peak = 0, sum = 0;
  for (let i = 0; i < pcm.length; i++) { const a = Math.abs(pcm[i]); if (a > peak) peak = a; sum += pcm[i] * pcm[i]; }
  const peakDb = 20 * Math.log10(Math.max(peak, 1e-6)), rmsDb = 10 * Math.log10(Math.max(sum / pcm.length, 1e-12));
  $('meter').style.width = `${Math.max(0, Math.min(100, (peakDb + 60) / 60 * 100))}%`;
  if (!ws || (peakDb < -32 && rmsDb < -50) || ws.buffered() > 64000) return; // quiet room: nothing worth classifying
  const bytes = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) bytes[i] = mulaw(pcm[i]);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  if (ws.send({ action: 'audio', mulaw: btoa(bin) })) sent.clips++;
  stats();
}

function mulaw(x) {
  let s = Math.max(-1, Math.min(1, x)) * 32767;
  const sign = s < 0 ? 0x80 : 0; if (s < 0) s = -s;
  s = Math.min(s + 0x84, 32767);
  let exp = 7; for (let m = 0x4000; (s & m) === 0 && exp > 0; m >>= 1) exp--;
  return ~(sign | (exp << 4) | ((s >> (exp + 3)) & 0x0f)) & 0xff;
}

function stats() { $('stats').textContent = `Streaming · ${sent.frames} frames and ${sent.clips} audio clips sent`; }
document.addEventListener('visibilitychange', async () => { if (!document.hidden && media && !wakeLock) { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {} } });
