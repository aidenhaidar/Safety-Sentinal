/** G.711 mu-law -> float PCM. Phones send 8-bit mu-law at 16 kHz to fit API Gateway's 32 KB WebSocket frame limit. */
export function decodeMulaw(bytes: Uint8Array): Float32Array {
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const u = ~bytes[i] & 0xff;
    const sign = u & 0x80, exp = (u >> 4) & 7, man = u & 0x0f;
    const mag = (((man << 3) + 0x84) << exp) - 0x84;
    out[i] = (sign ? -mag : mag) / 32768;
  }
  return out;
}
export function encodeMulaw(pcm: Float32Array): Uint8Array {
  const out = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    let s = Math.max(-1, Math.min(1, pcm[i])) * 32767;
    const sign = s < 0 ? 0x80 : 0; if (s < 0) s = -s;
    s = Math.min(s + 0x84, 32767);
    let exp = 7; for (let m = 0x4000; (s & m) === 0 && exp > 0; m >>= 1) exp--;
    out[i] = ~(sign | (exp << 4) | ((s >> (exp + 3)) & 0x0f)) & 0xff;
  }
  return out;
}
const db = (x: number) => 20 * Math.log10(Math.max(x, 1e-6));
export function levels(pcm: Float32Array) {
  let peak = 0, sum = 0;
  for (const v of pcm) { const a = Math.abs(v); if (a > peak) peak = a; sum += v * v; }
  const rms = Math.sqrt(sum / Math.max(1, pcm.length));
  return { peakDb: db(peak), rmsDb: db(rms), crest: peak / Math.max(rms, 1e-6) };
}
