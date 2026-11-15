// Runs while CDK bundles the analyzer Lambda: keeps only the Linux x64 CPU build of ONNX Runtime
// and copies the audio model next to the handler.
import { copyFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const [repo, out] = process.argv.slice(2);
const model = join(repo, 'models', 'yamnet.onnx');
if (!existsSync(model)) { console.error('models/yamnet.onnx is missing. Run: node scripts/fetch-model.mjs'); process.exit(1); }
copyFileSync(model, join(out, 'yamnet.onnx'));

const bin = join(out, 'node_modules', 'onnxruntime-node', 'bin');
for (const napi of existsSync(bin) ? readdirSync(bin) : []) {
  const dir = join(bin, napi);
  if (!statSync(dir).isDirectory()) continue;
  for (const os of readdirSync(dir)) {
    if (os !== 'linux') { rmSync(join(dir, os), { recursive: true, force: true }); continue; }
    for (const arch of readdirSync(join(dir, os))) {
      if (arch !== 'x64') { rmSync(join(dir, os, arch), { recursive: true, force: true }); continue; }
      for (const f of readdirSync(join(dir, os, arch))) if (/cuda|tensorrt/i.test(f)) rmSync(join(dir, os, arch, f), { force: true });
    }
  }
}
