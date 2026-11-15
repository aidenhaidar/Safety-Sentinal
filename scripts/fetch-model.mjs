// Downloads the YAMNet audio-event classifier (ONNX, Apache-2.0) used by the analyzer Lambda
// and the local dev server. Pinned by SHA-256 so a changed upstream file is rejected.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const URL_ = 'https://huggingface.co/zeropointnine/yamnet-onnx/resolve/main/yamnet.onnx';
const SHA256 = '1510041dce24a2e9e84ec546807ac408ae496da6d1ed41bc3ccba649623f8e19';
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'models', 'yamnet.onnx');
const sha = (b) => createHash('sha256').update(b).digest('hex');

if (existsSync(out) && sha(readFileSync(out)) === SHA256) process.exit(0);
try {
  console.log('[fetch-model] downloading YAMNet (16 MB)…');
  const res = await fetch(URL_);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha(buf) !== SHA256) throw new Error('checksum mismatch');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, buf);
  console.log('[fetch-model] saved', out);
} catch (e) {
  // Do not fail `npm install`; the deploy and dev server check for the file and explain.
  console.warn(`[fetch-model] could not download model (${e.message}). Re-run: node scripts/fetch-model.mjs`);
}
